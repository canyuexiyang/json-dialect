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
import { locate, pathIrFor, supportsPath, type PathHit, type PathLang } from '../core/path.js';
import type { JVal } from '../core/types.js';
import { createEditor, type EditorHandle } from './editor.js';
import { copyText, selectAllIn } from './clipboard.js';
import { downloadText, downloadLabel } from './download.js';
import { loadPrefs, savePrefs, writeSession, discardSession, withTimeout, type Prefs, type WorkspaceState } from './sessionState.js';
import { closeSidePanel } from './sidePanel.js';
import { createTypePanel, isOverrideType, type OverrideType } from './typeWidgets.js';
import { decorateSelect, bindHiddenClose, closeOpenSelect, type SelectHandle } from './select.js';

export interface DomRefs {
  fmtLabel: HTMLElement;
  lockBadge: HTMLElement;
  /** v1.5 / D1：格式化 tab 下 Map 来源回退 Python 的明示标签 */
  sameTargetLabel?: HTMLElement;
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
  /** v1.5 / D3：encode 时给结果包裹外层引号（转义 tab） */
  wrapQuotesWrap?: HTMLElement;
  wrapQuotes?: HTMLInputElement;
  editorIn: HTMLElement;
  editorOut: HTMLElement;
  /** v1.5 / D12：空态一键示例 */
  emptyHints?: HTMLElement;
  /** v1.5 / D26：清空输入 */
  btnClear?: HTMLButtonElement;
  /** v1.5 / D26：存为片段（仅内存） */
  btnSnippet?: HTMLButtonElement;
  /** v1.5 / D26：并排对比输入与输出 */
  btnCompare?: HTMLButtonElement;
  /** v1.5 / D11：tabpanel 语义容器 */
  paneIn?: HTMLElement;
  paneOut?: HTMLElement;
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
  /** 宽度引导条（v1.3.1）：只在侧边栏形态出现，可关闭 */
  widthHint?: HTMLElement;
  widthHintClose?: HTMLButtonElement;
  splitter?: HTMLElement;
  /** v1.4 路径条：全部可选 —— 老测试挂的精简 DOM 里没有这些节点 */
  pathBar?: HTMLElement;
  pathText?: HTMLElement;
  pathKind?: HTMLElement;
  pathCopy?: HTMLButtonElement;
}

/** 性能三档阈值（FR-G2/G3/G4）
 *  v1.5 / D19：T2 从 500k 提到 1M。实测（vite-node）1M 字符 convert 仅
 *  169–215ms，真正的瓶颈在 CM6 setDoc + 渲染而非内核；500k 关实时转换过于保守。 */
const T1 = 100_000;
const T2 = 1_000_000;

/** splitter 拖拽/键盘微调的上下限比例 */
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
/** 键盘单次微调步长 */
const SPLIT_STEP = 0.05;
/**
 * 单个 pane 的最小高度兜底（px）。
 * `.pane` 是 flex:1 1 0，可以被压到 0 —— 一旦输入区被压没，
 * 用户连撤销都够不到，且窄侧边栏下高度紧张时最容易触发。
 */
const PANE_MIN_PX = 72;

/** 修正 > 5 处时视觉强调（M2-1） */
const FIX_WARN_THRESHOLD = 5;

/** 三个功能 tab（FR-L1：顺序固定 ① 格式化 · ② 转义 · ③ 转换） */
export type TabId = 'format' | 'escape' | 'convert';

/** 承载形态（v1.3）：侧边栏 / 独立标签页 */
export type SurfaceKind = 'panel' | 'tab';

const TAB_ORDER: TabId[] = ['format', 'escape', 'convert'];

const TAB_TEXT: Record<TabId, string> = {
  format: '格式化',
  escape: '转义',
  convert: '转换',
};

/** 放大页从 session 继承的会话态（AC-33 / FR-F6） */
export interface InheritedState {
  workspaces?: Record<string, WorkspaceState>;
  strippedPrefix?: string;
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
  /** v1.5 / D3：包裹外层引号开关一并继承 */
  wrapQuotes?: boolean;
}

const FORMAT_TEXT: Record<SourceFormat, string> = {
  json: '标准 JSON',
  python: 'Python 字面量',
  java: 'Java 转义字符串',
  map: 'Map.toString()',
};

/** v1.4：路径条徽标文案。键与值同一条路径，靠这个徽标区分「我正在看的是哪个」 */
const KIND_LABEL: Record<string, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔',
  null: 'null',
  array: '数组',
  object: '对象',
};

const PATH_PLACEHOLDER = '点选输入或输出中的键或值';

/**
 * v1.5 / D12：空态一键示例。
 * 属界面文案（写死在代码里，不落盘、不来自任何输入），不违反 FR-H4。
 */
const EXAMPLE_INPUTS: Record<'json' | 'python' | 'map', string> = {
  json: '{"tool": "JSON Dialect", "tags": ["json", "python"], "ok": true}',
  python: "{'tool': 'JSON Dialect', 'tags': ['json', 'python'], 'ok': True}",
  map: '{tool=JSON Dialect, tags=[json, python], ok=true}',
};

export class AppController {
  private in!: EditorHandle;
  private out!: EditorHandle;
  private state: ConvertResult | null = null;
  private locked: SourceFormat | null = null;
  private compact = false;
  private timer: number | undefined;
  private enlarging = false;
  private suppressInput = false;
  private prefsRevision = 0;
  /** v1.5.1 / N05：非空输入时 Esc 的二次确认时间戳（0 = 未处于待确认态） */
  private escArmedAt = 0;
  private splitRatio = 0.5;
  private workspaces: Partial<Record<TabId, { input: string; locked: SourceFormat | null; overrides: Array<[string, OverrideType]>; strippedPrefix: string; lastGoodOutput: string; lastGoodLang: OutputLang }>> = {};
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
  /** v1.3.1：宽度引导条已被用户关掉（存进 prefs，属界面偏好，不违反 FR-H4） */
  private hintWidthDismissed = false;
  /** v1.4：光标最后落在哪个编辑器 —— 路径条跟随它，而不是同时显示两个 */
  private activePane: 'in' | 'out' = 'in';
  /** v1.4：当前可复制的路径（空串 = 无路径，复制按钮禁用） */
  private pathValue = '';
  /** v1.4：路径条当前展示的完整文本（供溢出重新裁剪） */
  private pathShown = '';
  /** v1.4：路径文本的中段省略锚点；空串表示这不是一条路径（占位/原因） */
  private pathHead = '$';
  /** v1.4：输出区二次解析缓存 —— 文本或语言变了才重解析（AC-102） */
  private outPathCache: { text: string; lang: PathLang; ir: JVal | null } | null = null;
  /** v1.4：复制按钮「已复制」的还原定时器 */
  private pathCopyTimer: number | undefined;
  /** v1.5 / D3：转义 tab encode 是否包裹外层引号 */
  private wrapQuotes = false;
  /** v1.5 / D19：输入超过 T2 时置位 —— 「转换」按钮恢复本名，「仍要转换」条出现 */
  private oversize = false;
  /** v1.5 / D7：resize 的 rAF 节流句柄 */
  private resizeRaf = 0;
  /** v1.5 / D26：输入片段（纯内存，绝不落盘，刷新即失；上限 8 条防挤爆） */
  /** v1.6 / N16：片段带来源 tab —— 跨 tab 复用纯文本会让人误以为丢了结构 */
  private snippets: Array<{ text: string; tab: TabId }> = [];
  /** v1.5 / D4：matchMedia change 监听器（销毁时摘除） */
  private themeQuery: MediaQueryList | null = null;

  constructor(
    private dom: DomRefs,
    /** 承载形态：侧边栏 / 独立标签页。v1.2 的 `isPage` 是死代码（零读取点），已删除。 */
    private opts: { surface?: SurfaceKind } = {},
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

    // v1.5 / D4：监听系统深浅色切换，运行时跟随（原先只读一次，切主题要重载扩展）。
    // jsdom 的 matchMedia stub 可能没有 addEventListener —— 必须能力检测。
    try {
      const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
      if (mq && typeof (mq as MediaQueryList & { addEventListener?: unknown }).addEventListener === 'function') {
        this.themeQuery = mq;
        mq.addEventListener('change', (e) => this.applyTheme(e.matches));
      }
    } catch {
      /* 监听失败不影响任何功能，只是不跟随 */
    }

    // ── ① 同步段：先把交互就绪，任何 await 都不得出现在这之前 ──────────────
    this.applyInherited(inherited);

    this.in = createEditor(this.dom.editorIn, {
      doc: initialInput,
      lang: 'python',
      dark: this.dark,
      onChange: () => { if (!this.suppressInput) this.schedule(); },
      onCursor: (offset) => this.onCursor('in', offset),
    });
    this.out = createEditor(this.dom.editorOut, {
      doc: '',
      lang: 'json',
      readOnly: true, // FR-F9
      dark: this.dark,
      onCursor: (offset) => this.onCursor('out', offset),
    });

    // v1.2：把原生 select 升级为可造型下拉。
    // 仍在同步段内 —— 它只操作 DOM，无 await；且失败必须静默降级，
    // 绝不因此中断初始化（界面可用性 > 视觉一致性）。
    this.decorateSelects();

    this.bindEvents();
    this.bindGlobalKeys();
    this.applySplit(this.splitRatio);
    this.renderTabs();
    this.clearPath(); // v1.4：格式化 tab 首屏先给占位，避免空白条
    // v1.5.1 / N01：首屏继承来的大文本也必须过闸门，统一走 setInput
    if (initialInput) this.setInput(initialInput);
    else this.renderEmpty();

    // ── ② 异步段：偏好迟到不影响可用性 ──────────────────────────────────
    // 无继承值时才读 prefs；读取带 1.5s 超时，超时即放弃，绝不阻塞交互。
    if (inherited?.compact === undefined) {
      void this.applyPrefsWhenReady();
    }
  }

  /**
   * 应用跨页继承态（AC-33 / O-9）。
   *
   * v1.5.1 / N11：从 init() 的同步段抽出，使「放大页交接迟到」也能复用同一套逻辑。
   * 这里只写字段与 DOM，绝不 await —— 保证编辑器创建永远排在第一个 await 之前。
   */
  private applyInherited(inherited?: InheritedState): void {
    // 先用继承值/默认值，prefs 到位后再补（见 init ②）
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
    if (inherited?.wrapQuotes !== undefined) {
      this.wrapQuotes = inherited.wrapQuotes;
      if (this.dom.wrapQuotes) this.dom.wrapQuotes.checked = this.wrapQuotes;
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

    if (inherited?.strippedPrefix) this.strippedPrefix = inherited.strippedPrefix;
    for (const [id, workspace] of Object.entries(inherited?.workspaces ?? {})) {
      if (!isTabId(id) || id === this.tab) continue;
      this.workspaces[id] = {
        input: workspace.input,
        locked: workspace.locked && workspace.source && isSourceFormat(workspace.source) ? workspace.source : null,
        overrides: (workspace.overrides ?? []).filter((entry): entry is [string, OverrideType] => isOverrideType(entry[1])),
        strippedPrefix: workspace.strippedPrefix ?? '', lastGoodOutput: '', lastGoodLang: 'json',
      };
    }
  }

  /**
   * v1.5.1 / N11：放大页入口的跨页交接迟到时补齐。
   *
   * app.ts 现在先同步建 DOM + 编辑器，再异步 consumeSession()；
   * 交接态到位后走这里重放，界面在此期间始终可用。
   * 递增 prefsRevision 是为了让「迟到的历史偏好」不覆盖刚继承的会话态
   *（applyPrefsWhenReady 的守卫语义：显式状态变更优先）。
   */
  inheritFromSession(input: string, inherited: InheritedState): void {
    this.applyInherited(inherited);
    this.prefsRevision++;
    this.renderTabs();
    this.syncTabControls();
    this.setInput(input);
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

  /** v1.5 / D4：运行时切换深浅色 —— body class + 两个编辑器主题 reconfigure，不重建 */
  private applyTheme(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    document.body.classList.toggle('theme-dark', dark);
    try {
      this.in.setDark(dark);
      this.out.setDark(dark);
    } catch {
      /* reconfigure 失败不影响功能 */
    }
  }

  /** 读取界面偏好；超时或失败都按默认值继续，不影响已就绪的 UI */
  private async applyPrefsWhenReady(): Promise<void> {
    const fallback: Prefs = {};
    const revision = this.prefsRevision;
    const prefs = await withTimeout(loadPrefs(), 1500, fallback);
    // v1.5 / D8：守卫只在「用户显式改了偏好」（persist 调用点）时触发。
    // 原先 schedule/setInput/setLocked 也会递增 revision，导致托管 Chrome 下
    // storage 迟迟不返回时，用户一粘贴就把 tab/档位/缩进/比例补齐整个丢掉。
    if (revision !== this.prefsRevision) return;

    // FR-L3 优先级：**历史偏好覆盖默认值**。
    // 首次安装 / 清数据 → 保持「格式化」；此后 → 上次离开的 tab。
    // 顺序不能反，否则「记住上次」会把默认值架空。
    const prev = {
      tab: this.tab,
      target: this.target,
      strict: this.strict,
      compact: this.compact,
      escapeDir: this.escapeDir,
      wrapQuotes: this.wrapQuotes,
    };
    if (prefs.tab && isTabId(prefs.tab)) this.tab = prefs.tab;
    if (prefs.target && isTargetOpt(prefs.target)) this.target = prefs.target;
    if (prefs.strict !== undefined) this.strict = prefs.strict;
    // FR-I5 / FR-L3 同一优先级：历史偏好覆盖默认值（默认「增加转义」）
    if (prefs.escapeDir === 'encode' || prefs.escapeDir === 'decode') {
      this.escapeDir = prefs.escapeDir;
    }
    if (typeof prefs.wrapQuotes === 'boolean') this.wrapQuotes = prefs.wrapQuotes;
    if (this.dom.wrapQuotes) this.dom.wrapQuotes.checked = this.wrapQuotes;
    // v1.3.1：引导条只提示一次，关过就不再打扰
    if (prefs.hintWidth !== undefined) this.hintWidthDismissed = prefs.hintWidth;
    if (typeof prefs.splitRatio === 'number' && Number.isFinite(prefs.splitRatio)) this.applySplit(prefs.splitRatio);
    this.syncWidthHint();
    this.renderTabs();
    this.syncTabControls();

    // v1.5 / D17：只有偏好**真的改变了会产出不同结果的字段**才重跑。
    // 原条件 `compactChanged || this.tab` 里 this.tab 恒为真值 ——
    // 每次启动只要有输入就多跑一次 convert。
    const changed =
      this.tab !== prev.tab ||
      this.target !== prev.target ||
      this.strict !== prev.strict ||
      this.compact !== prefs.compact ||
      this.escapeDir !== prev.escapeDir ||
      this.wrapQuotes !== prev.wrapQuotes;
    if (prefs.compact !== undefined) this.compact = prefs.compact;

    // 已经有输出就按新偏好重渲染一次，保持视觉一致
    if (changed || this.compact !== prev.compact) {
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
      btn?.addEventListener('keydown', (e) => {
        const index = TAB_ORDER.indexOf(id);
        const next = e.key === 'ArrowRight' ? (index + 1) % 3 : e.key === 'ArrowLeft' ? (index + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1;
        if (next < 0) return;
        e.preventDefault();
        this.switchTab(TAB_ORDER[next]);
        tabBtns[next][0]?.focus();
      });
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

    // v1.5 / D3：包裹外层引号（仅 encode 方向有意义；勾选即重跑）
    this.dom.wrapQuotes?.addEventListener('change', () => {
      this.wrapQuotes = this.dom.wrapQuotes!.checked;
      void this.persist();
      this.run(this.in.getDoc());
    });

    // v1.5 / D12：空态一键示例 —— 点击直接灌进输入区（示例文案属界面内容，不落盘）
    this.dom.emptyHints?.querySelectorAll<HTMLButtonElement>('[data-example]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ex = EXAMPLE_INPUTS[btn.dataset.example as keyof typeof EXAMPLE_INPUTS];
        if (ex) this.setInput(ex);
      });
    });

    // v1.5 / D26：清空输入
    this.dom.btnClear?.addEventListener('click', () => this.setInput(''));

    // v1.5 / D26：存为片段（纯内存；FR-H4 输入零落盘 —— 绝不进任何 storage）
    this.dom.btnSnippet?.addEventListener('click', () => {
      const text = this.in.getDoc();
      if (!text.trim()) {
        this.setStatus('输入为空，没有可存的片段');
        return;
      }
      if (this.snippets[0]?.text === text && this.snippets[0]?.tab === this.tab) {
        this.setStatus('最新片段就是它（不重复保存）');
        return;
      }
      this.snippets.unshift({ text, tab: this.tab });
      if (this.snippets.length > 8) this.snippets.length = 8;
      this.renderSnippets();
      this.setStatus('已存为片段（仅本次会话，刷新即失）');
    });

    // v1.5 / D26：并排对比输入与输出
    this.dom.btnCompare?.addEventListener('click', () => this.openCompare());

    this.dom.btnConvert.addEventListener('click', () => {
      // 转义 tab 下「转换」按钮 = 反向执行一次（FR-I5：与顶部方向控件等价）
      if (this.tab === 'escape') {
        this.setEscapeDir(oppositeDir(this.escapeDir));
        return;
      }
      this.run(this.in.getDoc());
    });

    // 格式化 tab：btnFormat = 严格/容错档位（FR-K2），btnCompact = 美化/压缩（FR-K4）
    // v1.5 / D6：转换 tab 的 btnCompact 同样走 toggle —— 原先点击只会单向置 true，
    // 想从压缩切回美化没有任何入口。
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
      if (this.tab === 'escape') return;
      this.toggleCompact();
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

    // v1.3.1：宽度引导条「知道了」—— 关掉即写入 prefs，下次不再出现
    this.dom.widthHintClose?.addEventListener('click', () => {
      this.hintWidthDismissed = true;
      this.syncWidthHint();
      void this.persist();
    });

    this.dom.splitter?.addEventListener('pointerdown', (e) => this.startDrag(e as PointerEvent));
    this.bindSplitterKeys();

    // v1.4 路径条（FR-P6 / FR-P7）：按钮复制 + 双击路径文本复制 + 键盘复制
    this.dom.pathCopy?.addEventListener('click', () => void this.copyPath());
    this.dom.pathText?.addEventListener('dblclick', () => void this.copyPath());
    this.dom.pathBar?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void this.copyPath();
      }
    });
    // 侧边栏被拖动改宽时重新裁剪，否则中段省略会按旧宽度算（AC-98）
    // v1.5 / D7：resize 高频触发，用 rAF 合并到下一帧 —— 原来
    // 每次 resize 都同步 fitPath（读 scrollWidth 强制重排），拖边缘会连续 reflow。
    window.addEventListener('resize', () => {
      if (this.resizeRaf) return;
      this.resizeRaf = window.requestAnimationFrame(() => {
        this.resizeRaf = 0;
        this.fitPath();
      });
    });

    // v1.5 / D26：拖文件进输入区（扩展页内 FileReader，零网络；文件只进内存）
    this.dom.editorIn.addEventListener('dragover', (e) => e.preventDefault());
    this.dom.editorIn.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) {
        this.setStatus('文件超过 20MB，为保住输入流畅度已拒收', 'error');
        return;
      }
      void file.text().then((text) => {
        this.setInput(text);
        this.setStatus(`已载入 ${file.name}（${computeStats(text).chars} 字符）`);
      });
    });

    // 修正提示条：点击摘要区展开/收起明细（FR-D5）
    this.dom.fixbar.tabIndex = 0;
    this.dom.fixbar.setAttribute('role', 'button');
    this.dom.fixbar.setAttribute('aria-expanded', 'false');
    this.dom.fixbar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.dom.fixbar.click(); }
    });
    this.dom.fixbar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // 明细区内的点击不收起，避免用户想选中文本时误触
      if (target.closest('.fixbar__detail')) return;
      const open = this.dom.fixbar.classList.toggle('fixbar--open');
      this.dom.fixbar.setAttribute('aria-expanded', String(open));
    });
  }

  // ── v1.4 路径定位（FR-P1～P10） ────────────────────────────────────

  /** 光标事件入口（单击 / 双击 / 拖选 / 方向键），记录所属编辑器 */
  private onCursor(pane: 'in' | 'out', offset: number): void {
    this.activePane = pane;
    this.updatePath(pane, offset);
  }

  /**
   * 更新路径条。
   *
   * 命中 → 显示路径；未命中（分隔符 / 空白 / 文末）→ **保持上一次**（FR-P4）；
   * 只有「明确不可用」时才改文案，绝不把报错态伪装成「没点中」。
   */
  private updatePath(pane: 'in' | 'out', offset: number): void {
    // v1.5 / D25：转换 tab 也开放路径定位（输出区是目标语言，同样有「这个值在哪」的需求）。
    // 转义 tab 是纯文本通道，没有结构 → 不提供。
    if (this.tab === 'escape') return;
    const handle = pane === 'in' ? this.in : this.out;
    if (!handle) return;
    const text = handle.getDoc();
    const hit = locate(this.irForPane(pane), text, offset);
    if (hit) {
      this.showPath(hit);
      return;
    }
    const reason = this.pathUnavailableReason(pane, text);
    if (reason) this.showPathReason(reason);
  }

  /** 一次处理结束后按当前焦点重算 —— 输入内容变了，偏移对应的元素也变了 */
  private refreshPathForActive(): void {
    if (this.tab === 'escape') return;
    const handle = this.activePane === 'in' ? this.in : this.out;
    if (!handle) return;
    this.updatePath(this.activePane, handle.view.state.selection.main.head);
  }

  /**
   * 取某个编辑器对应的 IR。
   *
   * 输入区直接用转换结果里的 IR（零成本，且与源文本同一坐标系）；
   * 输出区必须对**显示中的文本**重新解析 —— 它是同语言规范化结果，
   * 与输入不是同一份文本（来源为 Python 时更是另一套语法）。
   */
  private irForPane(pane: 'in' | 'out'): JVal | undefined {
    if (pane === 'in') {
      const r = this.state;
      if (!r || r.status === 'error' || r.status === 'timeout') return undefined;
      // FR-P8：Java 转义串的 Span 落在解码后文本，与源码偏移对不上 —— 宁可不给
      if (r.source === 'java') return undefined;
      return r.ir;
    }
    const text = this.out.getDoc();
    const lang = this.lastGoodLang;
    if (!supportsPath(lang)) return undefined;
    const cache = this.outPathCache;
    if (cache && cache.text === text && cache.lang === lang) return cache.ir ?? undefined;
    const ir = pathIrFor(text, lang);
    this.outPathCache = { text, lang, ir };
    return ir ?? undefined;
  }

  /** 明确不可用的原因；null = 只是没落在元素上，保持上一次即可 */
  private pathUnavailableReason(pane: 'in' | 'out', text: string): string | null {
    if (!text.trim()) return null;
    if (pane === 'in') {
      const r = this.state;
      // 防抖过渡态（内容刚变、结果未出）：别闪，保持上一次
      if (!r) return null;
      if (r.status === 'error' || r.status === 'timeout') return '语法错误，无法定位路径';
      if (r.source === 'java') return '该格式不支持路径定位';
      return null;
    }
    if (!supportsPath(this.lastGoodLang)) return '该格式不支持路径定位';
    if (text.length > T2) return '文档过大，输出区不提供路径';
    return null;
  }

  private showPath(hit: PathHit): void {
    if (!this.dom.pathBar) return;
    this.dom.pathBar.hidden = false;
    this.pathValue = hit.path;
    this.pathHead = '$';
    this.setPathText(hit.path, false);
    const kind = this.dom.pathKind;
    if (kind) {
      kind.hidden = false;
      kind.textContent = hit.target === 'key' ? '键' : (KIND_LABEL[hit.valueKind] ?? '');
    }
    if (this.dom.pathCopy) this.dom.pathCopy.disabled = false;
  }

  private showPathReason(reason: string): void {
    this.pathValue = '';
    this.pathHead = '';
    if (this.dom.pathBar) this.dom.pathBar.hidden = false;
    this.setPathText(reason, true);
    if (this.dom.pathKind) this.dom.pathKind.hidden = true;
    if (this.dom.pathCopy) this.dom.pathCopy.disabled = true;
    // 禁用态必须把「已复制」的临时文案收回，否则会出现
    //「路径条写着报错、按钮却写着已复制」的自相矛盾画面
    this.resetPathCopyLabel();
  }

  /** 清空（切 tab / 空文档）：回到占位态，且不保留任何可复制内容（FR-P9） */
  private clearPath(): void {
    this.pathValue = '';
    this.pathHead = '';
    if (this.dom.pathBar) this.dom.pathBar.hidden = this.tab === 'escape';
    this.setPathText(PATH_PLACEHOLDER, true);
    if (this.dom.pathKind) this.dom.pathKind.hidden = true;
    if (this.dom.pathCopy) this.dom.pathCopy.disabled = true;
    this.resetPathCopyLabel();
  }

  private resetPathCopyLabel(): void {
    if (this.pathCopyTimer) {
      window.clearTimeout(this.pathCopyTimer);
      this.pathCopyTimer = undefined;
    }
    const btn = this.dom.pathCopy;
    if (!btn) return;
    btn.textContent = '复制';
    btn.classList.remove('btn--flash');
  }

  private setPathText(text: string, empty: boolean): void {
    const el = this.dom.pathText;
    if (!el) return;
    this.pathShown = text;
    el.classList.toggle('pathbar__path--empty', empty);
    el.title = text;
    this.fitPath();
  }

  /**
   * 溢出时中段省略 `$…userName`。
   *
   * 不能用 CSS 的 text-overflow：它保留开头、砍掉结尾，而路径**尾部才是最具体的
   * 那一段字段**，砍尾等于把有用信息全砍掉。切分按 Unicode 码点（与 FR-F4 同口径）。
   *
   * v1.5 / D7：由线性递减改为**二分查找**。保留的尾部越长文本越宽（单调），
   * 可二分求「不溢出的最大保留长度」—— 原来 O(n) 次写 DOM + 读 scrollWidth
   * （每次读都强制同步重排），长路径下光标每动一次就是几十次 reflow。
   */
  private fitPath(): void {
    const el = this.dom.pathText;
    if (!el) return;
    const text = this.pathShown;
    if (!text) return;
    el.textContent = text;
    const avail = el.clientWidth;
    // 未布局（jsdom / 首帧）时保留完整文本，绝不写出半截
    if (avail === 0) return;
    if (el.scrollWidth <= avail) return;
    const chars = [...text];
    const prefix = this.pathHead ? this.pathHead + '…' : '…';
    // 二分：找最大的 keep 使 prefix + 尾部 keep 个字符仍放得下
    let lo = 1;
    let hi = chars.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.textContent = prefix + chars.slice(chars.length - mid).join('');
      if (el.scrollWidth <= avail) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    el.textContent = best > 0 ? prefix + chars.slice(chars.length - best).join('') : prefix;
  }

  private async copyPath(): Promise<void> {
    if (!this.pathValue) return;
    const res = await copyText(this.pathValue);
    const btn = this.dom.pathCopy;
    if (!btn) return;
    if (res.ok) {
      btn.textContent = '已复制';
      btn.classList.remove('btn--flash');
      void btn.offsetWidth;
      btn.classList.add('btn--flash');
      if (this.pathCopyTimer) window.clearTimeout(this.pathCopyTimer);
      this.pathCopyTimer = window.setTimeout(() => {
        this.pathCopyTimer = undefined;
        btn.textContent = '复制';
        btn.classList.remove('btn--flash');
      }, 1200);
      return;
    }
    // 自动复制失败：全选路径文本，引导手动复制（与 FR-E6 同款兜底）
    if (this.dom.pathText) selectAllIn(this.dom.pathText);
    this.setStatus(res.message, 'error');
  }

  // ── v1.5 全局快捷键（D27 / K1~K3） ────────────────────────────────

  /**
   * 全局键位（均在编辑器**外**仍可用）：
   *  Alt+1/2/3 直达 tab；Alt+T 打开标签页（panel 形态）；
   *  Alt+C 复制输出、Alt+S 下载、Alt+A 全选输出并聚焦
   *  （K2：CM6 的 Ctrl+A 只全选当前编辑器，两个编辑器同页时用它直达输出）。
   *  v1.5.1：主键位从 Mod+Shift+C/S/A 改为 Alt+…，因为前三者是 Chrome 保留键；
   *  旧键位仍作兼容保留。所有 Alt 组合按 e.code 判定（macOS Option 会改写 e.key）。
   *  Esc：先关对比浮层 / 自绘菜单；焦点不在编辑器内且为侧边栏形态时关闭侧边栏
   *  （K3：编辑器内的 Esc 保留 CM6 的「简化选区」语义，绝不抢）。
   *  v1.5.1：有输入时首次 Esc 只警告，3s 内再按一次才关，避免误触丢内容。
   */
  private bindGlobalKeys(): void {
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      // v1.5.1 / N02：macOS 下 Option+1/2/3/T 的 e.key 是 ¡/™/£/† 等特殊字符，
      // 必须优先按物理键位 e.code 判定；e.key 仅作无 code（jsdom / 老浏览器）时兜底。
      const codeDigit = /^Digit[0-9]$/.test(e.code) ? e.code.slice(5) : '';
      const digit = codeDigit || (/^[1-3]$/.test(e.key) ? e.key : '');
      if (e.altKey && !mod && !e.shiftKey && ['1', '2', '3'].includes(digit)) {
        e.preventDefault();
        const id = TAB_ORDER[Number(digit) - 1];
        this.switchTab(id);
        const btn = id === 'format' ? this.dom.tabFormat : id === 'escape' ? this.dom.tabEscape : this.dom.tabConvert;
        btn?.focus();
        return;
      }
      const isAltT = e.code === 'KeyT' || e.key === 't' || e.key === 'T' || e.key === '†';
      if (e.altKey && !mod && isAltT) {
        if (this.opts.surface === 'panel') {
          e.preventDefault();
          void this.handleEnlarge();
        }
        return;
      }
      // v1.5.1 / N03：Mod+Shift+C / A 在 Chrome 里分别是 DevTools Inspect 与
      // Tab Search，网页根本收不到 keydown；S 在部分宿主同样被占用。
      // 主键位改为 Alt+C/S/A（仍用 e.code 判定以兼容 macOS 的 Option 组合）。
      const altCode = /^Key[CSA]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
      const altLetter = altCode || (/^[csa]$/i.test(e.key) ? e.key.toLowerCase() : '');
      if (e.altKey && !mod && !e.shiftKey && ['c', 's', 'a'].includes(altLetter)) {
        e.preventDefault();
        if (altLetter === 'c') void this.handleCopy();
        else if (altLetter === 's') this.dom.btnDownload.click();
        else this.selectAllOutput();
        return;
      }
      // 旧键位保留作兼容：Chrome 通常收不到，其他宿主可能可达。
      if (mod && e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') {
          e.preventDefault();
          void this.handleCopy();
          return;
        }
        if (k === 's') {
          e.preventDefault();
          this.dom.btnDownload.click();
          return;
        }
        if (k === 'a') {
          e.preventDefault();
          this.selectAllOutput();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (this.closeCompare()) {
          e.preventDefault();
          return;
        }
        if (closeOpenSelect()) return;
        const focusInCm = (document.activeElement as HTMLElement | null)?.closest?.('.cm-editor');
        if (!focusInCm && this.opts.surface === 'panel') {
          e.preventDefault();
          // v1.5.1 / N05：非空输入时误按 Esc 会直接卸载 panel.html，输入零落盘、
          // 重开无法恢复。首次只给明确警告，3s 内再按一次才真正关闭；
          // 空输入仍保持原来的一键关闭。
          const now = Date.now();
          if (this.in.getDoc().trim() && now - this.escArmedAt > 3000) {
            this.escArmedAt = now;
            this.setStatus('再按一次 Esc 关闭侧边栏（当前输入将丢失）');
            return;
          }
          this.escArmedAt = 0;
          void closeSidePanel();
        }
      }
    });
  }

  /** K2 的出口：一键全选输出区并聚焦，方便直接 Ctrl+C 手动复制 */
  private selectAllOutput(): void {
    this.out.view.dispatch({ selection: { anchor: 0, head: this.out.view.state.doc.length } });
    this.out.view.focus();
  }

  // ── v1.5 片段（D26）：纯内存，绝不落盘（FR-H4） ──────────────────

  private renderSnippets(): void {
    document.getElementById('snippetBar')?.remove();
    if (this.snippets.length === 0) return;
    const bar = document.createElement('div');
    bar.className = 'snippetbar';
    bar.id = 'snippetBar';
    const tip = document.createElement('span');
    tip.className = 'snippetbar__tip';
    tip.textContent = '片段（仅本会话）：';
    bar.appendChild(tip);
    this.snippets.forEach((s, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'snippetbar__chip';
      chip.dataset.fromTab = s.tab;
      // v1.6 / N16：来自别的 tab 的片段要标出来，避免把转义纯文本误灌进格式化通道
      const from = TAB_TEXT[s.tab];
      chip.title = `来自${from} · ${s.text.slice(0, 200)}`;
      chip.textContent = s.text.replace(/\s+/g, ' ').slice(0, 18) || '(空)';
      chip.setAttribute('aria-label', `片段 ${i + 1}，来自${from}`);
      chip.addEventListener('click', () => {
        this.setInput(s.text);
        this.setStatus(s.tab === this.tab ? `已载入片段 ${i + 1}` : `已载入${from}的片段 ${i + 1}（注意来源通道不同）`);
      });
      bar.appendChild(chip);
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn--ghost snippetbar__clear';
    clear.textContent = '清空片段';
    clear.addEventListener('click', () => {
      this.snippets = [];
      this.renderSnippets();
    });
    bar.appendChild(clear);
    this.mountBar(bar);
  }

  // ── v1.5 对比浮层（D26）：并排显示输入与输出，行级标记差异 ─────────

  private compareEl: HTMLElement | null = null;

  private openCompare(): void {
    this.closeCompare();
    const inText = this.in.getDoc();
    const outText = this.tab === 'escape' ? this.escapeOutput : (this.state?.output ?? '');
    if (!inText.trim() && !outText) {
      this.setStatus('没有可对比的内容');
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'cmp';
    overlay.id = 'compareOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '输入与输出对比');
    // v1.6 / N12：逐行同步生成两列 div，大文本会瞬间创建数十万节点。
    // 完整 diff 算法留待后续；这里先给硬上限 + 明确截断提示，保证界面不卡死。
    if (inText.length + outText.length > 200_000) {
      this.setStatus('内容过大，暂不支持并排对比（请用放大页或拆分文本）');
      return;
    }
    const inLines = inText.split('\n');
    const outLines = outText.split('\n');
    const MAX_ROWS = 400;
    const total = Math.max(inLines.length, outLines.length);
    const rows = Math.min(total, MAX_ROWS);
    const head = document.createElement('div');
    head.className = 'cmp__head';
    const title = document.createElement('span');
    title.className = 'cmp__title';
    title.textContent =
      `对比：输入 ${inLines.length} 行 · 输出 ${outLines.length} 行（高亮 = 与对侧同位置不同）` +
      (total > MAX_ROWS ? ` · 仅显示前 ${MAX_ROWS} 行` : '');
    head.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn--ghost';
    closeBtn.textContent = '关闭 (Esc)';
    closeBtn.addEventListener('click', () => this.closeCompare());
    head.appendChild(closeBtn);
    overlay.appendChild(head);
    const body = document.createElement('div');
    body.className = 'cmp__body';
    const left = document.createElement('pre');
    const right = document.createElement('pre');
    left.className = 'cmp__col';
    right.className = 'cmp__col';
    for (let i = 0; i < rows; i++) {
      const a = inLines[i];
      const b = outLines[i];
      for (const [col, line] of [
        [left, a],
        [right, b],
      ] as Array<[HTMLElement, string | undefined]>) {
        const div = document.createElement('div');
        div.className = 'cmp__row' + (a !== b ? ' cmp__row--diff' : '');
        div.textContent = line ?? '';
        col.appendChild(div);
      }
    }
    body.appendChild(left);
    body.appendChild(right);
    overlay.appendChild(body);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeCompare();
    });
    document.body.appendChild(overlay);
    this.compareEl = overlay;
  }

  private closeCompare(): boolean {
    if (!this.compareEl) return false;
    this.compareEl.remove();
    this.compareEl = null;
    return true;
  }

  /** 切换 tab（FR-L1 / FR-L4 / FR-L3） */
  switchTab(id: TabId): void {
    // v1.6 / N16：对比浮层是上一个 tab 的输入/输出快照，切 tab 必须关掉，
    // 否则用户看到的是「旧通道的两列内容」且标题还写着当前状态。
    this.closeCompare();
    if (id === this.tab) {
      // v1.2：重复点同一 tab 也要收起动画，避免残留
      this.endBoot();
      return;
    }
    if (this.timer) window.clearTimeout(this.timer);
    this.workspaces[this.tab] = {
      input: this.in.getDoc(), locked: this.locked, overrides: [...this.panel.overrides()],
      strippedPrefix: this.strippedPrefix, lastGoodOutput: this.lastGoodOutput, lastGoodLang: this.lastGoodLang,
    };
    this.tab = id;
    const workspace = this.workspaces[id];
    this.suppressInput = true;
    try { this.in.setDoc(workspace?.input ?? ''); } finally { this.suppressInput = false; }
    this.setLocked(workspace?.locked ?? null);
    this.panel.clear();
    for (const [path, type] of workspace?.overrides ?? []) this.panel.setOverride(path, type);
    this.state = null;
    this.escapeOutput = '';
    this.lastGoodOutput = workspace?.lastGoodOutput ?? '';
    this.lastGoodLang = workspace?.lastGoodLang ?? 'json';
    // 换 tab 即作废「已确认剥离的前缀」——它是针对上一次输入的决定
    this.strippedPrefix = workspace?.strippedPrefix ?? '';
    this.clearPrefixHint();
    this.endBoot();
    this.renderTabs();
    this.syncTabControls();
    void this.persist();
    this.run(this.in.getDoc());
    // v1.4：切 tab 会把光标重置到 0，此时算出的路径不是用户的意图 —— 回到占位（AC-97）
    this.clearPath();
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
      btn.tabIndex = on ? 0 : -1;
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
    // v1.5.1 / N07：转义 tab 是纯文本通道，来源标签与「手动锁定」徽标都得收起，
    // 否则会残留上一个 tab 的格式语义（或「待输入」这种无意义文案）。
    this.dom.fmtLabel.hidden = isEscape;
    this.dom.lockBadge.hidden = isEscape || this.locked === null;
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
    // v1.5 / D3：包裹外层引号只在转义 tab 显示
    if (this.dom.wrapQuotesWrap) this.dom.wrapQuotesWrap.hidden = !isEscape;
    // v1.5.1 / N15：该开关只在 encode 分支生效（escapeText.ts:278），
    // decode 时禁用并说明，别让用户勾了却看不到任何效果。
    if (this.dom.wrapQuotes) {
      const usable = isEscape && this.escapeDir === 'encode';
      this.dom.wrapQuotes.disabled = !usable;
      this.dom.wrapQuotes.title = usable ? '' : '仅「增加转义」方向可包裹外层引号';
      this.dom.wrapQuotesWrap?.classList.toggle('is-disabled', !usable);
    }
    for (const [btn, dir] of [
      [this.dom.escapeDirDecode, 'decode'],
      [this.dom.escapeDirEncode, 'encode'],
    ] as Array<[HTMLElement | undefined, EscapeDir]>) {
      if (!btn) continue;
      const on = dir === this.escapeDir;
      btn.classList.toggle('seg__btn--on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // 转义 tab 用「反向：xxx」替代「转换」—— 文案明确说出会变成哪个方向；
    // 非转义 tab：超大文本时恢复本名「转换」（实时转换已关，它是唯一入口），
    // 其余时候叫「重新转换」（实时转换已给出结果，它只是手动重跑）。D16。
    if (isEscape) {
      this.dom.btnConvert.textContent = '反向：' + ESCAPE_DIR_LABEL[oppositeDir(this.escapeDir)];
    } else {
      this.dom.btnConvert.textContent = this.oversize ? '转换' : '重新转换';
    }
    // v1.5 / D6：档位按钮仍只在格式化 tab；「美化/压缩」开放到转换 tab
    // （转换 tab 原先只能输出 2 空格缩进，压不成一行）。
    this.dom.btnFormat.hidden = !isFormat;
    this.dom.btnCompact.hidden = isEscape;
    if (isFormat) {
      this.dom.btnFormat.textContent = this.strict ? '档位：严格' : '档位：容错';
      this.dom.btnCompact.textContent = this.compact ? '缩进：压缩' : '缩进：美化';
    } else {
      // 转换 tab：单按钮直接切换（同一按钮来回按）
      this.dom.btnCompact.textContent = this.compact ? '美化' : '压缩';
    }
    // v1.5 / D26：片段 / 对比在转义 tab 也可用（对比同样有意义：原文 vs 转义结果）
    if (this.dom.btnSnippet) this.dom.btnSnippet.hidden = false;
    if (this.dom.btnCompare) this.dom.btnCompare.hidden = false;
    for (const select of this.selects) select.sync();
    const arrow = this.dom.root?.querySelector<HTMLElement>('.detectbar__arrow');
    if (arrow) arrow.hidden = isFormat || isEscape;
    // v1.5 / D25：路径条在格式化与转换 tab 出现（转义 tab 是纯文本通道）；切出即隐藏并清空
    if (this.dom.pathBar) {
      this.dom.pathBar.hidden = isEscape;
      if (isEscape) this.clearPath();
    }
    // v1.5 / D11：tabpanel 的 labelledby 动态指向当前选中的 tab
    const activeTabId = this.tab === 'format' ? 'tabFormat' : this.tab === 'escape' ? 'tabEscape' : 'tabConvert';
    this.dom.paneIn?.setAttribute('aria-labelledby', activeTabId);
    this.dom.paneOut?.setAttribute('aria-labelledby', activeTabId);
    // v1.5 / D1：格式化 tab 下 Map 来源的回退标签（run 里更新文案与显隐）
    this.syncSameTargetLabel();
  }

  /** v1.5 / D1：格式化 tab 且来源为 Map 时，明示「→ Python 字面量」 */
  private syncSameTargetLabel(): void {
    const label = this.dom.sameTargetLabel;
    if (!label) return;
    const r = this.state;
    const show =
      this.tab === 'format' &&
      !!r &&
      r.status !== 'error' &&
      r.status !== 'timeout' &&
      r.source === 'map' &&
      r.sameTargetFallback === true;
    label.hidden = !show;
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

  /** 统一维护「手动锁定」状态与判定条标记（FR-B5/B7/B10）
   *  v1.5 / D8：不再递增 prefsRevision —— 锁定来源不是持久化偏好，
   *  不应让迟到的 prefs 补齐整个作废。 */
  private setLocked(v: SourceFormat | null): void {
    this.locked = v;
    this.dom.lockBadge.hidden = v === null;
    this.dom.resetAuto.hidden = v === null;
  }

  private async persist(): Promise<void> {
    // v1.5 / D8：prefsRevision 只在「显式偏好变更」时递增（persist 是唯一调用点），
    // applyPrefsWhenReady 靠它识别「prefs 已过期，不要覆盖用户的新选择」。
    this.prefsRevision++;
    await savePrefs({
      splitRatio: this.splitRatio,
      compact: this.compact,
      tab: this.tab,
      target: this.target,
      strict: this.strict,
      escapeDir: this.escapeDir,
      wrapQuotes: this.wrapQuotes,
      hintWidth: this.hintWidthDismissed,
    });
  }

  private schedule(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.strippedPrefix = '';
    this.clearPrefixHint();
    this.clearSuggestion();
    this.state = null;
    this.escapeOutput = '';
    this.setButtons(false);
    this.dom.staleBadge.hidden = !this.lastGoodOutput;
    this.dom.editorOut.classList.toggle('is-stale', !!this.lastGoodOutput);
    const text = this.in.getDoc();
    const chars = computeStats(text).chars;
    if (!text.trim()) {
      this.panel.clear();
      this.setLocked(null);
    }
    // CodeMirror 的更新回调不能同步发起第二次编辑器更新。
    queueMicrotask(() => {
      if (this.in.getDoc() !== text) return;
      this.in.setHighlight(chars <= T1);
      this.out.setHighlight(chars <= T1);
    });
    // v1.5.1 / N01：闸门抽成单一入口，schedule 与 setInput 共用
    if (this.guardOversize(text, chars)) return;
    this.setStatus('待处理');
    this.timer = window.setTimeout(() => this.run(this.in.getDoc()), chars > T1 ? 300 : 200);
  }

  /**
   * v1.5.1 / N01：超大文本闸门的**唯一实现**。
   *
   * 原缺陷：只有 schedule()（编辑器 onChange）会拦，setInput()（空态示例 / 片段 /
   * 拖文件 / 放大页交接）随后直接调 run()，既撤掉提示条又同步跑全量转换。
   * 现在所有「写入输入」的路径都必须先过这里；显式入口（「转换」按钮、
   * 「仍要转换」）仍然直接调 run()，它们本就是用户主动放行的大文本转换。
   *
   * @returns true 表示已拦截，调用方必须立即 return
   */
  private guardOversize(text: string, chars = computeStats(text).chars): boolean {
    if (chars > T2) {
      this.oversize = true;
      this.syncTabControls();
      this.renderOversizeHint();
      this.setStatus('文本过大，已关闭实时转换');
      return true;
    }
    this.oversize = false;
    this.clearOversizeHint();
    this.syncTabControls();
    return false;
  }

  /** v1.5 / D19：「文本过大」提示条 + 仍要转换的一键入口 */
  private renderOversizeHint(): void {
    if (document.getElementById('oversizeBox')) return; // 大文本连续输入时只建一次
    const box = document.createElement('div');
    box.className = 'suggest';
    box.id = 'oversizeBox';
    box.setAttribute('role', 'status');
    const tip = document.createElement('span');
    tip.className = 'suggest__tip';
    tip.textContent = '文本过大，已关闭实时转换。仍要转换吗？';
    box.appendChild(tip);
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost suggest__btn';
    btn.type = 'button';
    btn.textContent = '仍要转换';
    btn.addEventListener('click', () => {
      this.clearOversizeHint();
      this.setStatus('正在转换大文本…');
      // 大文本转换放下一帧，先把「正在转换」画出来
      window.setTimeout(() => this.run(this.in.getDoc()), 30);
    });
    box.appendChild(btn);
    this.mountBar(box);
  }

  private clearOversizeHint(): void {
    document.getElementById('oversizeBox')?.remove();
  }

  /** 执行一次处理：按当前 tab 分派到对应链路（FR-L1 / FR-L4） */
  run(text: string): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (text.trim() === '') {
      this.state = null;
      this.escapeOutput = '';
      this.lastGoodOutput = '';
      this.strippedPrefix = '';
      this.renderEmpty();
      return;
    }

    // v1.5 / D12：有输入就撤掉空态示例层
    if (this.dom.emptyHints) this.dom.emptyHints.hidden = true;
    this.clearOversizeHint();

    const chars = computeStats(text).chars; // v1.5.1 / N09：不再物化 [...text] 数组

    // 性能降级（FR-G3）：关闭高亮，不重建编辑器（D-4）
    const highlightOn = chars <= T1;
    this.in.setHighlight(highlightOn);
    this.out.setHighlight(highlightOn);

    // v1.2：大文本时一并关掉装饰性动效（FR-G3/G4 精神：保住输入流畅度）
    this.dom.root?.classList.toggle('is-lite', !highlightOn);

    if (this.tab === 'escape') {
      this.clearPrefixHint();
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
    for (const select of this.selects) select.sync();

    // 编辑器语言随输出方向切换
    this.out.setLang(result.outputLang);

    if (result.status === 'error') {
      // FR-D6/D7：高亮出错行 + 保留上一次成功结果置灰 + 禁用复制/下载
      this.dom.typePanel.hidden = true;
      this.syncSameTargetLabel(); // v1.5 / D1：失败态不显示回退标签
      if (result.ir) this.renderTypePanel(result);
      this.out.setDoc(this.lastGoodOutput);
      this.dom.staleBadge.hidden = !this.lastGoodOutput;
      this.dom.editorOut.classList.add('is-stale');
      this.setButtons(false);
      const e = result.error;
      this.setStatus(e ? e.message : '解析失败', 'error');
      if (e) this.in.highlightLine(e.line);
      this.setFixbar(null, result);
      this.renderSuggestion(text, result);
      // FR-D13：疑似日志前缀 → 给一键剥离入口（只在报错时建议，绝不自动剥）
      this.renderPrefixHint(result);
      // v1.4 / AC-99：输入区失去定位能力（提示原因并禁用复制），输出区仍是上次结果，可继续定位
      this.refreshPathForActive();
      return;
    }

    if (result.status === 'timeout') {
      this.out.setDoc(this.lastGoodOutput);
      this.dom.staleBadge.hidden = !this.lastGoodOutput;
      this.dom.editorOut.classList.toggle('is-stale', !!this.lastGoodOutput);
      this.dom.typePanel.hidden = true;
      this.clearPrefixHint();
      this.clearSuggestion();
      this.setFixbar(null, result);
      this.setStatus('转换超时，建议用放大页面或拆分文本', 'error');
      this.setButtons(false);
      this.refreshPathForActive();
      return;
    }

    // 成功路径：清除失败态（AC-23 —— 用户补齐后角标移除、按钮解禁）
    this.panel.retain(new Set(result.values.map((value) => value.path)));
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
    } else if (result.sameTargetFallback) {
      // v1.5 / D1：格式化 tab 下 Map 来源没有对应序列化器，回退 Python 输出。
      // 这是唯一一种「输出语言 ≠ 来源语言」的静默变化 —— 必须在状态条说破。
      this.setStatus(`Map.toString() 不作输出目标（有损），已按 Python 字面量输出`);
    } else {
      this.setStatus(result.fixes.length ? `已修正 · ${FORMAT_TEXT[result.outputLang]}` : `已完成 · ${FORMAT_TEXT[result.outputLang]}`);
    }

    this.clearSuggestion();
    this.clearPrefixHint();
    this.syncSameTargetLabel();

    // 类型面板（FR-C11 / D-2）
    this.renderTypePanel(result);
    // v1.4：结果换了，光标所在的元素可能也换了
    this.refreshPathForActive();
  }

  /**
   * 转义 tab 链路（FR-I1～I4）
   *
   * 【与转换链路的本质区别】这是**纯字符串**通道（文本 → 文本），
   * 不经过 IR —— 绝不尝试解析输入结构。
   */
  private runEscape(text: string): void {
    const res = escapeText(text, this.escapeStyle, this.escapeDir, { wrapQuotes: this.wrapQuotes });
    this.escapeOutput = res.output;
    this.escapeError = res.error;

    if (!res.ok) {
      // FR-I3：失败不返回部分结果，保留旧输出置灰 + 禁用复制/下载
      this.dom.typePanel.hidden = true;
      this.out.setDoc(this.lastGoodOutput);
      this.dom.staleBadge.hidden = !this.lastGoodOutput;
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
    // v1.6 / N16：转义输出是纯文本，不该沿用上一通道的 JSON/Python 语法高亮。
    // EditorLang 的 'java' 是「无高亮」档（见 editor.ts / FR-A18）。
    this.out.setLang('java');
    this.dom.staleBadge.hidden = true;
    this.dom.editorOut.classList.remove('is-stale');
    this.in.clearHighlight();
    this.setButtons(true);
    this.setFixbar(null, { duplicates: undefined } as unknown as ConvertResult);
    // FR-I6：剥了外层引号必须说出来，让操作可追溯
    this.setStatus(res.note ?? '已完成');
    this.clearSuggestion();
    this.dom.typePanel.hidden = true;
    this.updateStats(text, res.output);
  }

  private renderTypePanel(r: ConvertResult): void {
    // v1.5 / D20：类型调整开放到转换 tab 的所有来源。
    // overrides.ts 本来就是通用实现（对任意 IR 生效），原先只有 Map 有 UI 入口；
    // 「把 1 当字符串 '1'」在跨语言转换里同样是真实需求。
    // 格式化 tab 仍保持 Map 专属（同语言规范化没有类型歧义要修）。
    const allowed =
      this.tab === 'convert' ||
      (this.tab === 'format' && r.source === 'map');
    if (!allowed) {
      this.dom.typePanel.hidden = true;
      return;
    }
    this.panel.render(this.dom.typePanel, r, () => {
      this.run(this.in.getDoc());
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
   *
   * v1.5 / D5：格式化 tab 默认就是严格档，而最常见的修复其实是「切容错档」——
   * 原先建议条只会劝用户换来源格式。现在两条建议并列给出。
   */
  private renderSuggestion(text: string, r: ConvertResult): void {
    this.clearSuggestion();
    if (r.status !== 'error') return;

    const box = document.createElement('div');
    box.className = 'suggest';
    box.id = 'suggestBox';
    box.setAttribute('role', 'status');
    let hasAny = false;

    if (this.tab === 'format' && this.strict) {
      const tip = document.createElement('span');
      tip.className = 'suggest__tip';
      tip.textContent = '严格档下任何偏差都报错：';
      box.appendChild(tip);
      const btn = document.createElement('button');
      btn.className = 'btn btn--ghost suggest__btn';
      btn.type = 'button';
      btn.textContent = '改用容错档重试';
      btn.title = '容错档会自动修复尾随逗号 / 单引号 / 裸键名等常见偏差';
      btn.addEventListener('click', () => {
        if (this.strict) this.toggleStrict(); // toggleStrict 内部会重跑
      });
      box.appendChild(btn);
      hasAny = true;
    }

    if (!this.locked) {
      const list = suggestFormats(text, r.source, 2);
      if (list.length > 0) {
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
        hasAny = true;
      }
    }

    if (hasAny) this.mountBar(box);
  }

  private clearSuggestion(): void {
    document.getElementById('suggestBox')?.remove();
  }

  /**
   * 把建议条挂成「工具栏上方的独立一条」。
   *
   * v1.4 自测发现：原先挂在 `.status` 里（inline-flex 且不换行），
   * 360px 下第二个建议按钮会被裁掉右半边。这是 v1.0 起就存在的布局缺陷，
   * 只是要「报错 + 未锁定来源 + 窄侧边栏」三个条件同时成立才会显形 ——
   * 因此历次三档宽度验收都没碰到。
   */
  private mountBar(box: HTMLElement): void {
    const toolbar = this.dom.statusMsg.closest('.toolbar');
    if (toolbar?.parentElement) {
      toolbar.parentElement.insertBefore(box, toolbar);
      return;
    }
    this.dom.statusMsg.parentElement?.insertBefore(box, this.dom.statusMsg);
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
    box.setAttribute('role', 'status'); // v1.5 / D11：读屏可感知

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

    this.mountBar(box);
  }

  private clearPrefixHint(): void {
    document.getElementById('prefixHintBox')?.remove();
  }

  private setButtons(enabled: boolean): void {
    // FR-E8：无有效输出时全部禁用；失败态仅「转换」可用（FR-D7）
    this.dom.btnCopy.disabled = !enabled;
    this.dom.btnDownload.disabled = !enabled;
    this.dom.btnFormat.disabled = false;
    this.dom.btnCompact.disabled = false;
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
    this.clearPrefixHint();
    this.clearOversizeHint();
    this.clearPath();
    // v1.5 / D12：空态给一键示例，并撤掉判定条上误导性的「标准 JSON」默认值
    if (this.dom.emptyHints) this.dom.emptyHints.hidden = false;
    this.dom.fmtLabel.textContent = '待输入';
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
      this.out.view.dispatch({ selection: { anchor: 0, head: this.out.view.state.doc.length } });
      this.out.view.focus();
      this.setStatus(res.message, 'error');
    }
  }

  /** C-1 / FR-F6：window.open，不用 chrome.tabs.create（AC-49 禁令） */
  private async handleEnlarge(): Promise<void> {
    if (this.enlarging) return;
    this.enlarging = true;
    if (this.dom.enlarge) this.dom.enlarge.disabled = true;
    const sessionId = crypto.randomUUID();
    const workspaces: Record<string, WorkspaceState> = {};
    for (const [id, workspace] of Object.entries(this.workspaces)) {
      workspaces[id] = { input: workspace.input, source: workspace.locked ?? undefined, locked: !!workspace.locked, overrides: workspace.overrides, strippedPrefix: workspace.strippedPrefix };
    }
    try {
      const written = await writeSession({
        workspaces,
        strippedPrefix: this.strippedPrefix,
        input: this.in.getDoc(),
        source: this.locked ?? this.state?.source,
        locked: this.locked !== null,
        compact: this.compact,
        overrides: [...this.panel.overrides().entries()],
        // O-9：不带这三个，放大页会跳回默认 tab
        tab: this.tab,
        target: this.target,
        strict: this.strict,
        escapeStyle: this.escapeStyle,
        escapeDir: this.escapeDir,
        wrapQuotes: this.wrapQuotes,
      }, sessionId);
      if (!written) {
        this.setStatus('会话交接失败，请重试；当前输入已保留', 'error');
        return;
      }
      const opened = window.open(chrome.runtime.getURL('app.html') + '#' + sessionId, '_blank');
      if (!opened) {
        await discardSession(sessionId);
        this.setStatus('标签页未能打开，当前输入已保留', 'error');
        return;
      }

      // v1.3.1：新开标签页后必须关掉侧边栏，否则屏幕上同时存在两个扩展实例，
      // 侧边栏那份还白占 320~360px（用户实测反馈的问题 2）。
      // tab 形态本来就是整屏，没有面板可关。
      if (this.opts.surface === 'panel') {
        await closeSidePanel();
      }
    } catch {
      await discardSession(sessionId);
      this.setStatus('标签页交接失败，当前输入已保留', 'error');
    } finally {
      this.enlarging = false;
      if (this.dom.enlarge) this.dom.enlarge.disabled = false;
    }
  }

  /**
   * 宽度引导条的显隐（v1.3.1）
   *
   * Chrome 侧边栏宽度**没有 API**：默认约 360px、最小硬底约 320px，
   * 只能用户手动拖边缘，扩展既不能设置也不能让它随窗口自适应。
   * 所以「默认占 1/3」做不到，能做的是把这件事说清楚 + 给出一键升级的出口。
   */
  private syncWidthHint(): void {
    const hint = this.dom.widthHint;
    if (!hint) return;
    // 只在侧边栏形态提示；标签页形态已是整屏，提示是噪音
    const show = this.opts.surface === 'panel' && !this.hintWidthDismissed;
    hint.hidden = !show;
  }

  /**
   * 按比例设置输入区高度。
   *
   * 两个要点：
   *  - 用 `setProperty` 而不是 `style.flex = ...`：内联样式的优先级高于样式表，
   *    形态切换时若不显式清除就会残留（v1.2 的隐患）。
   *  - 同时写 minHeight 兜底：`.pane` 是 flex:1 1 0，窄侧边栏下高度紧张时
   *    会被压到 0，输出区随之消失。
   */
  private applySplit(ratio: number): void {
    const splitter = this.dom.splitter;
    if (!splitter) return;
    const container = splitter.parentElement;
    const inPane = container?.querySelector('.pane--in') as HTMLElement | null;
    if (!inPane) return;
    const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
    const containerH = container?.clientHeight ?? 0;
    this.splitRatio = clamped;
    inPane.style.setProperty('flex', String(clamped));
    const outPane = container?.querySelector<HTMLElement>('.pane--out');
    outPane?.style.setProperty('flex', String(1 - clamped));
    splitter.setAttribute('aria-valuemin', String(SPLIT_MIN * 100));
    splitter.setAttribute('aria-valuemax', String(SPLIT_MAX * 100));
    splitter.setAttribute('aria-valuenow', String(clamped * 100));
    // 容器高度未知（jsdom / 首帧）时不写死 minHeight，避免 0 高度锁死布局
    if (containerH > 0) {
      inPane.style.setProperty(
        'min-height',
        `${Math.min(PANE_MIN_PX, Math.round(containerH * clamped * 0.5))}px`,
      );
    }
  }

  /** 清除内联 flex / min-height，回到样式表默认值（形态切换或销毁时用） */
  private clearSplit(): void {
    const splitter = this.dom.splitter;
    const inPane = splitter?.parentElement?.querySelector('.pane--in') as HTMLElement | null;
    if (!inPane) return;
    inPane.style.removeProperty('flex');
    inPane.style.removeProperty('min-height');
    const outPane = splitter?.parentElement?.querySelector<HTMLElement>('.pane--out');
    outPane?.style.removeProperty('flex');
  }

  private startDrag(e: PointerEvent): void {
    const splitter = this.dom.splitter;
    if (!splitter) return;
    splitter.classList.add('is-dragging');
    const container = splitter.parentElement as HTMLElement;
    const startY = e.clientY;
    const startRatio = this.splitRatio;
    const rect = container.getBoundingClientRect();
    // rect.height 在 jsdom 中恒为 0，必须有兜底，否则 ratio 恒为 0
    const inHeight = container.querySelector('.pane--in')?.getBoundingClientRect().height ?? 0;
    const outHeight = container.querySelector('.pane--out')?.getBoundingClientRect().height ?? 0;
    const span = inHeight + outHeight || rect.height || container.clientHeight || 0;
    let last = startRatio;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      last = span > 0 ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, startRatio + dy / span)) : startRatio;
      this.applySplit(last);
    };
    const up = () => {
      splitter.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      void this.persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * splitter 键盘可达（a11y）：ArrowUp/Down 每次微调 5%，
   * Home/End 归到两端。tabindex="0" 早就有了，但一直没绑 keydown。
   */
  private bindSplitterKeys(): void {
    const splitter = this.dom.splitter;
    if (!splitter) return;
    splitter.addEventListener('keydown', (e) => {
      const cur = this.splitRatio;
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowUp':
          next = cur - SPLIT_STEP;
          break;
        case 'ArrowDown':
          next = cur + SPLIT_STEP;
          break;
        case 'Home':
          next = SPLIT_MIN;
          break;
        case 'End':
          next = SPLIT_MAX;
          break;
        default:
          return;
      }
      e.preventDefault();
      this.applySplit(next);
      void this.persist();
    });
  }

  /** 供放大页与外部驱动（自动化测试）写入输入内容 */
  setInput(text: string): void {
    if (!text.trim()) { this.panel.clear(); this.setLocked(null); }
    this.in.setDoc(text); // onChange → schedule()（其中已跑一次闸门）
    // v1.5.1 / N01：四条非 onChange 路径（空态示例 / 片段 / 拖文件 / 放大页交接）
    // 都汇聚到这里，必须显式再过一次闸门。不能只依赖 schedule 的副作用 ——
    // setDoc 遇到相同文本会早退，根本不触发 onChange。
    if (this.guardOversize(text)) return;
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
