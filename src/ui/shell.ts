/**
 * 单一 DOM 模板（v1.3 起）
 *
 * 三形态共用一份模板，形态差异只由 class 与「放大按钮 / 更多菜单」承担。
 *
 * v1.8.0 / 视觉基线：DSH「中性精修」
 *   - 旧 class / id 全部保留（测试、真机脚本与控制器契约依赖它们）；
 *   - 新增的是表现层节点（品牌块、tab 图标、模式 chip、更多菜单、空态引导），
 *     不改变任何业务语义；
 *   - 所有新增节点都通过 qOpt 读取，老测试挂载的精简 DOM 仍可运行。
 *
 * 承载形态：侧边栏 / 独立标签页
 */
import type { DomRefs } from './controller.js';

export type SurfaceKind = 'panel' | 'tab';

/* ---- 内联图标（16 viewBox / 1.5 细线 / currentColor，不引第三方） -------- */
const ICON = {
  braces:
    '<path d="M6 2.5h-.8c-.9 0-1.4.6-1.4 1.5v2c0 .8-.5 1.3-1.3 1.5.8.2 1.3.7 1.3 1.5v2c0 .9.5 1.5 1.4 1.5H6"/><path d="M10 2.5h.8c.9 0 1.4.6 1.4 1.5v2c0 .8.5 1.3 1.3 1.5-.8.2-1.3.7-1.3 1.5v2c0 .9-.5 1.5-1.4 1.5H10"/>',
  format: '<path d="M3 5h10"/><path d="M3 8h7"/><path d="M3 11h9"/>',
  escape: '<path d="M6 4.5 2.5 8 6 11.5"/><path d="M10 4.5 13.5 8 10 11.5"/>',
  convert:
    '<path d="M2.5 5.5h10"/><path d="m10 3 2.5 2.5L10 8"/><path d="M13.5 10.5h-10"/><path d="M6 8 3.5 10.5 6 13"/>',
  expand:
    '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8.5 7.5"/><path d="M6.5 13.5h-4v-4"/><path d="M2.5 13.5l5-5"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.2v3.2"/><path d="M8 5.3h.01"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  download: '<path d="M8 2.5v7"/><path d="M5 7l3 3 3-3"/><path d="M3 12.5h10"/>',
  alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3"/><path d="M8 11.4h.01"/>',
  shield:
    '<path d="M8 2.5 13 4.5v3.4c0 2.7-2 4.7-5 5.6-3-.9-5-2.9-5-5.6V4.5z"/><path d="M6 8l1.5 1.5L10.5 6"/>',
};

function ico(name: keyof typeof ICON, cls = 'ico'): string {
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
}

/** 共用骨架。放大按钮只在 panel 形态出现（tab 形态已在整页，无需再放大）。 */
const TEMPLATE = `
<div class="topbar">
  <div class="brand">
    <span class="brand__badge" aria-hidden="true">${ico('braces')}</span>
    <span class="brand__text">
      <span class="brand__mark">JSON Dialect</span>
      <span class="brand__sub">JSON · PYTHON · JAVA · MAP</span>
    </span>
  </div>

  <nav class="tabbar" role="tablist" aria-label="功能">
    <button class="tab tab--on" id="tabFormat" role="tab" type="button" data-tab="format" aria-selected="true" aria-controls="paneIn paneOut">
      ${ico('format', 'ico tab__ico')}<span class="tab__label">格式化</span>
    </button>
    <button class="tab" id="tabEscape" role="tab" type="button" data-tab="escape" aria-selected="false" aria-controls="paneIn paneOut">
      ${ico('escape', 'ico tab__ico')}<span class="tab__label">转义</span>
    </button>
    <button class="tab" id="tabConvert" role="tab" type="button" data-tab="convert" aria-selected="false" aria-controls="paneIn paneOut">
      ${ico('convert', 'ico tab__ico')}<span class="tab__label">转换</span>
    </button>
  </nav>

  <span class="topbar__spacer"></span>
  <span class="local-pill"><i aria-hidden="true"></i>本地处理</span>
  __ENLARGE__
</div>

__WIDTH_HINT__

<!-- ① 判定条：来源 ▸ 目标（FR-B9/B10 / FR-A17） -->
<header class="detectbar">
  <span class="detectbar__label" id="fmtLabel">
    <span class="detectbar__led" aria-hidden="true"></span>
    <span class="detectbar__text">标准 JSON</span>
  </span>
  <span class="badge" id="lockBadge" hidden>手动锁定</span>
  <!-- v1.5 / D1：格式化 tab 下 Map 来源无对应目标，回退 Python 输出 ——
       这个只读标签把语言变化明示出来，兑现「绝不静默改格式」 -->
  <span class="badge badge--kind" id="sameTargetLabel" hidden title="Map.toString() 不作为输出目标（有损），已按 Python 字面量输出">→ Python 字面量</span>

  <select id="fmtSelect" aria-label="来源格式">
    <option value="json">标准 JSON</option>
    <option value="python">Python 字面量</option>
    <option value="java">Java 转义字符串</option>
    <option value="map">Map.toString()</option>
  </select>

  <button id="resetAuto" class="btn btn--ghost btn--xs" hidden>重置为自动</button>

  <span class="detectbar__arrow" aria-hidden="true">
    <svg class="ico" viewBox="0 0 18 12" aria-hidden="true">
      <path d="M1 6h14" />
      <path d="M11.5 2.5 15.5 6l-4 3.5" />
    </svg>
  </span>

  <select id="targetSelect" aria-label="目标格式">
    <option value="auto">自动</option>
    <option value="json">标准 JSON</option>
    <option value="python">Python 字面量</option>
    <option value="java">Java 转义字符串</option>
  </select>

  <!-- v1.8：格式化 tab 的输出方言提示；Map 回退时显示 → Python 字面量 -->
  <span class="target-hint" id="targetHint" hidden>输出 · 标准 JSON</span>

  <!-- v1.5 / D3：转义风格；JSON 与 Java 的字符串转义表逐字符等价，合并为一个选项 -->
  <select id="escapeStyleSelect" aria-label="转义风格" hidden>
    <option value="json">JSON / Java 字符串</option>
    <option value="url">URL 百分号</option>
    <option value="base64">Base64</option>
  </select>

  <!-- FR-I5：方向是显式的二选一，常驻可见 -->
  <div id="escapeDirSeg" class="seg" role="group" aria-label="转义方向" hidden>
    <button class="seg__btn" id="escapeDirDecode" type="button" data-dir="decode" aria-pressed="false">去除转义</button>
    <button class="seg__btn seg__btn--on" id="escapeDirEncode" type="button" data-dir="encode" aria-pressed="true">增加转义</button>
  </div>

  <label class="wrapq" id="wrapQuotesWrap" hidden>
    <input type="checkbox" id="wrapQuotes" />
    <span>包裹外层引号</span>
  </label>

  <span class="detectbar__spacer"></span>
  <span class="badge badge--plain auto-badge">自动识别</span>
</header>

<!-- ①b 路径条（v1.4 / FR-P9）：只在格式化 / 转换 tab 出现 -->
<div id="pathBar" class="pathbar" hidden tabindex="0" role="group" aria-label="当前元素路径，回车复制">
  <span class="pathbar__label">路径</span>
  <code class="pathbar__path pathbar__path--empty" id="pathText" role="status" aria-live="polite">点选 JSON 中的键或值</code>
  <span class="badge badge--kind" id="pathKind" hidden></span>
  <span class="pathbar__hint">点击输入或输出中的键 / 值即可定位</span>
  <button id="pathCopy" class="btn btn--ghost btn--xs pathbar__copy" type="button" disabled>复制</button>
</div>

<!-- ② 输入区（可编辑） -->
<section class="pane pane--in" id="paneIn" role="tabpanel" aria-label="输入">
  <div class="pane__head">
    <span class="pane__title">输入</span>
    <span class="pane__kicker">EDIT</span>
    <span class="stats" id="statsIn">行 1 · 字符 0</span>
    <button id="btnClear" class="btn btn--ghost btn--xs pane__clear" type="button" title="清空输入" aria-label="清空输入">清空</button>
  </div>
  <div id="editorIn" class="editor"></div>
  <!-- v1.5 / D12：空态一键示例 —— 点击直接灌进输入区（示例属界面文案，不落盘） -->
  <div id="emptyHints" class="emptyhints" hidden>
    <span class="emptyhints__badge" aria-hidden="true">${ico('braces')}</span>
    <span class="emptyhints__title">粘贴内容，自动识别方言</span>
    <span class="emptyhints__text">JSON · Python 字面量 · Java 转义串 · Map.toString()<br />识别后按同一套规则格式化或转换</span>
    <div class="emptyhints__btns">
      <button class="btn btn--sm" type="button" data-example="json">示例：JSON</button>
      <button class="btn btn--sm" type="button" data-example="python">示例：Python</button>
      <button class="btn btn--sm" type="button" data-example="map">示例：Map</button>
    </div>
    <span class="emptyhints__kbd"><kbd class="kbd">Ctrl / ⌘ V</kbd> 直接粘贴 · 内容不离开本机</span>
  </div>
  <div id="fixbar" class="fixbar" hidden></div>
</section>

<!-- ③ 分隔条（FR-F8） -->
<div id="splitter" class="splitter" role="separator" aria-orientation="horizontal" tabindex="0"
     aria-label="拖动调整输入与输出的高度，方向键微调"></div>

<!-- ④ 输出区（只读） -->
<section class="pane pane--out" id="paneOut" role="tabpanel" aria-label="输出">
  <div class="pane__head">
    <span class="pane__title">输出</span>
    <span class="pane__kicker">READ ONLY</span>
    <span class="stats" id="statsOut">行 1 · 字符 0</span>
    <span class="badge badge--stale" id="staleBadge" hidden>已过期</span>
  </div>
  <div id="editorOut" class="editor editor--out"></div>
  <div id="emptyOut" class="empty-out" hidden>转换结果会实时出现在这里</div>
  <div id="typePanel" class="typepanel" hidden></div>
</section>

<!-- ⑤ 底部操作栏（FR-F5） -->
<footer class="toolbar">
  <span class="status">
    <span class="status__led" id="statusLed" aria-hidden="true"></span>
    <span id="statusMsg" class="statusmsg" aria-live="polite" role="status"></span>
  </span>
  <span class="status__meta" id="statusMeta">容错 · 美化 · 2 空格</span>
  <button class="status__modes" id="modeChip" type="button" aria-expanded="false" title="切换解析档位 / 缩进">容错 · 美化</button>
  <div class="toolbar__actions">
    <button id="btnConvert" class="btn">重新转换</button>
    <button id="btnFormat" class="btn btn--ghost mode-btn" data-short="容错">档位：容错</button>
    <button id="btnCompact" class="btn btn--ghost mode-btn" data-short="美化">缩进：美化</button>
    <button id="btnSnippet" class="btn btn--ghost" title="把当前输入存为片段（仅本次会话内存）">存为片段</button>
    <button id="btnCompare" class="btn btn--ghost" title="并排对比输入与输出">对比</button>
    <span class="toolbar__sep" aria-hidden="true"></span>
    <button id="btnCopy" class="btn btn--primary">
      ${ico('copy')}
      <span class="btn__label" id="copyLabel">复制</span>
    </button>
    <button id="btnDownload" class="btn" title="下载 .json" aria-label="下载 .json">
      ${ico('download')}
      <span class="btn__label" id="downloadLabel">下载 .json</span>
    </button>
    __MORE__
  </div>
  <div id="moreMenu" class="menu more-menu" role="menu" hidden></div>
</footer>
`;

const ENLARGE_BLOCK = `
<div class="topbar__tool">
  <button id="enlarge" class="btn btn--ghost enlarge" title="在标签页中打开（可用整屏宽度）" aria-label="在标签页中打开">
    ${ico('expand')}
    <span class="enlarge__label">标签页</span>
  </button>
</div>`;

const MORE_BLOCK = `
<button id="moreActions" class="btn btn--ghost btn--icon more-trigger" type="button" aria-expanded="false" aria-label="更多操作" title="更多操作">
  ${ico('more')}
</button>`;

/**
 * 宽度引导条（v1.3.1）：只在侧边栏形态渲染。
 *
 * Chrome 侧边栏宽度**没有 API** —— 默认约 360px、最小硬底约 320px，
 * 只能用户手动拖边缘，扩展既不能设置也不能让它随窗口自适应。
 * 「默认占 1/3」做不到，那就把限制说清楚，并给出一键升级到整屏的出口。
 */
const WIDTH_HINT_BLOCK = `
<div id="widthHint" class="widthhint" hidden>
  <span class="widthhint__icon" aria-hidden="true">${ico('info')}</span>
  <span class="widthhint__text">侧边栏宽度由 Chrome 控制（可拖动左边缘调宽）。需要更大空间？点右上角「标签页」。</span>
  <button id="widthHintClose" class="widthhint__close" type="button">知道了</button>
</div>`;

/**
 * 挂载骨架并返回 DOM 引用。
 *
 * 必须在任何 await 之前调用 —— 编辑器创建要抢在 storage 之前（坑 9）。
 */
export function mountShell(surface: SurfaceKind): DomRefs {
  const root = document.getElementById('app');
  if (!root) throw new Error('缺少 DOM 节点: #app');

  const appClass = surface === 'panel' ? 'app app--panel' : 'app app--large';
  root.className = `${appClass} is-booting`;
  root.dataset.channel = 'format';
  root.innerHTML = TEMPLATE.replace('__ENLARGE__', surface === 'panel' ? ENLARGE_BLOCK : '')
    .replace('__WIDTH_HINT__', surface === 'panel' ? WIDTH_HINT_BLOCK : '')
    .replace('__MORE__', surface === 'panel' ? MORE_BLOCK : '');

  const q = <T extends HTMLElement>(id: string): T => {
    const el = root.querySelector(`#${id}`);
    if (!el) throw new Error(`缺少 DOM 节点: #${id}`);
    return el as T;
  };
  const qOpt = <T extends HTMLElement>(id: string): T | undefined =>
    (root.querySelector(`#${id}`) as T | null) ?? undefined;

  return {
    root,
    fmtLabel: q('fmtLabel'),
    lockBadge: q('lockBadge'),
    sameTargetLabel: qOpt('sameTargetLabel'),
    fmtSelect: q<HTMLSelectElement>('fmtSelect'),
    resetAuto: q<HTMLButtonElement>('resetAuto'),
    tabFormat: q<HTMLButtonElement>('tabFormat'),
    tabEscape: q<HTMLButtonElement>('tabEscape'),
    tabConvert: q<HTMLButtonElement>('tabConvert'),
    targetSelect: q<HTMLSelectElement>('targetSelect'),
    escapeStyleSelect: q<HTMLSelectElement>('escapeStyleSelect'),
    escapeDirSeg: q('escapeDirSeg'),
    escapeDirDecode: q<HTMLButtonElement>('escapeDirDecode'),
    escapeDirEncode: q<HTMLButtonElement>('escapeDirEncode'),
    wrapQuotesWrap: qOpt('wrapQuotesWrap'),
    wrapQuotes: qOpt<HTMLInputElement>('wrapQuotes'),
    enlarge: qOpt<HTMLButtonElement>('enlarge'),
    widthHint: qOpt('widthHint'),
    widthHintClose: qOpt<HTMLButtonElement>('widthHintClose'),
    editorIn: q('editorIn'),
    editorOut: q('editorOut'),
    emptyOut: qOpt('emptyOut'),
    emptyHints: qOpt('emptyHints'),
    btnClear: qOpt<HTMLButtonElement>('btnClear'),
    btnSnippet: qOpt<HTMLButtonElement>('btnSnippet'),
    btnCompare: qOpt<HTMLButtonElement>('btnCompare'),
    paneIn: qOpt('paneIn'),
    paneOut: qOpt('paneOut'),
    pathBar: qOpt('pathBar'),
    pathText: qOpt('pathText'),
    pathKind: qOpt('pathKind'),
    pathCopy: qOpt<HTMLButtonElement>('pathCopy'),
    statsIn: q('statsIn'),
    statsOut: q('statsOut'),
    staleBadge: q('staleBadge'),
    fixbar: q('fixbar'),
    typePanel: q('typePanel'),
    statusLed: q('statusLed'),
    statusMsg: q('statusMsg'),
    statusMeta: qOpt('statusMeta'),
    modeChip: qOpt<HTMLButtonElement>('modeChip'),
    targetHint: qOpt('targetHint'),
    downloadLabel: qOpt('downloadLabel'),
    copyLabel: qOpt('copyLabel'),
    btnConvert: q<HTMLButtonElement>('btnConvert'),
    btnFormat: q<HTMLButtonElement>('btnFormat'),
    btnCompact: q<HTMLButtonElement>('btnCompact'),
    btnCopy: q<HTMLButtonElement>('btnCopy'),
    btnDownload: q<HTMLButtonElement>('btnDownload'),
    splitter: q('splitter'),
  };
}