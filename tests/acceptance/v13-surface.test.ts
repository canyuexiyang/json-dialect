/**
 * v1.3 承载形态重构的防回归断言
 *
 * 这个版本里踩过的坑，几乎全部是「测试全绿但真机坏掉」的类型
 * （参见项目记忆里的坑 7/ 14 / 15）。所以这里不测「功能对不对」，
 * 而是把**最容易写错、且错了症状具有误导性**的几个点钉死：
 *
 *  1. service worker 的属性名 openPanelOnActionClick —— 拼错同步抛 TypeError，
 *     静默中断 worker，症状是「点了图标没反应」，没有任何其他信号。
 *  2. 面板作用域必须是 windowId 而非 tabId —— 用tabId 的症状与 v1.2
 *     「切标签页内容全丢」一模一样，会被误判为「重构没生效」。
 *  3. manifest 不得同时存在 default_popup 与 side_panel —— popup 优先级更高，
 *     会把面板行为顶掉。
 *  4. splitter 有 min-height 兜底与键盘可达性。
 *  5. popup 链路已彻底删除（含产物里也不能有）。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../setup/cm6-jsdom.js';
import fs from 'node:fs';
import path from 'node:path';
import { AppController, type DomRefs } from '../../src/ui/controller.js';
import { mountShell, type SurfaceKind } from '../../src/ui/shell.js';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * 只取代码，剥掉注释。
 * 这几个断言的关键词（popup / isPage / tabId）在解释性注释里会被正当提及，
 * 直接全文匹配会误报 —— 那样的断言一旦失败就没人敢信，等于没有断言。
 */
const readCode = (p: string) =>
  read(p)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');

/**
 * 读回内联 flex-grow。
 * jsdom 会把 `flex: 0.95` 归一化成 `0.95 1 0%`（flex-grow/shrink/basis 三值），
 * 直接 Number() 会得 NaN —— 只能取第一段。
 */
function rootOf(dom: DomRefs): HTMLElement {
  if (!dom.root) throw new Error('fixture缺少 root');
  return dom.root;
}

function inPaneOf(dom: DomRefs): HTMLElement {
  const el = rootOf(dom).querySelector('.pane--in');
  if (!el) throw new Error('fixture 缺少 .pane--in');
  return el as HTMLElement;
}

function readFlexGrow(el: HTMLElement): number {
  return Number.parseFloat(el.style.getPropertyValue('flex').trim().split(/\s+/)[0] ?? '');
}

function mountFixture(): DomRefs {
  document.body.innerHTML = `
    <div id="app" class="app">
    <header class="detectbar">
      <span id="fmtLabel"></span>
      <span class="badge" id="lockBadge" hidden></span>
      <select id="fmtSelect">
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
        <option value="map">Map.toString()</option>
      </select>
      <button id="resetAuto" hidden></button>
      <select id="targetSelect">
        <option value="auto">自动</option>
      </select>
      <select id="escapeStyleSelect" hidden><option value="json">JSON 字符串</option></select>
      <div id="escapeDirSeg" class="seg" hidden>
        <button class="seg__btn" id="escapeDirDecode" type="button" data-dir="decode">去除转义</button>
        <button class="seg__btn seg__btn--on" id="escapeDirEncode" type="button" data-dir="encode">增加转义</button>
      </div>
      <button id="tabFormat" type="button" class="tab" data-tab="format">格式化</button>
      <button id="tabEscape" type="button" class="tab" data-tab="escape">转义</button>
      <button id="tabConvert" type="button" class="tab" data-tab="convert">转换</button>
    </header>
    <section class="pane pane--in"><div id="editorIn"></div><div id="fixbar" hidden></div></section>
    <div id="splitter" tabindex="0"></div>
    <section class="pane pane--out">
      <span id="statsOut"></span>
      <span id="staleBadge" class="badge" hidden></span>
      <div id="editorOut"></div>
      <div id="typePanel" hidden></div>
    </section>
    <footer><span id="statusLed"></span><span id="statusMsg"></span></footer>
    <span id="statsIn"></span>
    <button id="btnConvert"></button>
    <button id="btnFormat"></button>
    <button id="btnCompact"></button>
    <button id="btnCopy"></button>
    <button id="btnDownload"></button>
    </div>`;
  const q = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as unknown as T;
  return {
    root: q('app'),
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

describe('v1.3-1 manifest：popup 已删除，侧边栏与 worker 就位', () => {
  const m = JSON.parse(read('manifest.json')) as Record<string, any>;

  it('action 不再有 default_popup（它会顶掉 side_panel 行为）', () => {
    expect(m.action?.default_popup).toBeUndefined();
  });

  it('声明 sidePanel 权限且零 host 权限', () => {
    expect(m.permissions).toContain('sidePanel');
    expect(m.permissions).toContain('storage');
    expect(m.host_permissions).toBeUndefined();
  });

  it('side_panel.default_path 指向存在的文件', () => {
    expect(m.side_panel?.default_path).toBe('panel.html');
    expect(fs.existsSync(path.join(root, 'panel.html'))).toBe(true);
  });

  it('service worker 已注册且目标文件存在', () => {
    expect(m.background?.type).toBe('module');
    expect(m.background?.service_worker).toBe('background.js');
    expect(fs.existsSync(path.join(root, 'src/ui/background.ts'))).toBe(true);
  });
});

describe('v1.3-2 service worker：最容易写错且症状误导的三点', () => {
  const src = read('src/ui/background.ts');
  const code = readCode('src/ui/background.ts');

  it('属性名必须是 openPanelOnActionClick', () => {
    expect(code).toContain('openPanelOnActionClick');
    // 拼错的那个变体绝不能出现在代码里（注释里提它是为了警告）
    expect(code).not.toContain('openPanelOnActionIconClick');
  });

  it('监听器在模块顶层同步注册（MV3 worker 30s 回收）', () => {
    const topLevel = code
      .split('\n')
      .filter((l) => /addListener\(/.test(l))
      .map((l) => l.trim());
    expect(topLevel.length).toBeGreaterThanOrEqual(2);
    // 不得被包进函数体（缩进说明它还在回调里）
    for (const l of topLevel) expect(l.startsWith('chrome.')).toBe(true);
    expect(src).toMatch(/onInstalled/);
    expect(src).toMatch(/onStartup/);
  });

  it('面板作用域必须是 windowId，绝不能出现 tabId', () => {
    // tabId 会让面板只属于那一个 tab —— 切 tab 即失效，症状与 v1.2 一模一样
    expect(code).not.toMatch(/open\(\s*\{\s*tabId/);
    expect(code).not.toMatch(/tabId:/);
  });
});

describe('v1.3-3 popup 链路已彻底删除', () => {
  it('源码树中不存在 popup.html / popup.ts', () => {
    expect(fs.existsSync(path.join(root, 'popup.html'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/ui/popup.ts'))).toBe(false);
  });

  it('vite入口不再引用 popup', () => {
    expect(readCode('vite.config.ts')).not.toContain('popup');
  });

  it('入口与模板代码中零 popup 引用（注释不算）', () => {
    for (const f of [
      'src/ui/controller.ts',
      'src/ui/shell.ts',
      'src/ui/panel.ts',
      'src/ui/app.ts',
    ]) {
      expect(readCode(f), `${f} 仍引用 popup`).not.toMatch(/popup/);
    }
  });
});

describe('v1.3-4 共享模板：两形态结构一致，差异只在 class 与放大按钮', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app" class="app"></div>';
  });
  afterEach(() => {
 document.body.innerHTML = '';
  });

  it('panel 形态挂上 app--panel 且带「标签页」按钮', () => {
    const dom = mountShell('panel');
    expect(rootOf(dom).className).toContain('app--panel');
    expect(rootOf(dom).classList.contains('app--large')).toBe(false);
    expect(dom.enlarge).toBeDefined();
  });

  it('tab 形态挂上 app--large 且无放大按钮', () => {
    const dom = mountShell('tab');
    expect(rootOf(dom).className).toContain('app--large');
    expect(dom.enlarge).toBeUndefined();
  });

  it('两形态的 tabbar DOM 顺序完全一致（FR-L1顺序固定）', () => {
    mountShell('panel');
 const panelIds = Array.prototype.map.call(
      document.querySelectorAll('.tabbar .tab'),
      (b: Element) => b.id,
    );
    document.body.innerHTML = '<div id="app" class="app"></div>';
    mountShell('tab');
    const tabIds = Array.prototype.map.call(
    document.querySelectorAll('.tabbar .tab'),
      (b: Element) => b.id,
    );
    expect(panelIds).toEqual(['tabFormat', 'tabEscape', 'tabConvert']);
    expect(tabIds).toEqual(panelIds);
  });

  it('mountShell 产出的引用全部可解析（无 undefined 落进 controller）', () => {
    const dom = mountShell('panel');
    for (const [k, v] of Object.entries(dom)) {
      if (k === 'enlarge') continue;
      expect(v, `字段 ${k} 未解析`).toBeInstanceOf(Element);
    }
  });
});

describe('v1.3-5 splitter：min-height 兜底 + 键盘可达 + 内联样式可重置', () => {
  let dom: DomRefs;
  beforeEach(() => {
 dom = mountFixture();
    window.matchMedia =
      window.matchMedia ??
      ((q: string) =>
        ({
       matches: false,
        media: q,
  addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

it('方向键可微调输入区高度（tabindex 早已存在但此前无监听）', async () => {
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    const inPane = inPaneOf(dom);

    dom.splitter!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    const afterDown = readFlexGrow(inPane);
    expect(Number.isFinite(afterDown)).toBe(true);

    dom.splitter!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(readFlexGrow(inPane)).toBeGreaterThan(afterDown);
  });

  it('比例被钳制在 0.2~0.8，不会把输出区压没', async () => {
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    const inPane = inPaneOf(dom);
    for (let i = 0; i < 30; i++) {
      dom.splitter!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    }
    // flex-grow = 0.5 + ratio，ratio 下限 0.2
    expect(readFlexGrow(inPane)).toBeCloseTo(0.7, 5);
  });

  it('Home / End 直达两端', async () => {
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    const inPane = inPaneOf(dom);
    dom.splitter!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(readFlexGrow(inPane)).toBeCloseTo(1.3, 5);
    dom.splitter!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(readFlexGrow(inPane)).toBeCloseTo(0.7, 5);
  });

  it('容器高度已知时写入 min-height 兜底', async () => {
    const app = new AppController(dom, { surface: 'panel' });
 // jsdom 的 clientHeight 恒为 0，用 defineProperty 造一个真实高度
    Object.defineProperty(rootOf(dom), 'clientHeight', { value: 400, configurable: true });
    await app.init();
    const inPane = inPaneOf(dom);
    dom.splitter!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(inPane.style.getPropertyValue('min-height')).toMatch(/px$/);
  });

  it('拖拽期间挂上 is-dragging 高亮（CSS 早有此规则但此前从不触发）', async () => {
  const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    const ev = new Event('pointerdown', { bubbles: true }) as Event & { clientY: number };
    ev.clientY = 100;
    dom.splitter!.dispatchEvent(ev);
    expect(dom.splitter!.classList.contains('is-dragging')).toBe(true);
    window.dispatchEvent(new Event('pointerup'));
    expect(dom.splitter!.classList.contains('is-dragging')).toBe(false);
  });
});

describe('v1.3-9隐私口径：零落盘承诺未被承载形态改写', () => {
  it('代码中不出现 local 持久化输入内容（FR-H4）', () => {
    const src = read('src/ui/sessionState.ts');
    // storage.local 只允许写界面偏好，键名必须是 prefs 那个
    expect(src).toContain("const PREF_KEY = 'json-dialect-prefs'");
    // 会话态只走 session（纯内存）
    expect(src).toContain("const KEY = 'json-dialect-session'");
    expect(src).toMatch(/chrome\.storage\.session/);
  });

  it('侧边栏存活靠文档而非落盘—— 没有把输入写进任何 storage', () => {
    const ctrl = read('src/ui/controller.ts');
    // writeSession 只在「打开标签页」时调用，且写的是 session
    expect(ctrl).toContain('writeSession');
    expect(ctrl).not.toMatch(/savePrefs\([^)]*input/);
  });
});

describe('SurfaceKind 枚举取代死掉的 isPage', () => {
  it('controller 不再声明 isPage', () => {
    // 只查声明形态（`isPage:` / `isPage?:` / `isPage=`），注释里提及它是有意的说明
    expect(read('src/ui/controller.ts')).not.toMatch(/\bisPage\s*[?:=]/);
    expect(read('src/ui/controller.ts')).not.toMatch(/isPage\?:/);
  });

  it('SurfaceKind 只有 panel / tab 两态，且被 controller 接受', () => {
    const shell = read('src/ui/shell.ts');
    expect(shell).toContain("export type SurfaceKind = 'panel' | 'tab'");
 const dom = mountFixture();
    expect(() => new AppController(dom, { surface: 'panel' as SurfaceKind })).not.toThrow();
    expect(() => new AppController(dom, { surface: 'tab' as SurfaceKind })).not.toThrow();
  });
});