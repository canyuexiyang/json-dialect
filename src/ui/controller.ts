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
import type { SourceFormat } from '../core/types.js';
import { suggestFormats, type FormatSuggestion } from '../core/suggestFormat.js';
import { createEditor, type EditorHandle } from './editor.js';
import { copyText, selectAllIn } from './clipboard.js';
import { downloadText, downloadLabel } from './download.js';
import { loadPrefs, savePrefs, writeSession, type Prefs } from './sessionState.js';
import { createTypePanel, isOverrideType, type OverrideType } from './typeWidgets.js';

export interface DomRefs {
  fmtLabel: HTMLElement;
  lockBadge: HTMLElement;
  fmtSelect: HTMLSelectElement;
  resetAuto: HTMLButtonElement;
  enlarge?: HTMLButtonElement;
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

/** 放大页从 session 继承的会话态（AC-33 / FR-F6） */
export interface InheritedState {
  source?: string;
  locked?: boolean;
  compact?: boolean;
  overrides?: Array<[string, string]>;
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
  private lastGoodLang: 'json' | 'python' = 'json';
  private panel = createTypePanel();
  private dark = false;

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

    this.bindEvents();
    if (initialInput) this.run(initialInput);
    else this.renderEmpty();

    // ── ② 异步段：偏好迟到不影响可用性 ──────────────────────────────────
    // 无继承值时才读 prefs；读取带 1.5s 超时，超时即放弃，绝不阻塞交互。
    if (inherited?.compact === undefined) {
      void this.applyPrefsWhenReady();
    }
  }

  /** 读取界面偏好；超时或失败都按默认值继续，不影响已就绪的 UI */
  private async applyPrefsWhenReady(): Promise<void> {
    const fallback: Prefs = {};
    const prefs = await withTimeout(loadPrefs(), 1500, fallback);
    if (prefs.compact !== undefined && prefs.compact !== this.compact) {
      this.compact = prefs.compact;
      // 已经有输出就按新偏好重渲染一次，保持视觉一致
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

    this.dom.btnConvert.addEventListener('click', () => this.run(this.in.getDoc()));

    this.dom.btnFormat.addEventListener('click', () => {
      this.compact = false;
      this.persist();
      this.run(this.in.getDoc());
    });

    this.dom.btnCompact.addEventListener('click', () => {
      this.compact = true;
      this.persist();
      this.run(this.in.getDoc());
    });

    this.dom.btnCopy.addEventListener('click', () => void this.handleCopy());

    this.dom.btnDownload.addEventListener('click', () => {
      // AC-39：取自 state.output，不取 DOM
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

  /** 统一维护「手动锁定」状态与判定条标记（FR-B5/B7/B10） */
  private setLocked(v: SourceFormat | null): void {
    this.locked = v;
    this.dom.lockBadge.hidden = v === null;
    this.dom.resetAuto.hidden = v === null;
  }

  private async persist(): Promise<void> {
    await savePrefs({ compact: this.compact });
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

  /** 执行一次完整转换 */
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

    const result = convert(text, {
      force: this.locked,
      compact: this.compact,
      overrides: this.panel.overrides(),
      timeoutMs: 3000,
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

    // 类型面板（FR-C11 / D-2）
    this.renderTypePanel(result);
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

  private setButtons(enabled: boolean): void {
    // FR-E8：无有效输出时全部禁用；失败态仅「转换」可用（FR-D7）
    this.dom.btnCopy.disabled = !enabled;
    this.dom.btnDownload.disabled = !enabled;
    this.dom.btnFormat.disabled = !enabled;
    this.dom.btnCompact.disabled = !enabled;
    this.dom.btnConvert.disabled = false;
    this.dom.btnDownload.textContent = downloadLabel(this.lastGoodLang);
  }

  private setStatus(msg: string, kind: 'info' | 'error' = 'info'): void {
    this.dom.statusMsg.textContent = msg;
    this.dom.statusMsg.classList.toggle('statusmsg--error', kind === 'error');
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
    if (!this.state?.output) return;
    const res = await copyText(this.state.output);
    if (res.ok) {
      const old = this.dom.btnCopy.textContent;
      this.dom.btnCopy.textContent = '✓ 已复制';
      setTimeout(() => {
        this.dom.btnCopy.textContent = old;
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
    return this.state?.output ?? '';
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

/** SessionState 里的 source 是 string，需收窄为 SourceFormat */
function isSourceFormat(v: string): v is SourceFormat {
  return v === 'json' || v === 'python' || v === 'java' || v === 'map';
}

export type { FormatSuggestion };
