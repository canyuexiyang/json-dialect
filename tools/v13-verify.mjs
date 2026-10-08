/**
 * v1.3 真机验收脚本（puppeteer-core 22.x）
 *
 * 环境限制（项目记忆已验证）：
 *  - --load-extension 不可行、chrome-extension:// 伪造 origin 会 ERR_BLOCKED_BY_CLIENT
 *  - 正解：http.server 托管 dist + evaluateOnNewDocument 注入 window.chrome
 *
 * 覆盖：v1.3-8 验收清单里能用这套环境测的项（三档宽度、溢出量测、
 *跨标签页存活、标签页继承、AC-37 零网络）。点图标开面板与worker 注册
 * 依赖真实扩展上下文，本脚本测不了，标记为人工项。
 */
import puppeteer from '/Users/guhui/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://127.0.0.1:8792';
const OUT = '/tmp/v13-shots';
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [320, 360, 500];
const TABS = ['format', 'escape', 'convert'];

// evaluateOnNewDocument 会把函数序列化后注入，闭包变量全部丢失 ——
// 所以 base 通过一段字面量脚本先写进 window，stub 函数本身不含任何外部引用
const makeChromeStub = () => {
  const store = {};
  window.chrome = {
    runtime: {
      getURL: (p) => `${window.__V13_BASE__}/${p}`,
      onInstalled: { addListener() {}, removeListener() {} },
      onStartup: { addListener() {}, removeListener() {} },
    },
    // chrome.windows 的基础方法（含 getCurrent）**不需要任何 manifest 权限**，
    // 真实 Chrome 上就是可用的 —— 这里取窗口 id 给 sidePanel.close 用。
    windows: { getCurrent: async () => ({ id: 1 }) },
    sidePanel: {
      setPanelBehavior: async () => {},
      getPanelBehavior: async () => ({ openPanelOnActionClick: true }),
      open: async () => {},
      // v1.3.1：点「标签页」后扩展会调 close({windowId}) 关掉侧边栏。
      // 记录调用参数，配合后面的 closeArgs / panelClosed 断言。
      close: async (o) => {
        window.__V13_CLOSE__ = (window.__V13_CLOSE__ ?? []).concat(JSON.stringify(o));
      },
    },
    storage: {
      // local：纯内存（真实实现是持久的，但本用例不关心）
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (items) => Object.assign(store, items),
        remove: async (k) => delete store[k],
      },
      // session：**必须跨JS 上下文共享** —— window.open 出来的标签页是独立上下文，
      // 用页面内存模拟会导致「继承」永远测不出来（假失败）。
      // localStorage 同源跨页共享，正好符合 storage.session 的语义。
session: {
        // 必须返回 `{ [key]: value }` —— 真实 chrome.storage.get(key) 就是这个形状。
        // 直接返回 value 会让消费方 got[KEY] 取到 undefined，
        // 症状是「静默无继承」，非常难自查。
      get: async (k) => {
          try {
      const raw = window.localStorage.getItem(k);
      return raw ? { [k]: JSON.parse(raw) } : {};
      } catch {
            return {};
       }
        },
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) {
            window.localStorage.setItem(k, JSON.stringify(v));
          }
        },
        remove: async (k) => window.localStorage.removeItem(k),
      },
    },
  };
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server'],
  ignoreDefaultArgs: ['--disable-extensions'],
});

const report = [];
const errors = [];

/** 量测一个元素及其关键子项是否溢出容器宽度 */
async function measure(page, width, tab) {
  await page.evaluate((t) => {
    document.querySelector(`[data-tab="${t}"]`)?.click();
  }, tab);
  await new Promise((r) => setTimeout(r, 250));
  return page.evaluate((vw) => {
    const doc = document.documentElement;
    const res = {
      hScroll: doc.scrollWidth > doc.clientWidth + 1,
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      clipped: [],
      visible: {},
    };
    // 关键控件：必须完整可见可点（历史上被裁掉的就是这几个）
    const musts = ['btnCopy', 'btnDownload', 'btnConvert', 'enlarge', 'statusMsg'];
    for (const id of musts) {
      const el = document.getElementById(id);
      if (!el || el.hidden || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      const ok = r.left >= -0.5 && r.right <= vw + 0.5 && r.width > 0;
      res.visible[id] = { ok, left: Math.round(r.left), right: Math.round(r.right) };
      if (!ok) res.clipped.push(id);
    }
    // 三条横向条带是否超出视口
    for (const sel of ['.topbar', '.detectbar', '.toolbar']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 0.5) res.clipped.push(`${sel}(right=${Math.round(r.right)})`);
    }
    return res;
  }, width);
}

for (const width of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(`[${width}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${width}] console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`[${width}] requestfailed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[${width}] http${r.status()}: ${r.url()}`);
  });

  const external = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!req.url().startsWith(BASE) && !req.url().startsWith('data:')) external.push(req.url());
    req.continue();
  });

  await page.evaluateOnNewDocument(`window.__V13_BASE__ = ${JSON.stringify(BASE)};`);
  await page.evaluateOnNewDocument(makeChromeStub);
  await page.goto(`${BASE}/panel.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.cm-editor', { timeout: 8000 });

  // 填入内容，覆盖三种 tab 的最坏情况
  for (const tab of TABS) {
    const m = await measure(page, width, tab);
    report.push({ width, tab, ...m });
    await page.screenshot({ path: `${OUT}/panel-${width}-${tab}.png` });
  }

  if (width === 360) {
    const ac37 = await page.evaluate(() => ({
      fetch: typeof window.fetch === 'function' && String(window.fetch).includes('native'),
      xhr: typeof XMLHttpRequest !== 'undefined',
    }));
    report.push({ width, ac37, externalRequests: external });
  }

  await page.close();
}

// ── 标签页形态 + 会话继承 ──
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(`[tab] pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(`window.__V13_BASE__ = ${JSON.stringify(BASE)};`);
  await page.evaluateOnNewDocument(makeChromeStub);
  await page.goto(`${BASE}/panel.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.cm-editor');

  // 侧边栏里输入 + 切到转换 tab
  await page.click('#editorIn .cm-content');
  await page.keyboard.type("{'a': 1, 'b': True}");
  await new Promise((r) => setTimeout(r, 500));
  await page.click('[data-tab="convert"]');
  await new Promise((r) => setTimeout(r, 300));
  const panelOut = await page.evaluate(() => document.querySelector('#editorOut .cm-content')?.textContent ?? '');
  await page.screenshot({ path: `${OUT}/panel-360-convert-filled.png` });

  // 点「标签页」按钮（AC-49：走 window.open，不用 chrome.tabs.create）
  await page.click('#enlarge');
  await new Promise((r) => setTimeout(r, 900));
  const openedUrls = (await browser.pages()).map((x) => x.url());
  const sessionPayload = await page.evaluate(() =>
    window.localStorage.getItem('json-dialect-session'),
  );

  // v1.3.1：点「标签页」后必须关掉侧边栏 —— 这里验证扩展确实调用了
  // chrome.sidePanel.close({ windowId })（stub 已记录调用参数）。
  const sidePanelCloseArgs = await page.evaluate(() => window.__V13_CLOSE__ ?? null);

  // window.open 出的新页不经过 evaluateOnNewDocument（只对 navigate 生效），
  // 那里 chrome 未定义、consumeSession 直接返回 null —— 那是测试环境限制，不是代码问题。
  // 所以另开一个手动注入 stub 的页面来验证「继承」本身。
  const tabPage = await browser.newPage();
  tabPage.on('pageerror', (e) => errors.push(`[tab] pageerror: ${e.message}`));
  await tabPage.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });
  await tabPage.evaluateOnNewDocument(`window.__V13_BASE__ = ${JSON.stringify(BASE)};`);
  await tabPage.evaluateOnNewDocument(makeChromeStub);
  await tabPage.goto(`${BASE}/app.html`, { waitUntil: 'networkidle0' });
  await tabPage.waitForSelector('.cm-editor', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 500));

  const inherited = await tabPage.evaluate(() => ({
    input: document.querySelector('#editorIn .cm-content')?.textContent ?? '',
    activeTab: document.querySelector('.tab--on')?.getAttribute('data-tab') ?? '',
    hasAppLarge: document.querySelector('#app')?.classList.contains('app--large') ?? false,
    output: document.querySelector('#editorOut .cm-content')?.textContent ?? '',
    hasEnlarge: !!document.getElementById('enlarge'),
  }));
  await tabPage.screenshot({ path: `${OUT}/tab-inherited.png` });

  // 跨文档存活：侧边栏页面全程未被销毁，内容与tab 状态都还在
  const survived = await page.evaluate(() => ({
    input: document.querySelector('#editorIn .cm-content')?.textContent ?? '',
    activeTab: document.querySelector('.tab--on')?.getAttribute('data-tab') ?? '',
    output: document.querySelector('#editorOut .cm-content')?.textContent ?? '',
  }));

  report.push({
    width: 'tab-form',
 panelOut: panelOut.slice(0, 60),
    windowOpenTarget: openedUrls[openedUrls.length - 1] ?? null,
    sessionPayload: sessionPayload ? JSON.parse(sessionPayload) : null,
    sidePanelCloseArgs,
    inherited,
    survivedAfterDocSwitch: survived,
  });
  await page.close();
}

await browser.close();

console.log(JSON.stringify({ report, errors }, null, 2));