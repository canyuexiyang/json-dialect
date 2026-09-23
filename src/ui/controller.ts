/**
 * 弹窗与放大页共用的应用控制器
 *
 * 关键约束：
 *  - AC-39：复制/下载内容必须取自 IR 序列化结果（state.output），绝不取编辑器 DOM
 *  - FR-G1：输入变更 200ms 防抖
 *  - FR-G2/G3/G4：三档性能降级
 *  - FR-D4/D5：修正提示条可展开，逐条列出「行号 + 片段 + 动作」
 *  - FR-D7：失败态保留旧输出但置灰 + 禁用复制/下载
 *  - FR-D10：失败且未锁定格式时，给出一键切换建议
 */

import { convert, computeStats, type ConvertResult } from '../core/index.js';
import type { OutputLang, SourceFormat, TargetFormat } from '../core/types.js';
import {
  escapeText,
  ALL_ESCAPE_STYLES,
  ESCAPE_LABEL,
  ESCAPE_DIR_LABEL,
  oppositeDir,
  type EscapeStyle,
  type EscapeDir,
} from '../core/escapeText.js';
import { suggestFormats, type FormatSuggestion } from '../core/suggestFormat.js';
import { createEditor, type EditorHandle } from './editor.js';
import { copyText, selectAllIn } from './clipboard.js';
import { downloadText, downloadLabel } from './download.js';
import { loadPrefs, savePrefs, writeSession, type Prefs } from './sessionState.js';
import { createTypePanel, isOverrideType, type OverrideType } from './typeWidgets.js';
import { decorateSelect, bindHiddenClose, type SelectHandle } from './select.js';

export interface DomRefs {
  fmtLabel: HTMLElement;
  lockBadge: HTMLElement;
  fmtSelect: HTMLSelectElement;
  resetAuto: HTMLButtonElement;
  enlarge?: HTMLButtonElement;
  /** 应用根节点（v1.2：通道导轨随 tab 换色） */
  root?: HTMLElement;
  /** 状态灯（v1.2） */
  statusLed?: HTMLElement;
  /** tab 条（FR-L1）：可选 —— 老测试挂载的无 tab DOM 也能跑 */
  tabFormat?: HTMLButtonElement;
  tabEscape?: HTMLButtonElement;
  tabConvert?: HTMLButtonElement;
  /** 目标格式选择器（FR-A17 / O-6） */
  targetSelect?: HTMLSelectElement;
  /** 转义风格选择器（FR-I2）—— 只在转义 tab 显示 */
  escapeStyleSelect?: HTMLSelectElement;
  /** 转义方向二选一（FR-I5）—— 只在转义 tab 显示，常驻可见 */
  escapeDirSeg?: HTMLElement;
  escapeDirDecode?: HTMLButtonElement;
  escapeDirEncode?: HTMLButtonElement;
  editorIn: HTMLElement;
  editorOut: HTMLElement;
  statsIn: HTMLElement;
  statsOut: HTMLElement;
  staleBadge: HTMLElement;
  fixbar: HTMLElement;
  typePanel: HTMLElement;
  statusMsg: HTMLElement;
  btnConvert: HTMLButtonElement;
  btnFormat: HTMLButtonElement;
  btnCompact: HTMLButtonElement;
  btnCopy: HTMLButtonElement;
  btnDownload: HTMLButtonElement;
  splitter?: HTMLElement;
}

/** 性能三档阈值（FR-G2/G3/G4） */
const T1 = 100_000;
const T2 = 500_000;

/** 修正 > 5 处时视觉强调（M2-1） */
const FIX_WARN_THRESHOLD = 5;

/** 三个功能 tab（FR-L1：顺序固定 ① 格式化 · ② 转义 · ③ 转换） */
export type TabId = 'format' | 'escape' | 'convert';

const TAB_ORDER: TabId[] = ['format', 'escape', 'convert'];

const TAB_TEXT: Record<TabId, string> = {
  format: '格式化',
  escape: '转义',
  convert: '转换',
};

/** 放大页从 session 继承的会话态（AC-33 / FR-F6） */
export interface InheritedState {
  source?: string;
  locked?: boolean;
  compact?: boolean;
  overrides?: Array<[string, string]>;
  /** O-9：tab / target / strict 需一并继承，否则放大后回到默认 tab */
  tab?: string;
  target?: string;
  strict?: boolean;
  escapeStyle?: string;
  escapeDir?: string;
}

const FORMAT_TEXT: Record<SourceFormat, string> = {
  json: '标准 JSON',
  python: 'Python 字面量',
  java: 'Java 转义字符串',
  map: 'Map.toString()',
};

export class AppController {
  private in!: EditorHandle;
  private out!: EditorHandle;
  private state: ConvertResult | null = null;
  private locked: SourceFormat | null = null;
  private compact = false;
  private timer: number | undefined;
  private lastGoodOutput = '';
  private lastGoodLang: OutputLang = 'json';
  private panel = createTypePanel();
  private dark = false;
  /** FR-L2：默认「格式化」（格式化是 v1.1 真实主路径） */
  private tab: TabId = 'format';
  /** FR-A17：目标格式，默认 auto（行为与 v1.0 一致） */
  private target: TargetFormat | 'auto' = 'auto';
  /** FR-K1：格式化 tab 默认严格档 */
  private strict = true;
  /** 转义 tab 状态 */
  private escapeStyle: EscapeStyle = 'json';
  private escapeDir: EscapeDir = 'encode';
  /** FR-D13：已由用户点击确认剥离的日志前缀（下次输入变化即失效） */
  private strippedPrefix = '';
  /** 转义 tab 的输出与错误（不走 ConvertResult） */
  private escapeOutput = '';
  private escapeError: string | undefined;
  /** v1.2：可造型下拉的装饰句柄（保留以便销毁/降级） */
  private selects: SelectHandle[] = [];
  /** v1.2：入场动画只跑一次，动画结束后摘掉 class，避免影响后续交互 */
  private booted = false;

  constructor(
    private dom: DomRefs,
    private opts: { isPage?: boolean } = {},
  ) {}

  /**
   * @param initialInput 初始输入（放大页由 session 继承）
   * @param inherited    从 session 继承的会话态：来源判定 / 显示模式 / 类型覆盖（AC-33）
   */
  /**
   * 初始化。
   *
   * 【关键约束：编辑器必须先于任何 await 创建】
   * 曾出过线上问题：`loadPrefs()` 排在 `createEditor()` 之前，一旦
   * chrome.storage 的 Promise 不 settle（企业策略禁用 storage / 权限未就绪 /
   * 扩展上下文失效），await 永不返回，init 整体卡死 —— 表现为
   * 「静态布局渲染出来了，但 CodeMirror 没挂载，输入区点不动、粘不进」。
   * 界面骨架是纯 HTML，所以看起来"像加载了"，误导性极强。
   *
   * 因此这里严格分两段：
   *   ① 同步段：建编辑器、绑事件、渲染首屏（绝不 await）
   *   ② 异步段：偏好读取迟到后再补齐，且自带超时兜底
   */
  async init(initialInput = '', inherited?: InheritedState): Promise<void> {
    this.dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    if (this.dark) document.body.classList.add('theme-dark');

    // ── ① 同步段：先把交互就绪，任何 await 都不得出现在这之前 ──────────────
    // 先用继承值/默认值，prefs 到位后再补（见 ②）
    if (inherited?.compact !== undefined) this.compact = inherited.compact;

    // O-9：tab / target / strict / 转义风格一并继承，否则放大后回到默认 tab
    if (inherited?.tab && isTabId(inherited.tab)) this.tab = inherited.tab;
    if (inherited?.target && isTargetOpt(inherited.target)) this.target = inherited.target;
    if (inherited?.strict !== undefined) this.strict = inherited.strict;
    if (inherited?.escapeStyle && isEscapeStyle(inherited.escapeStyle)) {
      this.escapeStyle = inherited.escapeStyle;
    }
    if (inherited?.escapeDir === 'encode' || inherited?.escapeDir === 'decode') {
      this.escapeDir = inherited.escapeDir;
    }

    // AC-33：来源判定与类型覆盖必须一并继承，否则放大页只是「文本一样但结果不同」
    if (inherited?.locked && inherited.source && isSourceFormat(inherited.source)) {
      this.setLocked(inherited.source);
    }
    if (inherited?.overrides?.length) {
      for (const [path, t] of inherited.overrides) {
        if (isOverrideType(t)) this.panel.setOverride(path, t);
      }
    }

    this.in = createEditor(this.dom.editorIn, {
      doc: initialInput,
      lang: 'python',
      dark: this.dark,
      onChange: () => this.schedule(),
    });
    this.out = createEditor(this.dom.editorOut, {
      doc: '',
      lang: 'json',
      readOnly: true, // FR-F9
      dark: this.dark,
    });

    // v1.2：把原生 select 升级为可造型下拉。
    // 仍在同步段内 —— 它只操作 DOM，无 await；且失败必须静默降级，
    // 绝不因此中断初始化（界面可用性 > 视觉一致性）。
    this.decorateSelects();

    this.bindEvents();
    this.renderTabs();
    if (initialInput) this.run(initialInput);
    else this.renderEmpty();

    // ── ② 异步段：偏好迟到不影响可用性 ──────────────────────────────────
    // 无继承值时才读 prefs；读取带 1.5s 超时，超时即放弃，绝不阻塞交互。
    if (inherited?.compact === undefined) {
      void this.applyPrefsWhenReady();
    }
  }

  /**
   * v1.2：把三个原生 select 升级为「按键 + 自绘菜单」。
   *
   * 每一步都可能因 DOM 结构异常而失败，全部 try 包住：
   * 装饰只是视觉增强，失败就用回原生 select —— 绝不让 UI 卡在半升级状态。
   */
  private decorateSelects(): void {
    const jobs: Array<[HTMLSelectElement | undefined, string | undefined]> = [
      [this.dom.fmtSelect, '来源'],
      [this.dom.targetSelect, '目标'],
      [this.dom.escapeStyleSelect, '风格'],
    ];
    for (const [sel, tag] of jobs) {
      if (!sel) continue;
      // 已装饰过就跳过（重复装饰会产生两套 DOM）
      if (sel.classList.contains('sel__native')) continue;
      try {
        const h = decorateSelect(sel, tag);
        bindHiddenClose(sel, h);
        this.selects.push(h);
      } catch {
        // 静默降级：保留原生 select，功能完全不受影响
      }
    }
  }

  /**
   * v1.2：按 tab 切换「通道导轨」颜色。
   * 无 root 节点（老测试挂载的精简 DOM）时静默跳过。
   */
  private syncChannel(): void {
    this.dom.root?.setAttribute('data-channel', this.tab);
  }

  /** 读取界面偏好；超时或失败都按默认值继续，不影响已就绪的 UI */
  private async applyPrefsWhenReady(): Promise<void> {
    const fallback: Prefs = {};
    const prefs = await withTimeout(loadPrefs(), 1500, fallback);

    // FR-L3 优先级：**历史偏好覆盖默认值**。
    // 首次安装 / 清数据 → 保持「格式化」；此后 → 上次离开的 tab。
    // 顺序不能反，否则「记住上次」会把默认值架空。
    if (prefs.tab && isTabId(prefs.tab) && prefs.tab !== this.tab) this.tab = prefs.tab;
    if (prefs.target && isTargetOpt(prefs.target)) this.target = prefs.target;
    if (prefs.strict !== undefined) this.strict = prefs.strict;
    // FR-I5 / FR-L3 同一优先级：历史偏好覆盖默认值（默认「增加转义」）
    if (prefs.escapeDir === 'encode' || prefs.escapeDir === 'decode') {
      this.escapeDir = prefs.escapeDir;
    }
    this.renderTabs();
    this.syncTabControls();

    const compactChanged = prefs.compact !== undefined && prefs.compact !== this.compact;
    if (compactChanged) this.compact = prefs.compact as boolean;

    // 已经有输出就按新偏好重渲染一次，保持视觉一致
    if (compactChanged || this.tab) {
      const text = this.in.getDoc();
      if (text.trim() !== '') this.run(text);
    }
  }

  private bindEvents(): void {
    this.dom.fmtSelect.addEventListener('change', () => {
      const v = this.dom.fmtSelect.value as SourceFormat;
      this.setLocked(v); // FR-B5 手动锁定
      this.run(this.in.getDoc());
    });

    this.dom.resetAuto.addEventListener('click', () => {
      this.setLocked(null); // FR-B7/B10
      this.run(this.in.getDoc());
    });

    // FR-L1：tab 切换。三个 tab 不共享输入内容（FR-L4），切换即重跑
    const tabBtns: Array<[HTMLElement | undefined, TabId]> = [
      [this.dom.tabFormat, 'format'],
      [this.dom.tabEscape, 'escape'],
      [this.dom.tabConvert, 'convert'],
    ];
    for (const [btn, id] of tabBtns) {
      btn?.addEventListener('click', () => this.switchTab(id));
    }

    // FR-A17：目标格式选择器（O-6：与来源选择器对称，来源 → 目标）
    this.dom.targetSelect?.addEventListener('change', () => {
      const v = this.dom.targetSelect!.value;
      if (isTargetOpt(v)) this.target = v;
      void this.persist();
      this.run(this.in.getDoc());
    });

    // FR-I2：转义风格选择器（四种风格）
    this.dom.escapeStyleSelect?.addEventListener('change', () => {
      const v = this.dom.escapeStyleSelect!.value;
      if (isEscapeStyle(v)) this.escapeStyle = v;
      void this.persist();
      this.run(this.in.getDoc());
    });

    // FR-I5：方向二选一（去除转义 / 增加转义）—— 显式点击，不再靠按钮翻转
    const dirBtns: Array<[HTMLElement | undefined, EscapeDir]> = [
      [this.dom.escapeDirDecode, 'decode'],
      [this.dom.escapeDirEncode, 'encode'],
    ];
    for (const [btn, dir] of dirBtns) {
      btn?.addEventListener('click', () => this.setEscapeDir(dir));
    }

    this.dom.btnConvert.addEventListener('click', () => {
      // 转义 tab 下「转换」按钮 = 反向执行一次（FR-I5：与顶部方向控件等价）
      if (this.tab === 'escape') {
        this.setEscapeDir(oppositeDir(this.escapeDir));
        return;
      }
      this.run(this.in.getDoc());
    });

    // 格式化 tab：btnFormat = 严格/容错档位（FR-K2），btnCompact = 美化/压缩（FR-K4）
    this.dom.btnFormat.addEventListener('click', () => {
      if (this.tab === 'format') {
        this.toggleStrict();
        return;
      }
      this.compact = false;
      void this.persist();
      this.run(this.in.getDoc());
    });

    this.dom.btnCompact.addEventListener('click', () => {
      if (this.tab === 'format') {
        this.toggleCompact();
        return;
      }
      this.compact = true;
      void this.persist();
      this.run(this.in.getDoc());
    });

    this.dom.btnCopy.addEventListener('click', () => void this.handleCopy());

    this.dom.btnDownload.addEventListener('click', () => {
      // AC-39：取自程序产物，不取 DOM
      if (this.tab === 'escape') {
        if (!this.escapeOutput) return;
        downloadText(this.escapeOutput, 'java'); // java → .txt
        return;
      }
      if (!this.state?.output) return;
      downloadText(this.state.output, this.state.outputLang);
    });

    this.dom.enlarge?.addEventListener('click', () => void this.handleEnlarge());

    this.dom.splitter?.addEventListener('pointerdown', (e) => this.startDrag(e as PointerEvent));

    // 修正提示条：点击摘要区展开/收起明细（FR-D5）
    this.dom.fixbar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // 明细区内的点击不收起，避免用户想选中文本时误触
      if (target.closest('.fixbar__detail')) return;
      this.dom.fixbar.classList.toggle('fixbar--open');
    });
  }

  /** 切换 tab（FR-L1 / FR-L4 / FR-L3） */
  switchTab(id: TabId): void {
    if (id === this.tab) {
      // v1.2：重复点同一 tab 也要收起动画，避免残留
      this.endBoot();
      return;
    }
    this.tab = id;
    // 换 tab 即作废「已确认剥离的前缀」——它是针对上一次输入的决定
    this.strippedPrefix = '';
    this.endBoot();
    this.renderTabs();
    this.syncTabControls();
    void this.persist();
    this.run(this.in.getDoc());
  }

  /** 渲染 tab 选中态（FR-L1 顺序固定，样式只切 aria-selected + class） */
  private renderTabs(): void {
    const map: Array<[HTMLElement | undefined, TabId]> = [
      [this.dom.tabFormat, 'format'],
      [this.dom.tabEscape, 'escape'],
      [this.dom.tabConvert, 'convert'],
    ];
    for (const [btn, id] of map) {
      if (!btn) continue;
      const on = id === this.tab;
      btn.classList.toggle('tab--on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.syncChannel();
    this.syncTabControls();
  }

  /** v1.2：入场动画播完即摘掉 class，避免它一直参与后续重排 */
  private endBoot(): void {
    if (this.booted) return;
    this.booted = true;
    const root = this.dom.root;
    if (!root) return;
    window.setTimeout(() => root.classList.remove('is-booting'), 700);
  }

  /**
   * 按 tab 切换各控件的可见性。
   * 格式化 tab 隐藏目标选择器（目标恒等于来源，FR-A19）；
   * 转义 tab 隐藏来源/目标选择器（纯文本通道，无格式概念，FR-I1）。
   */
  private syncTabControls(): void {
    const isEscape = this.tab === 'escape';
    const isFormat = this.tab === 'format';
    this.dom.fmtSelect.hidden = isEscape;
    this.dom.resetAuto.hidden = isEscape || this.locked === null;
    if (this.dom.targetSelect) this.dom.targetSelect.hidden = isEscape || isFormat;
    if (this.dom.targetSelect && !isEscape && !isFormat) {
      this.dom.targetSelect.value = this.target;
    }
    if (this.dom.escapeStyleSelect) {
      this.dom.escapeStyleSelect.hidden = !isEscape;
      this.dom.escapeStyleSelect.value = this.escapeStyle;
    }
    // FR-I5：方向二选一常驻显示，选中态一眼可见
    if (this.dom.escapeDirSeg) this.dom.escapeDirSeg.hidden = !isEscape;
    for (const [btn, dir] of [
      [this.dom.escapeDirDecode, 'decode'],
      [this.dom.escapeDirEncode, 'encode'],
    ] as Array<[HTMLElement | undefined, EscapeDir]>) {
      if (!btn) continue;
      const on = dir === this.escapeDir;
      btn.classList.toggle('seg__btn--on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // 转义 tab 用「反向：xxx」替代「转换」—— 文案明确说出会变成哪个方向
    this.dom.btnConvert.textContent = isEscape
      ? '反向：' + ESCAPE_DIR_LABEL[oppositeDir(this.escapeDir)]
      : '转换';
    this.dom.btnFormat.hidden = isEscape || !isFormat;
    this.dom.btnCompact.hidden = isEscape || !isFormat;
    if (isFormat) {
      this.dom.btnFormat.textContent = this.strict ? '档位：严格' : '档位：容错';
      this.dom.btnCompact.textContent = this.compact ? '缩进：压缩' : '缩进：美化';
    }
  }

  /** FR-K2：格式化 tab 的严格/容错档位切换 */
  toggleStrict(): void {
    this.strict = !this.strict;
    this.syncTabControls();
    void this.persist();
    this.run(this.in.getDoc());
  }

  /** FR-I5：切换转义方向（去除转义 ⇄ 增加转义） */
  setEscapeDir(dir: EscapeDir): void {
    if (dir === this.escapeDir) {
      this.syncTabControls();
      return;
    }
    this.escapeDir = dir;
    this.syncTabControls();
    void this.persist();
    this.run(this.in.getDoc());
  }

  /** FR-K4 / O-12：格式化 tab 的美化/压缩切换 */
  toggleCompact(): void {
    this.compact = !this.compact;
    this.syncTabControls();
    void this.persist();
    this.run(this.in.getDoc());
  }

  /** 统一维护「手动锁定」状态与判定条标记（FR-B5/B7/B10） */
  private setLocked(v: SourceFormat | null): void {
    this.locked = v;
    this.dom.lockBadge.hidden = v === null;
    this.dom.resetAuto.hidden = v === null;
  }

  private async persist(): Promise<void> {
    await savePrefs({
      compact: this.compact,
      tab: this.tab,
      target: this.target,
      strict: this.strict,
      escapeDir: this.escapeDir,
    });
  }

  private schedule(): void {
    const text = this.in.getDoc();
    const chars = [...text].length;
    // FR-G4：> 500,000 关闭实时转换
    if (chars > T2) {
      this.setStatus('文本过大，已关闭实时转换，请点「转换」');
      return;
    }
    // FR-G3：100,001–500,000 防抖 300ms 且关闭高亮
    const delay = chars > T1 ? 300 : 200;
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(text), delay);
  }

  /** 执行一次处理：按当前 tab 分派到对应链路（FR-L1 / FR-L4） */
  run(text: string): void {
    if (text.trim() === '') {
      this.state = null;
      this.renderEmpty();
      return;
    }

    const chars = [...text].length;

    // 性能降级（FR-G3）：关闭高亮，不重建编辑器（D-4）
    const highlightOn = chars <= T1;
    this.in.setHighlight(highlightOn);
    this.out.setHighlight(highlightOn);

    // v1.2：大文本时一并关掉装饰性动效（FR-G3/G4 精神：保住输入流畅度）
    this.dom.root?.classList.toggle('is-lite', !highlightOn);

    if (this.tab === 'escape') {
      this.runEscape(text);
      return;
    }

    // 格式化 tab：目标 = 来源（FR-A19 同语言规范化）+ 严格档（FR-K1）
    // 转换 tab：目标由选择器决定 + 宽松档
    const target: TargetFormat | 'auto' | 'same' = this.tab === 'format' ? 'same' : this.target;
    const result = convert(text, {
      force: this.locked,
      compact: this.compact,
      overrides: this.panel.overrides(),
      timeoutMs: 3000,
      target,
      strictOnly: this.tab === 'format' && this.strict,
      strippedPrefix: this.strippedPrefix || undefined,
    });

    this.state = result;
    this.updateStats(text, result.output);

    // 更新判定条
    this.dom.fmtLabel.textContent = FORMAT_TEXT[result.source];
    this.dom.fmtSelect.value = result.source;

    // 编辑器语言随输出方向切换
    this.out.setLang(result.outputLang);

    if (result.status === 'error') {
      // FR-D6/D7：高亮出错行 + 保留上一次成功结果置灰 + 禁用复制/下载
      this.out.setDoc(this.lastGoodOutput);
      this.dom.staleBadge.hidden = false;
      this.dom.editorOut.classList.add('is-stale');
      this.setButtons(false);
      const e = result.error;
      this.setStatus(e ? e.message : '解析失败', 'error');
      if (e) this.in.highlightLine(e.line);
      this.setFixbar(null, result);
      this.renderSuggestion(text, result);
      // FR-D13：疑似日志前缀 → 给一键剥离入口（只在报错时建议，绝不自动剥）
      this.renderPrefixHint(result);
      return;
    }

    if (result.status === 'timeout') {
      this.setStatus('转换超时，建议用放大页面或拆分文本', 'error');
      this.setButtons(false);
      return;
    }

    // 成功路径：清除失败态（AC-23 —— 用户补齐后角标移除、按钮解禁）
    this.lastGoodOutput = result.output;
    this.lastGoodLang = result.outputLang;
    this.out.setDoc(result.output);
    this.dom.staleBadge.hidden = true;
    this.dom.editorOut.classList.remove('is-stale');
    this.in.clearHighlight();
    this.setButtons(true);

    // 修正提示条（FR-D4/D5）
    this.setFixbar(result, result);

    // 回退提示（FR-B11 / AC-48）
    if (result.fallbackFrom) {
      this.setStatus(`已按 ${FORMAT_TEXT[result.source]} 格式解析`);
    } else {
      this.setStatus('');
    }

    this.clearSuggestion();
    this.clearPrefixHint();

    // 类型面板（FR-C11 / D-2）
    this.renderTypePanel(result);
  }

  /**
   * 转义 tab 链路（FR-I1～I4）
   *
   * 【与转换链路的本质区别】这是**纯字符串**通道（文本 → 文本），
   * 不经过 IR —— 绝不尝试解析输入结构。
   */
  private runEscape(text: string): void {
    const res = escapeText(text, this.escapeStyle, this.escapeDir);
    this.escapeOutput = res.output;
    this.escapeError = res.error;

    if (!res.ok) {
      // FR-I3：失败不返回部分结果，保留旧输出置灰 + 禁用复制/下载
      this.out.setDoc(this.lastGoodOutput);
      this.dom.staleBadge.hidden = false;
      this.dom.editorOut.classList.add('is-stale');
      this.setButtons(false);
      this.setStatus(res.error ?? '转义失败', 'error');
      this.setFixbar(null, { duplicates: undefined } as unknown as ConvertResult);
      this.clearSuggestion();
      this.dom.typePanel.hidden = true;
      this.updateStats(text, '');
      return;
    }

    this.lastGoodOutput = res.output;
    this.out.setDoc(res.output);
    this.dom.staleBadge.hidden = true;
    this.dom.editorOut.classList.remove('is-stale');
    this.in.clearHighlight();
    this.setButtons(true);
    this.setFixbar(null, { duplicates: undefined } as unknown as ConvertResult);
    // FR-I6：剥了外层引号必须说出来，让操作可追溯
    this.setStatus(res.note ?? '');
    this.clearSuggestion();
    this.dom.typePanel.hidden = true;
    this.updateStats(text, res.output);
  }

  private renderTypePanel(r: ConvertResult): void {
    // 仅 Map 模式提供类型下拉
    if (r.source !== 'map') {
      this.dom.typePanel.hidden = true;
      return;
    }
    this.panel.render(this.dom.typePanel, r, () => {
      // FR-C7：改类型后重渲染输出，不重新解析输入。
      // 必须同步更新 this.state —— 否则「复制/下载」取的还是改类型前的旧输出，
      // 用户看到的新输出与复制出去的内容不一致（AC-39 的精神：以 IR 结果为准）。
      if (!this.state?.ir) return;
      const re = convert(this.in.getDoc(), {
        force: this.locked,
        compact: this.compact,
        overrides: this.panel.overrides(),
      });
      if (re.status !== 'error' && re.status !== 'timeout') {
        this.state = re;
        this.lastGoodOutput = re.output;
        this.lastGoodLang = re.outputLang;
        this.out.setDoc(re.output);
        this.updateStats(this.in.getDoc(), re.output);
      }
    });
  }

  /**
   * 修正提示条（FR-D4/D5）
   * 明细逐条列出「行号列号 + 涉及片段 + 修正动作」，> 5 处加视觉强调。
   */
  private setFixbar(r: ConvertResult | null, full: ConvertResult): void {
    const parts: string[] = [];
    const fixes = r?.fixes ?? [];
    if (fixes.length > 0) {
      parts.push(`已自动修正 ${fixes.length} 处`);
    }
    if (full.duplicates && full.duplicates.count > 0) {
      parts.push(`存在重复键 ${full.duplicates.count} 个，目标语言求值时后者将覆盖前者`);
    }
    if (parts.length === 0) {
      this.dom.fixbar.hidden = true;
      this.dom.fixbar.textContent = '';
      return;
    }
    this.dom.fixbar.hidden = false;
    this.dom.fixbar.classList.toggle('fixbar--warn', fixes.length > FIX_WARN_THRESHOLD);

    const rows = fixes
      .map((f) => {
        const seg = f.before ? `「${f.before}」` : '';
        return `第 ${f.line} 行第 ${f.col} 列：${f.action}${seg}`;
      })
      .join('\n');
    const dupRows =
      full.duplicates && full.duplicates.count > 0
        ? `重复键：${full.duplicates.keys.join('、')}（已全部保留，不去重）\n`
        : '';

    this.dom.fixbar.innerHTML =
      `<span class="fixbar__summary">${escapeHtml(parts.join(' · '))} <span class="fixbar__caret">▾</span></span>` +
      `<pre class="fixbar__detail">${escapeHtml(dupRows + rows)}</pre>`;
  }

  /**
   * FR-D10：解析失败且未手动锁定格式时，提示可切换来源格式并提供一键入口。
   * 建议来自 detect 打分（复用同一份 Token 流），不额外扫描。
   */
  private renderSuggestion(text: string, r: ConvertResult): void {
    this.clearSuggestion();
    if (this.locked || r.status !== 'error') return;
    const list = suggestFormats(text, r.source, 2);
    if (list.length === 0) return;

    const box = document.createElement('div');
    box.className = 'suggest';
    box.id = 'suggestBox';
    const tip = document.createElement('span');
    tip.className = 'suggest__tip';
    tip.textContent = '可尝试手动切换来源格式：';
    box.appendChild(tip);
    for (const s of list) {
      const btn = document.createElement('button');
      btn.className = 'btn btn--ghost suggest__btn';
      btn.type = 'button';
      btn.textContent = s.label;
      btn.title = s.reason;
      btn.addEventListener('click', () => {
        this.dom.fmtSelect.value = s.format;
        this.setLocked(s.format);
        this.run(this.in.getDoc());
      });
      box.appendChild(btn);
    }
    this.dom.statusMsg.parentElement?.insertBefore(box, this.dom.statusMsg);
  }

  private clearSuggestion(): void {
    document.getElementById('suggestBox')?.remove();
  }

  /**
   * FR-D13：解析失败且疑似日志前缀 → 提供「剥离日志前缀后重试」一键入口。
   *
   * 只有用户点击才真的剥离；且剥离后必须显示被剥掉了什么（FR-D14），
   * 否则剥离本身又变成另一种静默行为。
   */
  private renderPrefixHint(r: ConvertResult): void {
    this.clearPrefixHint();
    // 已经剥离过还失败 → 不再劝一次，避免死循环
    if (!r.prefixHint || this.strippedPrefix) return;

    const box = document.createElement('div');
    box.className = 'suggest';
    box.id = 'prefixHintBox';

    const tip = document.createElement('span');
    tip.className = 'suggest__tip';
    tip.textContent = '这段开头像是日志前缀：';
    box.appendChild(tip);

    const code = document.createElement('code');
    code.className = 'suggest__code';
    code.textContent = clipHint(r.prefixHint.prefix);
    code.title = r.prefixHint.prefix;
    box.appendChild(code);

    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost suggest__btn';
    btn.type = 'button';
    btn.textContent = '剥离后重试';
    btn.addEventListener('click', () => {
      this.strippedPrefix = r.prefixHint!.prefix;
      this.run(this.in.getDoc());
    });
    box.appendChild(btn);

    this.dom.statusMsg.parentElement?.insertBefore(box, this.dom.statusMsg);
  }

  private clearPrefixHint(): void {
    document.getElementById('prefixHintBox')?.remove();
  }

  private setButtons(enabled: boolean): void {
    // FR-E8：无有效输出时全部禁用；失败态仅「转换」可用（FR-D7）
    this.dom.btnCopy.disabled = !enabled;
    this.dom.btnDownload.disabled = !enabled;
    this.dom.btnFormat.disabled = !enabled;
    this.dom.btnCompact.disabled = !enabled;
    this.dom.btnConvert.disabled = false;
    this.dom.btnDownload.textContent =
      this.tab === 'escape' ? '下载 .txt' : downloadLabel(this.lastGoodLang);
  }

  /**
   * v1.2：状态灯 —— 让「成功 / 报错 / 待输入」不用读文字也能看见。
   * 三态：无消息=灰（待机）、有消息=绿（就绪）、error=红（故障）。
   */
  private setStatus(msg: string, kind: 'info' | 'error' = 'info'): void {
    this.dom.statusMsg.textContent = msg;
    this.dom.statusMsg.classList.toggle('statusmsg--error', kind === 'error');

    const led = this.dom.statusLed;
    if (led) {
      led.classList.toggle('status__led--error', kind === 'error');
      led.classList.toggle('status__led--ok', kind === 'info' && msg !== '');
    }
  }

  private renderEmpty(): void {
    this.out.setDoc('');
    this.in.clearHighlight();
    this.dom.staleBadge.hidden = true;
    this.dom.editorOut.classList.remove('is-stale');
    this.setButtons(false);
    this.setStatus('粘贴内容即可自动转换');
    this.dom.fixbar.hidden = true;
    this.dom.typePanel.hidden = true;
    this.clearSuggestion();
    this.updateStats('', '');
  }

  private updateStats(inText: string, outText: string): void {
    const a = computeStats(inText);
    const b = computeStats(outText);
    this.dom.statsIn.textContent = `行 ${a.lines} · 字符 ${a.chars}`;
    this.dom.statsOut.textContent = `行 ${b.lines} · 字符 ${b.chars}`;
  }

  private async handleCopy(): Promise<void> {
    // AC-39 精神：一律取程序产物，绝不取编辑器 DOM
    const payload = this.tab === 'escape' ? this.escapeOutput : (this.state?.output ?? '');
    if (!payload) return;
    const res = await copyText(payload);
    if (res.ok) {
      const old = this.dom.btnCopy.textContent;
      this.dom.btnCopy.textContent = '✓ 已复制';
      // v1.2：整键闪一下信号色 —— 原来只改文字，反馈太弱
      this.dom.btnCopy.classList.remove('btn--flash');
      // 强制回流以重启动画（连续复制两次时第二下也要闪）
      void this.dom.btnCopy.offsetWidth;
      this.dom.btnCopy.classList.add('btn--flash');
      setTimeout(() => {
        this.dom.btnCopy.textContent = old;
        this.dom.btnCopy.classList.remove('btn--flash');
      }, 2000);
      this.setStatus(res.message);
    } else {
      // FR-E6：失败时全选输出区，引导手动复制
      this.out.setEditable(true);
      const el = this.dom.editorOut.querySelector('.cm-content') as HTMLElement | null;
      if (el) selectAllIn(el);
      this.setStatus(res.message, 'error');
    }
  }

  /** C-1 / FR-F6：window.open，不用 chrome.tabs.create */
  private async handleEnlarge(): Promise<void> {
    await writeSession({
      input: this.in.getDoc(),
      source: this.state?.source,
      locked: this.locked !== null,
      compact: this.compact,
      overrides: [...this.panel.overrides().entries()],
      // O-9：不带这三个，放大页会跳回默认 tab
      tab: this.tab,
      target: this.target,
      strict: this.strict,
      escapeStyle: this.escapeStyle,
      escapeDir: this.escapeDir,
    });
    window.open(chrome.runtime.getURL('app.html'), '_blank');
  }

  private startDrag(e: PointerEvent): void {
    const splitter = this.dom.splitter;
    if (!splitter) return;
    const container = splitter.parentElement as HTMLElement;
    const startY = e.clientY;
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const ratio = Math.min(0.8, Math.max(0.2, dy / rect.height));
      const inPane = container.querySelector('.pane--in') as HTMLElement | null;
      if (inPane) inPane.style.flex = String(0.5 + ratio);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** 供放大页与外部驱动（自动化测试）写入输入内容 */
  setInput(text: string): void {
    this.in.setDoc(text);
    this.run(text);
  }

  get input(): string {
    return this.in.getDoc();
  }

  get output(): string {
    return this.tab === 'escape' ? this.escapeOutput : (this.state?.output ?? '');
  }

  /** 当前 tab（FR-L1） */
  get currentTab(): TabId {
    return this.tab;
  }

  /** 程序化设置目标格式（FR-A17），供测试与放大页继承驱动 */
  setTarget(t: TargetFormat | 'auto'): void {
    this.target = t;
    if (this.dom.targetSelect) this.dom.targetSelect.value = t;
    this.run(this.in.getDoc());
  }

  /** 程序化设置转义风格与方向（FR-I2 / FR-I5），供测试驱动 */
  setEscape(style: EscapeStyle, dir?: EscapeDir): void {
    this.escapeStyle = style;
    if (dir) this.escapeDir = dir;
    if (this.dom.escapeStyleSelect) this.dom.escapeStyleSelect.value = style;
    this.syncTabControls();
    this.run(this.in.getDoc());
  }

  /** 当前转义方向（FR-I5），供测试与放大页继承校验 */
  get currentEscapeDir(): EscapeDir {
    return this.escapeDir;
  }
}

/**
 * 给 Promise 套超时。超时后返回 fallback，而不是永远挂起。
 *
 * chrome.storage 在扩展上下文异常时可能既不 resolve 也不 reject，
 * 任何 await 都必须有兜底，否则 UI 初始化会被整条链路拖死。
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 剥离提示里的前缀片段截断，避免超长日志行撑爆布局 */
function clipHint(s: string): string {
  const one = s.replace(/\n/g, '\\n');
  return one.length > 40 ? one.slice(0, 40) + '…' : one;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

/** SessionState 里的 source 是 string，需收窄为 SourceFormat */
function isSourceFormat(v: string): v is SourceFormat {
  return v === 'json' || v === 'python' || v === 'java' || v === 'map';
}

/** 持久化值可能是任意字符串（旧版本/被篡改），必须收窄后再用 */
function isTabId(v: string): v is TabId {
  return (TAB_ORDER as string[]).includes(v);
}

function isTargetOpt(v: string): v is TargetFormat | 'auto' {
  return v === 'auto' || v === 'json' || v === 'python' || v === 'java';
}

function isEscapeStyle(v: string): v is EscapeStyle {
  return (ALL_ESCAPE_STYLES as string[]).includes(v);
}

export type { FormatSuggestion };
