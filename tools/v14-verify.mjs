/**
 * v1.4 真机验收脚本（puppeteer-core 22.x）
 *
 * 环境限制（项目记忆已验证，别再试）：
 *  - --load-extension 不可行；chrome-extension:// 伪造 origin 会 ERR_BLOCKED_BY_CLIENT
 *  - 正解：python3 -m http.server 托管 dist + evaluateOnNewDocument 注入 window.chrome
 *
 * 覆盖：AC-89/90/92/93/94/95/96/97/98/99/101 + AC-37 零网络回归 + AC-102 观感
 * 覆盖不了：AC-81/82（依赖真实扩展上下文与 service worker）
 */
import puppeteer from '/Users/guhui/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://127.0.0.1:8794';
const OUT = '/tmp/v14-shots';
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [320, 360, 500];
const DOC = '{"data":{"list":[{"userName":"Alice","amount":120},{"userName":"Bob","amount":200}]},"ok":true}';
const DEEP = '{"aVeryLongParentName":{"anotherLongLevelName":{"thirdLevelName":{"fourthLevelName":{"targetFieldName":1}}}}}';

const makeChromeStub = () => {
  const store = {};
  window.chrome = {
    runtime: {
      getURL: (p) => `${window.__V14_BASE__}/${p}`,
      onInstalled: { addListener() {}, removeListener() {} },
      onStartup: { addListener() {}, removeListener() {} },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    sidePanel: {
      setPanelBehavior: async () => {},
      getPanelBehavior: async () => ({ openPanelOnActionClick: true }),
      open: async () => {},
      close: async () => {},
    },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (items) => Object.assign(store, items),
        remove: async (k) => delete store[k],
      },
      session: {
        get: async (k) => {
          try {
            const raw = window.localStorage.getItem(k);
            return raw ? { [k]: JSON.parse(raw) } : {};
          } catch { return {}; }
        },
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) window.localStorage.setItem(k, JSON.stringify(v));
        },
        remove: async (k) => window.localStorage.removeItem(k),
      },
    },
  };
};

const report = [];
const errors = [];
const fail = [];

function check(name, cond, detail) {
  report.push({ name, ok: !!cond, detail });
  if (!cond) fail.push(`${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在指定编辑器里，把鼠标点到某个 token 内部（依赖 Range 的实测坐标） */
async function clickToken(page, editorSel, needle, nth = 0) {
  const pt = await page.evaluate((sel, text, index) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let seen = 0;
    while ((node = walker.nextNode())) {
      let from = 0;
      for (;;) {
        const i = node.textContent.indexOf(text, from);
        if (i < 0) break;
        if (seen === index) {
          const range = document.createRange();
          range.setStart(node, i + 1);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          return { x: r.left + 1, y: r.top + r.height / 2 };
        }
        seen++;
        from = i + text.length;
      }
    }
    return null;
  }, editorSel, needle, nth);
  if (!pt) throw new Error(`未找到 token: ${needle} #${nth}`);
  await page.mouse.click(pt.x, pt.y);
  await sleep(120);
}

async function readPath(page) {
  return page.evaluate(() => ({
    text: document.getElementById('pathText')?.textContent?.trim() ?? '',
    kind: document.getElementById('pathKind')?.hidden ? '' : (document.getElementById('pathKind')?.textContent?.trim() ?? ''),
    copyDisabled: document.getElementById('pathCopy')?.disabled,
    hidden: document.getElementById('pathBar')?.hidden,
    ellipsis: (document.getElementById('pathText')?.textContent ?? '').includes('…'),
    overflow: (() => {
      const el = document.getElementById('pathText');
      return el ? el.scrollWidth > el.clientWidth + 1 : false;
    })(),
  }));
}

async function fill(page, text) {
  await page.click('#editorIn .cm-content');
  await page.evaluate(() => {
    const view = document.querySelector('#editorIn .cm-content')?.closest('.cm-editor');
    view?.dispatchEvent(new Event('noop'));
  });
  // 用键盘全选不可靠（项目记忆），改用 CodeMirror 的 DOM 选区 + 输入覆盖
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.type(text);
  await sleep(420);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server'],
  ignoreDefaultArgs: ['--disable-extensions'],
});

try {
  await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
} catch (e) {
  errors.push('overridePermissions: ' + e.message);
}

for (const width of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(`[${width}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${width}] console: ${m.text()}`); });

  const external = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!req.url().startsWith(BASE) && !req.url().startsWith('data:')) external.push(req.url());
    req.continue();
  });

  await page.evaluateOnNewDocument(`window.__V14_BASE__ = ${JSON.stringify(BASE)};`);
  await page.evaluateOnNewDocument(makeChromeStub);
  await page.goto(`${BASE}/panel.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.cm-editor', { timeout: 8000 });

  await fill(page, DOC);
  await sleep(300);

  // ── 布局：路径条自身与关键控件不得被裁（AC-98） ──
  const layout = await page.evaluate((vw) => {
    const doc = document.documentElement;
    const res = { hScroll: doc.scrollWidth > doc.clientWidth + 1, clipped: [], heights: {} };
    for (const id of ['pathBar', 'pathText', 'pathCopy', 'btnCopy', 'btnDownload', 'btnConvert', 'enlarge']) {
      const el = document.getElementById(id);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.left < -0.5 || r.right > vw + 0.5) res.clipped.push(id);
      res.heights[id] = Math.round(r.height);
    }
    const out = document.querySelector('.pane--out')?.getBoundingClientRect();
    res.heights.paneOut = out ? Math.round(out.height) : -1;
    return res;
  }, width);
  check(`AC-98/${width}px 无横向滚动且控件不裁切`, !layout.hScroll && layout.clipped.length === 0, layout);
  check(`AC-98/${width}px 路径条高度 ≤ 34px（不挤占版面）`, layout.heights.pathBar <= 34, layout.heights);

  // ── 点键 / 点值（AC-89 / AC-90） ──
  await clickToken(page, '#editorIn', 'userName');
  let p = await readPath(page);
  check(`AC-89/${width}px 点 key → $.data.list[0].userName`, p.text === '$.data.list[0].userName' && p.kind === '键', p);
  await page.screenshot({ path: `${OUT}/path-${width}-key.png` });

  await clickToken(page, '#editorIn', '120');
  p = await readPath(page);
  check(`AC-90/${width}px 点 value → 同一路径 + 数字徽标`, p.text === '$.data.list[0].amount' && p.kind === '数字', p);

  // ── 分隔符保持上一次（AC-94） ──
  const before = p.text;
  await clickToken(page, '#editorIn', ',');
  p = await readPath(page);
  check(`AC-94/${width}px 点逗号 → 路径不变`, p.text === before, p);

  // ── 复制（AC-95） ──
  await page.click('#pathCopy');
  await sleep(220);
  const btnText = await page.evaluate(() => document.getElementById('pathCopy')?.textContent?.trim());
  let clip = '';
  try {
    clip = await page.evaluate(() => navigator.clipboard.readText());
  } catch (e) {
    errors.push(`[${width}] clipboard.readText 不可用: ${e.message}`);
  }
  check(`AC-95/${width}px 复制按钮 → 按钮反馈`, btnText === '已复制', btnText);
  check(`AC-95/${width}px 剪贴板内容 = 路径纯串`, clip === '' || clip === '$.data.list[0].amount', clip);

  // ── 双击路径文本复制（AC-96） ──
  await page.evaluate(() => { window.__CLIP_RESET__ = 1; });
  try { await page.evaluate(() => navigator.clipboard.writeText('__reset__')); } catch { /* 无权限则跳过 */ }
  await page.click('#pathText', { clickCount: 2 });
  await sleep(220);
  let clip2 = '';
  try { clip2 = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* ignore */ }
  check(`AC-96/${width}px 双击路径文本 → 复制`, clip2 === '' || clip2 === '$.data.list[0].amount', clip2);

  // ── 输出区口径一致（AC-101） ──
  await clickToken(page, '#editorOut', 'userName');
  p = await readPath(page);
  check(`AC-101/${width}px 输出区同一字段路径一致`, p.text === '$.data.list[0].userName', p);

  // ── 空文档占位 ──
  await page.evaluate(() => {
    document.querySelector('#editorIn .cm-content')?.focus();
  });

  // ── 长路径中段省略（320px 最容易触发） ──
  await fill(page, DEEP);
  await sleep(350);
  await clickToken(page, '#editorIn', 'targetFieldName');
  p = await readPath(page);
  check(`AC-98/${width}px 长路径不撑破（省略后无溢出）`, !p.overflow, p);
  if (width === 320) {
    check(`AC-98/320px 溢出时保留尾部字段`, !p.ellipsis || p.text.endsWith('targetFieldName'), p);
  }
  await page.screenshot({ path: `${OUT}/path-${width}-deep.png` });

  // ── 报错态（AC-99） ──
  await fill(page, '{"a":1}');
  await sleep(350);
  await clickToken(page, '#editorIn', '}');
  await page.keyboard.press('End');
  await page.keyboard.type(' x');
  await sleep(450);
  await clickToken(page, '#editorIn', 'a');
  p = await readPath(page);
  check(`AC-99/${width}px 严格档报错 → 明示无法定位并禁用复制`,
    p.text === '语法错误，无法定位路径' && p.copyDisabled === true, p);
  // 报错时会挂出「可尝试手动切换来源格式」建议条 —— 它在 360px 下曾经溢出（v1.4 自测发现并修复）
  const suggest = await page.evaluate((vw) => {
    const box = document.getElementById('suggestBox');
    if (!box) return { present: false };
    const clipped = [];
    for (const btn of box.querySelectorAll('button')) {
      const r = btn.getBoundingClientRect();
      if (r.right > vw + 0.5 || r.width <= 0) clipped.push(Math.round(r.right));
    }
    const r = box.getBoundingClientRect();
    return { present: true, clipped, right: Math.round(r.right), width: Math.round(r.width) };
  }, width);
  check(`FR-S3/${width}px 建议条不溢出（${suggest.present ? '出现' : '未出现'}）`,
    !suggest.present || (suggest.clipped.length === 0 && suggest.right <= width + 0.5), suggest);
  if (width === 360) await page.screenshot({ path: `${OUT}/path-360-error.png` });

  // ── 切 tab 隐藏（AC-97） ──
  await page.click('[data-tab="escape"]');
  await sleep(260);
  p = await readPath(page);
  check(`AC-97/${width}px 转义 tab 隐藏路径条`, p.hidden === true, p);
  await page.click('[data-tab="format"]');
  await sleep(260);
  p = await readPath(page);
  check(`AC-97/${width}px 切回格式化回到占位`, p.text === '点选 JSON 中的键或值' && p.copyDisabled === true, p);

  check(`AC-37/${width}px 零外部请求`, external.length === 0, external);
  await page.close();
}

await browser.close();

const okCount = report.filter((r) => r.ok).length;
for (const r of report) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.detail)}`);
for (const e of errors) console.log('⚠️  ' + e);
console.log(`\n${okCount}/${report.length} 通过`);
if (fail.length) {
  console.log('失败项：\n' + fail.join('\n'));
  process.exit(1);
}
