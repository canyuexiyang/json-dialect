/**
 * 单一 DOM 模板（v1.3）
 *
 * 背景：v1.2 有 popup.html / app.html 两份约 104 行逐字符重复的 DOM，加侧边栏就是三份。
 * 三形态共用一份模板，形态差异只由 class 与「放大按钮在不在」承担 ——
 * 这也正是原先 `isPage` 布尔想表达却从未被读取的东西。
 *
 * 形态枚举替代 `isPage`：布尔无法表达第三态，且 false 语义模糊（是 popup 还是 panel？）。
 */

import type { DomRefs } from './controller.js';

/** 承载形态：侧边栏 / 独立标签页 */
export type SurfaceKind = 'panel' | 'tab';

/** 共用骨架。放大按钮只在 panel 形态出现（tab 形态已在整页，无需再放大）。 */
const TEMPLATE = `
<div class="topbar">
  <div class="brand">
    <span class="brand__mark">JSON DIALECT</span>
    <span class="brand__sub">Dialect Converter</span>
  </div>

  <nav class="tabbar" role="tablist" aria-label="功能">
    <button class="tab tab--on" id="tabFormat" role="tab" type="button" data-tab="format" aria-selected="true">格式化</button>
    <button class="tab" id="tabEscape" role="tab" type="button" data-tab="escape" aria-selected="false">转义</button>
    <button class="tab" id="tabConvert" role="tab" type="button" data-tab="convert" aria-selected="false">转换</button>
  </nav>

  <span class="topbar__spacer"></span>
  __ENLARGE__
</div>

__WIDTH_HINT__

<!-- ① 判定条：来源 ▸ 目标（FR-B9/B10 / FR-A17） -->
<header class="detectbar">
  <span class="detectbar__label" id="fmtLabel">
    <span class="detectbar__led" aria-hidden="true"></span>
    标准 JSON
  </span>
  <span class="badge" id="lockBadge" hidden>手动锁定</span>
  <select id="fmtSelect" aria-label="来源格式">
    <option value="json">标准 JSON</option>
    <option value="python">Python 字面量</option>
    <option value="java">Java 转义字符串</option>
    <option value="map">Map.toString()</option>
  </select>
  <button id="resetAuto" class="btn btn--ghost" hidden>重置为自动</button>
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
  <select id="escapeStyleSelect" aria-label="转义风格" hidden>
    <option value="json">JSON 字符串</option>
    <option value="java">Java 字符串</option>
    <option value="url">URL 百分号</option>
    <option value="base64">Base64</option>
  </select>
  <!-- FR-I5：方向是显式的二选一，常驻可见（不再藏进按钮翻转） -->
  <div id="escapeDirSeg" class="seg" role="group" aria-label="转义方向" hidden>
    <button class="seg__btn" id="escapeDirDecode" type="button" data-dir="decode" aria-pressed="false">去除转义</button>
    <button class="seg__btn seg__btn--on" id="escapeDirEncode" type="button" data-dir="encode" aria-pressed="true">增加转义</button>
  </div>
</header>

<!-- ② 输入区（抬起的台面） -->
<section class="pane pane--in">
  <div class="pane__head">
    <span class="pane__title">输入</span>
    <span class="stats" id="statsIn">行 1 · 字符 0</span>
  </div>
  <div id="editorIn" class="editor"></div>
  <div id="fixbar" class="fixbar" hidden></div>
</section>

<!-- ③ 分隔条（FR-F8） -->
<div id="splitter" class="splitter" role="separator" aria-orientation="horizontal" tabindex="0"
     aria-label="拖动调整输入与输出的高度，方向键微调"></div>

<!-- ④ 输出区（凹进的读数窗） -->
<section class="pane pane--out">
  <div class="pane__head">
    <span class="pane__title">输出</span>
    <span class="stats" id="statsOut">行 1 · 字符 0</span>
    <span class="badge badge--stale" id="staleBadge" hidden>已过期</span>
  </div>
  <div id="editorOut" class="editor editor--out"></div>
  <div id="typePanel" class="typepanel" hidden></div>
</section>

<!-- ⑤ 底部操作栏（FR-F5） -->
<footer class="toolbar">
  <span class="status">
    <span class="status__led" id="statusLed" aria-hidden="true"></span>
    <span id="statusMsg" class="statusmsg"></span>
  </span>
  <div class="toolbar__actions">
    <button id="btnConvert" class="btn">转换</button>
    <button id="btnFormat" class="btn">格式化</button>
    <button id="btnCompact" class="btn">压缩</button>
    <button id="btnCopy" class="btn btn--primary">
      <svg class="ico" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
        <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
      </svg>
      复制
    </button>
    <button id="btnDownload" class="btn">
      <svg class="ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2.5v7.5" />
        <path d="M5 7.5 8 10.5l3-3" />
        <path d="M3 12.5h10" />
      </svg>
      下载
    </button>
  </div>
</footer>
`;

const ENLARGE_BLOCK = `
<div class="topbar__tool">
  <button id="enlarge" class="btn btn--ghost" title="在标签页中打开（可用整屏宽度）" aria-label="在标签页中打开">
    <svg class="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5" />
      <path d="M6.5 13.5h-4v-4M2.5 13.5l5-5" />
    </svg>
    标签页
  </button>
</div>`;

/**
 * 宽度引导条（v1.3.1）：只在侧边栏形态渲染。
 *
 * Chrome 侧边栏宽度**没有 API** —— 默认约 360px、最小硬底约 320px，
 * 只能用户手动拖边缘，扩展既不能设置也不能让它随窗口自适应。
 * 「默认占 1/3」做不到，那就把限制说清楚，并给出一键升级到整屏的出口。
 */
const WIDTH_HINT_BLOCK = `
<div id="widthHint" class="widthhint" hidden>
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
    .replace('__WIDTH_HINT__', surface === 'panel' ? WIDTH_HINT_BLOCK : '');

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
    // 标签页形态没有放大按钮 —— 传undefined 让 controller 走可选链
    enlarge: qOpt<HTMLButtonElement>('enlarge'),
    // 宽度引导条同样只在侧边栏形态存在
    widthHint: qOpt('widthHint'),
    widthHintClose: qOpt<HTMLButtonElement>('widthHintClose'),
    editorIn: q('editorIn'),
    editorOut: q('editorOut'),
    statsIn: q('statsIn'),
    statsOut: q('statsOut'),
    staleBadge: q('staleBadge'),
    fixbar: q('fixbar'),
    typePanel: q('typePanel'),
    statusLed: q('statusLed'),
    statusMsg: q('statusMsg'),
    btnConvert: q<HTMLButtonElement>('btnConvert'),
    btnFormat: q<HTMLButtonElement>('btnFormat'),
    btnCompact: q<HTMLButtonElement>('btnCompact'),
    btnCopy: q<HTMLButtonElement>('btnCopy'),
    btnDownload: q<HTMLButtonElement>('btnDownload'),
    splitter: q('splitter'),
  };
}