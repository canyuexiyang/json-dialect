/**
 * v1.5.1 缺陷修复版回归（E7）：把 2026-11-10 梳理清单里
 * 「自动化测不到」的盲区逐条钉死。
 *
 * 覆盖：
 *  - N01 setInput 路径的 1M 闸门（原先示例 / 片段 / 拖文件 / 放大页交接会绕过）
 *  - N02 macOS Option 组合用 e.code 判定（e.key 是 ¡/™/£/†）
 *  - N03 Alt+C/S/A 新主键位 + 旧 Mod+Shift 兼容
 *  - N05 有输入时 Esc 需要二次确认，不再一键丢内容
 *  - N06 bool / null 的类型覆盖不再静默丢数据、bool→boolean 不再报错
 *  - N07 转义 tab 收起来源标签与锁定徽标；N15 decode 禁用包裹引号
 *  - N09 computeStats 码点计数（合并迭代后结果不变）
 *  - N11 放大页入口 await 不得排在 mountShell 之前 + inheritFromSession 可重放
 *
 * 其它仍属人工/真机：深色 computed style、Tab 焦点链、逐键可达性（v1.5.1-6）。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import '../setup/cm6-jsdom.js';
import { AppController, type DomRefs } from '../../src/ui/controller.js';
import { convert, computeStats } from '../../src/core/index.js';
import { closeSidePanel } from '../../src/ui/sidePanel.js';

vi.mock('../../src/ui/sidePanel.js', () => ({
  closeSidePanel: vi.fn(async () => true),
}));

function mount(): DomRefs {
  document.body.innerHTML = `
    <div class="app" id="appRoot">
      <nav class="tabbar" role="tablist">
        <button class="tab" id="tabFormat" data-tab="format" aria-selected="true">格式化</button>
        <button class="tab" id="tabEscape" data-tab="escape" aria-selected="false">转义</button>
        <button class="tab" id="tabConvert" data-tab="convert" aria-selected="false">转换</button>
      </nav>
      <span id="fmtLabel"></span>
      <span id="lockBadge" hidden></span>
      <span id="sameTargetLabel" hidden></span>
      <select id="fmtSelect"><option value="json">JSON</option><option value="python">Python</option><option value="map">Map</option><option value="java">Java</option></select>
      <button id="resetAuto" hidden></button>
      <select id="escapeStyleSelect" hidden><option value="json">JSON</option><option value="url">URL</option><option value="base64">Base64</option></select>
      <div id="escapeDirSeg" class="seg" hidden>
        <button class="seg__btn" id="escapeDirDecode" data-dir="decode">去除转义</button>
        <button class="seg__btn" id="escapeDirEncode" data-dir="encode">增加转义</button>
      </div>
      <label id="wrapQuotesWrap" hidden><input type="checkbox" id="wrapQuotes" /></label>
      <select id="targetSelect"><option value="auto">自动</option><option value="json">JSON</option><option value="python">Python</option><option value="java">Java</option></select>
      <button id="enlarge"></button>
      <section class="pane pane--in" id="paneIn"><div class="pane__head"><span id="statsIn"></span><button id="btnClear">清空</button></div>
        <div id="editorIn"></div>
        <div id="emptyHints" hidden><button data-example="json">示例 JSON</button></div>
        <div id="fixbar" hidden></div>
      </section>
      <section class="pane pane--out" id="paneOut"><div class="pane__head"><span id="statsOut"></span><span id="staleBadge" hidden></span></div>
        <div id="editorOut"></div><div id="typePanel" hidden></div>
      </section>
      <footer><span id="statusMsg" aria-live="polite"></span></footer>
      <button id="btnConvert"></button><button id="btnFormat"></button><button id="btnCompact"></button>
      <button id="btnSnippet">存为片段</button><button id="btnCompare">对比</button>
      <button id="btnCopy"></button><button id="btnDownload"></button>
      <div id="splitter"></div>
    </div>`;
  const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as unknown as T;
  return {
    root: q('appRoot'), fmtLabel: q('fmtLabel'), lockBadge: q('lockBadge'),
    sameTargetLabel: q('sameTargetLabel'), fmtSelect: q<HTMLSelectElement>('fmtSelect'),
    resetAuto: q<HTMLButtonElement>('resetAuto'), targetSelect: q<HTMLSelectElement>('targetSelect'),
    escapeStyleSelect: q<HTMLSelectElement>('escapeStyleSelect'), escapeDirSeg: q('escapeDirSeg'),
    escapeDirDecode: q<HTMLButtonElement>('escapeDirDecode'), escapeDirEncode: q<HTMLButtonElement>('escapeDirEncode'),
    wrapQuotesWrap: q('wrapQuotesWrap'), wrapQuotes: q<HTMLInputElement>('wrapQuotes'),
    tabFormat: q<HTMLButtonElement>('tabFormat'), tabEscape: q<HTMLButtonElement>('tabEscape'),
    tabConvert: q<HTMLButtonElement>('tabConvert'), editorIn: q('editorIn'), editorOut: q('editorOut'),
    emptyHints: q('emptyHints'), btnClear: q<HTMLButtonElement>('btnClear'),
    btnSnippet: q<HTMLButtonElement>('btnSnippet'), btnCompare: q<HTMLButtonElement>('btnCompare'),
    paneIn: q('paneIn'), paneOut: q('paneOut'), statsIn: q('statsIn'), statsOut: q('statsOut'),
    staleBadge: q('staleBadge'), fixbar: q('fixbar'), typePanel: q('typePanel'),
    statusMsg: q('statusMsg'), btnConvert: q<HTMLButtonElement>('btnConvert'),
    btnFormat: q<HTMLButtonElement>('btnFormat'), btnCompact: q<HTMLButtonElement>('btnCompact'),
    btnCopy: q<HTMLButtonElement>('btnCopy'), btnDownload: q<HTMLButtonElement>('btnDownload'),
    splitter: q('splitter'),
  };
}

/** 一个「可立即返回」的 chrome 环境，避免 storage Promise 挂起影响用例 */
function installChrome(): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://x/${p}`,
      onInstalled: { addListener() {}, removeListener() {} },
      onStartup: { addListener() {}, removeListener() {} },
    },
    sidePanel: {
      setPanelBehavior: async () => {}, getPanelBehavior: async () => ({}),
      open: async () => {}, close: async () => {},
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  };
}

/** jsdom 的 Crypto 未必带 randomUUID；只补这一个方法，不替换整个 crypto 对象 */
function ensureRandomUUID(): void {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c?.randomUUID !== 'function') {
    Object.defineProperty(c, 'randomUUID', { value: () => 'v151-test-id', configurable: true });
  }
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e;
}

let dom: DomRefs;
let ctrl: AppController;

describe('v1.5.1 回归：P0 修复', () => {
  beforeEach(async () => {
    // 默认 spy 保留原实现，只记录调用；afterEach 据此解绑本例新增的全局监听，
    // 否则每个用例新建控制器都会在 document 上留下一个 keydown 监听，互相串扰。
    vi.spyOn(document, 'addEventListener');
    installChrome();
    ensureRandomUUID();
    vi.mocked(closeSidePanel).mockClear();
    dom = mount();
    ctrl = new AppController(dom, { surface: 'panel' });
    await ctrl.init();
    await Promise.resolve(); // 让 applyPrefsWhenReady 的异步段走完，稳定状态
  });

  afterEach(() => {
    type AddCall = [string, EventListenerOrEventListenerObject | null, AddEventListenerOptions | boolean | undefined];
    const calls = vi.mocked(document.addEventListener).mock.calls as unknown as AddCall[];
    vi.restoreAllMocks(); // 先还原 spy，再按记录解绑
    const origRemove = document.removeEventListener.bind(document);
    for (const [type, listener, options] of calls) {
      if (type === 'keydown' && listener) origRemove(type, listener, options);
    }
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // ── N01 ──────────────────────────────────────────────────────────────
  it('N01：setInput 灌入 >1M 文本必须挂「仍要转换」闸门，绝不直接跑转换', () => {
    const runSpy = vi.spyOn(ctrl, 'run');
    ctrl.setInput('a'.repeat(1_000_001));
    expect(document.getElementById('oversizeBox')).not.toBeNull();
    expect(ctrl.output).toBe('');
    expect(dom.btnConvert.textContent).toBe('转换');
    expect(dom.statusMsg.textContent).toContain('文本过大');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('N01：闸门后点「仍要转换」能显式放行，且提示条消失', () => {
    ctrl.setInput('a'.repeat(1_000_001));
    vi.useFakeTimers();
    const runSpy = vi.spyOn(ctrl, 'run').mockImplementation(() => {});
    const btn = document.querySelector<HTMLButtonElement>('#oversizeBox .suggest__btn');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(document.getElementById('oversizeBox')).toBeNull();
    vi.advanceTimersByTime(50); // 大文本转换放下一帧，别让 1M 文本真跑
    expect(runSpy).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
  });

  it('N01：恢复到小文本后闸门复位，实时转换照常可用', () => {
    ctrl.setInput('a'.repeat(1_000_001));
    expect(document.getElementById('oversizeBox')).not.toBeNull();
    ctrl.setInput('{"a": 1}');
    expect(document.getElementById('oversizeBox')).toBeNull();
    expect(ctrl.output).toContain('"a"');
  });

  // ── N02 ──────────────────────────────────────────────────────────────
  it('N02：macOS Option 组合（e.key 为特殊字符）按 e.code 直达 tab', () => {
    expect(press({ key: '£', code: 'Digit3', altKey: true }).defaultPrevented).toBe(true);
    expect(ctrl.currentTab).toBe('convert');
    press({ key: '™', code: 'Digit2', altKey: true });
    expect(ctrl.currentTab).toBe('escape');
    press({ key: '¡', code: 'Digit1', altKey: true });
    expect(ctrl.currentTab).toBe('format');
  });

  it('N02：无 e.code 的环境仍按 e.key 兜底；Option+T 产出 † 也必须认得', () => {
    press({ key: '3', altKey: true });
    expect(ctrl.currentTab).toBe('convert');
    const spy = vi.spyOn(ctrl as unknown as { handleEnlarge: () => Promise<void> }, 'handleEnlarge')
      .mockResolvedValue(undefined);
    expect(press({ key: '†', code: 'KeyT', altKey: true }).defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ── N03 ──────────────────────────────────────────────────────────────
  it('N03：Alt+C/S/A 新主键位生效（mac 特殊字符 + e.code）', () => {
    const copySpy = vi.spyOn(ctrl as unknown as { handleCopy: () => Promise<void> }, 'handleCopy')
      .mockResolvedValue(undefined);
    const dlSpy = vi.spyOn(dom.btnDownload, 'click').mockImplementation(() => {});
    expect(press({ key: 'ç', code: 'KeyC', altKey: true }).defaultPrevented).toBe(true);
    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(press({ key: 'ß', code: 'KeyS', altKey: true }).defaultPrevented).toBe(true);
    expect(dlSpy).toHaveBeenCalledTimes(1);
    expect(press({ key: 'å', code: 'KeyA', altKey: true }).defaultPrevented).toBe(true);
  });

  it('N03：Mod+Shift+C/S/A 旧键位保留兼容', () => {
    const copySpy = vi.spyOn(ctrl as unknown as { handleCopy: () => Promise<void> }, 'handleCopy')
      .mockResolvedValue(undefined);
    expect(press({ key: 'C', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(copySpy).toHaveBeenCalledTimes(1);
  });

  // ── N05 ──────────────────────────────────────────────────────────────
  it('N05：panel 形态有输入时首次 Esc 只警告，再按一次才关闭', () => {
    ctrl.setInput('{"a": 1}');
    press({ key: 'Escape' });
    expect(closeSidePanel).not.toHaveBeenCalled();
    expect(dom.statusMsg.textContent).toContain('再按一次');
    press({ key: 'Escape' });
    expect(closeSidePanel).toHaveBeenCalledTimes(1);
  });

  it('N05：空输入时 Esc 仍可一键关闭（不打扰）', () => {
    expect(ctrl.input).toBe('');
    press({ key: 'Escape' });
    expect(closeSidePanel).toHaveBeenCalledTimes(1);
  });

  // ── N07 / N15 ────────────────────────────────────────────────────────
  it('N07：转义 tab 收起来源标签与锁定徽标，切回后恢复', () => {
    ctrl.switchTab('escape');
    expect(dom.fmtLabel.hidden).toBe(true);
    expect(dom.lockBadge.hidden).toBe(true);
    ctrl.switchTab('format');
    expect(dom.fmtLabel.hidden).toBe(false);
  });

  it('N15：去除转义方向禁用「包裹外层引号」，增加转义方向恢复', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('json', 'decode');
    expect(dom.wrapQuotes!.disabled).toBe(true);
    ctrl.setEscape('json', 'encode');
    expect(dom.wrapQuotes!.disabled).toBe(false);
  });

  // ── N11 ──────────────────────────────────────────────────────────────
  it('N11：app.ts 入口里 mountShell 必须排在第一个 await 之前', () => {
    const src = readFileSync('src/ui/app.ts', 'utf8');
    // 剥掉注释再断言，避免注释里的关键字造成假阳性
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const mainBody = code.slice(code.indexOf('function main('), code.indexOf('function toInherited('));
    const mountAt = mainBody.indexOf('mountShell(');
    const awaitAt = mainBody.indexOf('await ');
    expect(mountAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(mountAt); // 同步段内无 await
    expect(mainBody).toContain('inheritFromSession');
  });

  it('N11：inheritFromSession 能重放交接态并写入输入', () => {
    ctrl.inheritFromSession('{"z": 9}', {
      tab: 'convert', target: 'json', strict: false, compact: true,
      locked: false, source: 'json',
    });
    expect(ctrl.currentTab).toBe('convert');
    expect(ctrl.input).toBe('{"z": 9}');
    expect(ctrl.output).toContain('"z"');
  });
});

describe('v1.5.1 回归：内核', () => {
  it('N06：bool / null 强制转字符串不再得到空串', () => {
    const r = convert('{"a": true, "b": null}', {
      overrides: new Map([['/a', 'string'], ['/b', 'string']]),
      target: 'json',
    });
    expect(r.status).not.toBe('error');
    const obj = JSON.parse(r.output) as Record<string, unknown>;
    expect(obj.a).toBe('true');
    expect(obj.b).toBe('null');
  });

  it('N06：bool→boolean 保持原值，不再抛「不能转换为布尔值」', () => {
    const r = convert('{"a": true}', { overrides: new Map([['/a', 'boolean']]), target: 'json' });
    expect(r.status).not.toBe('error');
    expect((JSON.parse(r.output) as Record<string, unknown>).a).toBe(true);
  });

  it('N06：目标 Python 时 bool / null 转字符串用 True / None', () => {
    const r = convert('{"a": true, "b": null}', {
      overrides: new Map([['/a', 'string'], ['/b', 'string']]),
      target: 'python',
    });
    expect(r.output).toContain('True');
    expect(r.output).toContain('None');
  });

  it('N09：computeStats 合并迭代后码点与行数不变', () => {
    expect(computeStats('😀a\nb')).toEqual({ lines: 2, chars: 4 });
    expect(computeStats('')).toEqual({ lines: 1, chars: 0 });
    expect(computeStats('a\r\nb\nc')).toEqual({ lines: 3, chars: 6 });
  });

  it('N21：非字符串键修正记录的 after 用双引号', () => {
    const r = convert('{a: 1}', { target: 'json' });
    expect(r.status).not.toBe('error');
    expect(r.fixes.some((f) => f.after === '"a"')).toBe(true);
  });
});
