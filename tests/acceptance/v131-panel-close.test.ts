/**
 * v1.3.1：侧边栏关闭 + 宽度引导条的防回归断言
 *
 * 这两个改动来自**真机实测反馈**，不是设计推演：
 *   1. 点「标签页」新开整屏标签页后，侧边栏不会自己关 —— 屏幕上两个扩展实例。
 *      根因是 v1.3 只做了「开」，没做「关」。
 *   2. 侧边栏太窄。查证结论：Chrome 侧边栏宽度**没有 API**（默认约 360px、
 *      最小硬底约 320px，只能用户拖边缘），扩展改不了也自适应不了。
 *      「默认占 1/3」做不到，改成了「说清楚限制 + 给一键升级的出口」。
 *
 * 这里钉死的是几条**写错就静默失效**的点：
 *   - close() 必须传 windowId（tabId 对全局面板无效，症状是「点了标签页但侧边栏还在」）
 *   - close() 是 Chrome 141+ 才有，旧版上不存在 → 必须判存在再调，否则同步抛错、兜底也被跳过
 *   - 非扩展上下文不得调 window.close()（jsdom 下会污染同一文件后续用例）
 *   - 引导条只提示一次，关掉要写进 prefs
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup/cm6-jsdom.js';
import fs from 'node:fs';
import path from 'node:path';
import { AppController, type DomRefs } from '../../src/ui/controller.js';
import { mountShell } from '../../src/ui/shell.js';
import { closeSidePanel } from '../../src/ui/sidePanel.js';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const readCode = (p: string) =>
  read(p)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');

type ChromeStub = Record<string, unknown>;
const setChrome = (c: ChromeStub | undefined): void => {
  if (c === undefined) delete (globalThis as Record<string, unknown>).chrome;
  else (globalThis as Record<string, unknown>).chrome = c;
};

/** 等异步段的 prefs 落地（applyPrefsWhenReady 是 void 调用，不 await） */
const flush = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ensureMatchMedia(): void {
  window.matchMedia =
    window.matchMedia ??
    ((q: string) =>
      ({
        matches: false,
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app" class="app"></div>';
  ensureMatchMedia();
});

afterEach(() => {
  document.body.innerHTML = '';
  setChrome(undefined);
  vi.restoreAllMocks();
});

describe('closeSidePanel：官方 API 优先，且只认 windowId', () => {
  it('close() 可用时按 windowId 关闭，不走 window.close() 兜底', async () => {
    const closeArgs: unknown[] = [];
    setChrome({
      windows: { getCurrent: async () => ({ id: 42 }) },
      sidePanel: {
        close: async (o: unknown) => {
          closeArgs.push(o);
        },
      },
    });
    const winClose = vi.spyOn(window, 'close').mockImplementation(() => {});

    const ok = await closeSidePanel();
    expect(ok).toBe(true);
    expect(closeArgs).toEqual([{ windowId: 42 }]);
    expect(winClose).not.toHaveBeenCalled();
  });

  it('传给 close() 的参数里绝不能出现 tabId（全局面板用 tabId 关不掉）', () => {
    const src = readCode('src/ui/sidePanel.ts');
    expect(src).toMatch(/close\(\s*\{\s*windowId\s*\}\s*\)/);
    expect(src).not.toMatch(/close\(\s*\{[^}]*tabId/);
  });

  it('旧版 Chrome 无 close() 时不抛，走 window.close() 兜底', async () => {
    setChrome({
      windows: { getCurrent: async () => ({ id: 7 }) },
      // 模拟 Chrome < 141：有 sidePanel 但没有 close()
      sidePanel: { setPanelBehavior: async () => {} },
    });
    const winClose = vi.spyOn(window, 'close').mockImplementation(() => {});

    const ok = await closeSidePanel();
    expect(ok).toBe(false);
    expect(winClose).toHaveBeenCalled();
  });

  it('chrome.* 永不 settle 时超时兜底，不会把调用方挂死（坑 9 同源）', async () => {
    setChrome({
      // 永不 settle —— 模拟企业策略下 storage/windows 卡死
      windows: { getCurrent: () => new Promise<{ id: number }>(() => {}) },
      sidePanel: { close: async () => {} },
    });
    const winClose = vi.spyOn(window, 'close').mockImplementation(() => {});

    await closeSidePanel();
    expect(winClose).toHaveBeenCalled();
  });

  it('非扩展上下文（连 sidePanel 命名空间都没有）不得调 window.close()', async () => {
    setChrome({ runtime: { getURL: (p: string) => p } });
    const winClose = vi.spyOn(window, 'close').mockImplementation(() => {});

    await closeSidePanel();
    // jsdom 下 window.close() 会把整个 window 标记为 closed，
    // 污染同一测试文件里后续的用例 —— 必须有这道前置判断。
    expect(winClose).not.toHaveBeenCalled();
  });
});

describe('点「标签页」必须同时关掉侧边栏', () => {
  it('panel 形态：点击后确实调用了关闭', async () => {
    const closeArgs: unknown[] = [];
    setChrome({
      runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
      windows: { getCurrent: async () => ({ id: 99 }) },
      sidePanel: {
        close: async (o: unknown) => {
          closeArgs.push(o);
        },
      },
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
    });
    vi.spyOn(window, 'open').mockReturnValue(null);

    const dom = mountShell('panel');
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    await flush();

    dom.enlarge!.click();
    await flush(120);

    expect(closeArgs).toEqual([{ windowId: 99 }]);
  });

  it('关闭只在 panel 形态发生（tab 形态本来就没有面板可关）', () => {
    const src = readCode('src/ui/controller.ts');
    expect(src).toContain("this.opts.surface === 'panel'");
    // tab 形态连按钮都不渲染，双重保险
    const tabDom = mountShell('tab');
    expect(tabDom.enlarge).toBeUndefined();
  });
});

describe('宽度引导条（Chrome 侧边栏宽度无 API 的兜底说明）', () => {
  const stubChrome = (prefs: Record<string, unknown>): void => {
    setChrome({
      runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
      sidePanel: { setPanelBehavior: async () => {} },
      storage: {
        // 真实 API 形状：get(key) 返回 { [key]: value }
        local: {
          get: async (k: string) => ({ [k]: prefs }),
          set: async () => {},
          remove: async () => {},
        },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
    });
  };

  it('只在侧边栏形态渲染，标签页形态不出现（整屏无需提示）', () => {
    const panelDom = mountShell('panel');
    expect(panelDom.widthHint).toBeDefined();
    expect(panelDom.widthHintClose).toBeDefined();

    document.body.innerHTML = '<div id="app" class="app"></div>';
    const tabDom = mountShell('tab');
    expect(tabDom.widthHint).toBeUndefined();
  });

  it('默认隐藏，prefs 确认未关闭过才显示', async () => {
    stubChrome({});
    const dom = mountShell('panel');
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    expect(dom.widthHint!.hidden).toBe(true);
    await flush();
    expect(dom.widthHint!.hidden).toBe(false);
  });

  it('关掉后写入 prefs，下次不再出现', async () => {
    const written: Array<Record<string, unknown>> = [];
    stubChrome({});
    const store = (globalThis as Record<string, unknown>).chrome as ChromeStub;
    ((store as { storage: ChromeStub }).storage as { local: ChromeStub }).local.set = async (
      items: Record<string, unknown>,
    ) => {
      written.push(items);
    };

    const dom = mountShell('panel');
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    await flush();
    expect(dom.widthHint!.hidden).toBe(false);

    dom.widthHintClose!.click();
    expect(dom.widthHint!.hidden).toBe(true);

    await flush();
    expect(written.length).toBeGreaterThan(0);
    const last = written[written.length - 1]['json-dialect-prefs'] as Record<string, unknown>;
    expect(last.hintWidth).toBe(true);
  });

  it('prefs 里 hintWidth 为 true 时不再显示', async () => {
    stubChrome({ hintWidth: true });
    const dom = mountShell('panel');
    const app = new AppController(dom, { surface: 'panel' });
    await app.init();
    await flush();
    expect(dom.widthHint!.hidden).toBe(true);
  });
});

describe('宽度限制必须写进说明文档（这是产品口径，不是代码细节）', () => {
  it('README 明确写了侧边栏宽度无 API', () => {
    expect(read('README.md')).toContain('侧边栏宽度');
  });
});
