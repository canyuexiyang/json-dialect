/**
 * 回归防线：UI 初始化不得被 chrome.storage 拖死
 *
 * 背景（真机 Bug，2026-09-21）：
 *   init() 里 `await loadPrefs()` 排在 createEditor() 之前。当 chrome.storage
 *   的 Promise 既不 resolve 也不 reject（企业策略禁用 storage / 权限未就绪 /
 *   扩展上下文失效），await 永不返回，编辑器永远创建不出来。
 *   由于页面骨架是纯 HTML，用户看到的是「布局正常、输入区点不动、粘不进」，
 *   极难自查。
 *
 * 本文件用「永不 settle 的 storage」模拟该场景，锁定两条不变量：
 *   1. 编辑器必须在 init() 同步段内就挂载完成
 *   2. storage 挂起不得影响已有交互
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup/cm6-jsdom.js';
import { AppController, type DomRefs } from '../../src/ui/controller.js';

function mount(): DomRefs {
  document.body.innerHTML = `
    <div class="app">
      <span id="fmtLabel"></span>
      <span id="lockBadge" hidden></span>
      <select id="fmtSelect">
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
        <option value="map">Map.toString()</option>
      </select>
      <button id="resetAuto" hidden></button>
      <button id="enlarge"></button>
      <div id="editorIn"></div>
      <div id="editorOut"></div>
      <span id="statsIn"></span>
      <span id="statsOut"></span>
      <span id="staleBadge" hidden></span>
      <div id="fixbar" hidden></div>
      <div id="typePanel" hidden></div>
      <footer><span id="statusMsg"></span></footer>
      <button id="btnConvert"></button>
      <button id="btnFormat"></button>
      <button id="btnCompact"></button>
      <button id="btnCopy"></button>
      <button id="btnDownload"></button>
      <div id="splitter"></div>
    </div>`;
  const q = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as unknown as T;
  return {
    fmtLabel: q('fmtLabel'),
    lockBadge: q('lockBadge'),
    fmtSelect: q<HTMLSelectElement>('fmtSelect'),
    resetAuto: q<HTMLButtonElement>('resetAuto'),
    enlarge: q<HTMLButtonElement>('enlarge'),
    editorIn: q('editorIn'),
    editorOut: q('editorOut'),
    statsIn: q('statsIn'),
    statsOut: q('statsOut'),
    staleBadge: q('staleBadge'),
    fixbar: q('fixbar'),
    typePanel: q('typePanel'),
    statusMsg: q('statusMsg'),
    btnConvert: q<HTMLButtonElement>('btnConvert'),
    btnFormat: q<HTMLButtonElement>('btnFormat'),
    btnCompact: q<HTMLButtonElement>('btnCompact'),
    btnCopy: q<HTMLButtonElement>('btnCopy'),
    btnDownload: q<HTMLButtonElement>('btnDownload'),
    splitter: q('splitter'),
  };
}

/** 安装一个永不 settle 的 chrome.storage —— 模拟扩展上下文失效 */
function installHangingStorage(): void {
  const never = () => new Promise<never>(() => {});
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
    storage: {
      local: { get: never, set: never },
      session: { get: never, set: never, remove: never },
    },
  };
}

const realChrome = (globalThis as Record<string, unknown>).chrome;

describe('UI 初始化不得被 storage 挂起阻塞', () => {
  beforeEach(() => {
    installHangingStorage();
    vi.useRealTimers();
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).chrome = realChrome;
    document.body.innerHTML = '';
  });

  it('storage 永不返回时，编辑器仍必须完成挂载', async () => {
    const dom = mount();
    const app = new AppController(dom);

    // 不 await init —— 因为它内部可能仍在等 storage
    const p = app.init();

    // 关键：不推进任何定时器，编辑器此刻就应该已经存在
    expect(dom.editorIn.querySelectorAll('.cm-editor').length).toBe(1);
    expect(dom.editorOut.querySelectorAll('.cm-editor').length).toBe(1);
    expect(dom.editorIn.querySelector('.cm-content')).not.toBeNull();

    // 输入区可编辑（不是只读僵尸）
    const content = dom.editorIn.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('true');

    await p;
  });

  it('storage 永不返回时，转换功能依然可用', async () => {
    const dom = mount();
    const app = new AppController(dom);
    const p = app.init();

    // v1.1 默认 tab = 格式化（同语言进出）；本用例验的是「跨语言转换仍可用」
    app.switchTab('convert');
    app.setInput("{'a': 1, 'b': True}");
    expect(app.output).toContain('"a": 1');
    expect(app.output).toContain('"b": true');

    await p;
  });

  it('storage 永不返回时，首屏状态提示已就位', async () => {
    const dom = mount();
    const app = new AppController(dom);
    const p = app.init();

    // renderEmpty 必须在同步段跑完，否则用户看到空白状态栏
    expect(dom.statusMsg.textContent).toBe('粘贴内容即可自动转换');

    await p;
  });
});
