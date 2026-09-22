/**
 * v1.1 UI 层验收：tab 框架与三链路（AC-68 / FR-L1~L4 / FR-K1~K4 / FR-I1~I4）
 *
 * 这里只测 UI 装配层的行为契约，内核正确性由 v11-acceptance.test.ts 覆盖。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../setup/cm6-jsdom.js';
import { AppController, type DomRefs } from '../../src/ui/controller.js';

function mount(): DomRefs {
  document.body.innerHTML = `
    <div class="app">
      <nav class="tabbar" role="tablist">
        <button class="tab" id="tabFormat" data-tab="format" aria-selected="true">格式化</button>
        <button class="tab" id="tabEscape" data-tab="escape" aria-selected="false">转义</button>
        <button class="tab" id="tabConvert" data-tab="convert" aria-selected="false">转换</button>
      </nav>
      <span id="fmtLabel"></span>
      <span id="lockBadge" hidden></span>
      <select id="fmtSelect">
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
        <option value="map">Map.toString()</option>
      </select>
      <button id="resetAuto" hidden></button>
      <select id="escapeStyleSelect" hidden>
        <option value="json">JSON 字符串</option>
        <option value="java">Java 字符串</option>
        <option value="url">URL 百分号</option>
        <option value="base64">Base64</option>
      </select>
      <div id="escapeDirSeg" class="seg" role="group" hidden>
        <button class="seg__btn" id="escapeDirDecode" data-dir="decode" aria-pressed="false">去除转义</button>
        <button class="seg__btn" id="escapeDirEncode" data-dir="encode" aria-pressed="true">增加转义</button>
      </div>
      <select id="targetSelect">
        <option value="auto">自动</option>
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
      </select>
      <button id="enlarge"></button>
      <div class="pane--in"><div id="editorIn"></div></div>
      <div class="pane--out"><div id="editorOut"></div></div>
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
    targetSelect: q<HTMLSelectElement>('targetSelect'),
    escapeStyleSelect: q<HTMLSelectElement>('escapeStyleSelect'),
    escapeDirSeg: q('escapeDirSeg'),
    escapeDirDecode: q<HTMLButtonElement>('escapeDirDecode'),
    escapeDirEncode: q<HTMLButtonElement>('escapeDirEncode'),
    tabFormat: q<HTMLButtonElement>('tabFormat'),
    tabEscape: q<HTMLButtonElement>('tabEscape'),
    tabConvert: q<HTMLButtonElement>('tabConvert'),
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

let ctrl: AppController;
let dom: DomRefs;

beforeEach(async () => {
  dom = mount();
  window.matchMedia =
    window.matchMedia ??
    ((q: string) =>
      ({
        matches: false,
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList);
  ctrl = new AppController(dom);
  await ctrl.init();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AC-68 tab 框架（FR-L1 / FR-L2 / FR-L3）', () => {
  it('默认选中「格式化」', () => {
    expect(ctrl.currentTab).toBe('format');
    const tabFormat = dom.tabFormat!;
    expect(tabFormat.getAttribute('aria-selected')).toBe('true');
    expect(tabFormat.classList.contains('tab--on')).toBe(true);
  });

  it('顺序固定为 格式化 · 转义 · 转换', () => {
    const bar = document.querySelector('.tabbar')!;
    const ids = Array.prototype.map.call(bar.querySelectorAll('.tab'), (b: Element) => b.id);
    expect(ids).toEqual(['tabFormat', 'tabEscape', 'tabConvert']);
  });

  it('切换 tab 会更新选中态与按钮语义', () => {
    ctrl.switchTab('escape');
    expect(dom.tabEscape!.getAttribute('aria-selected')).toBe('true');
    expect(dom.tabFormat!.getAttribute('aria-selected')).toBe('false');
    // 转义 tab 下隐藏来源/目标选择器（纯文本通道，无格式概念）
    expect(dom.fmtSelect.hidden).toBe(true);
    expect(dom.targetSelect!.hidden).toBe(true);
    // FR-I5：方向由常驻二选一控件表达，底部按钮说清「反向会变成什么」
    expect(dom.btnConvert.textContent).toBe('反向：去除转义');
  });

  it('FR-L3 历史偏好覆盖默认值（放大页继承）', async () => {
    document.body.innerHTML = '';
    const d2 = mount();
    const c2 = new AppController(d2);
    await c2.init('', { tab: 'convert' });
    expect(c2.currentTab).toBe('convert');
  });

  it('非法继承值回落到默认 tab，不崩溃', async () => {
    document.body.innerHTML = '';
    const d2 = mount();
    const c2 = new AppController(d2);
    await c2.init('', { tab: '<script>' } as Record<string, unknown> as never);
    expect(c2.currentTab).toBe('format');
  });
});

describe('格式化 tab（FR-K1 / FR-K2 / FR-K4）', () => {
  it('默认严格档：语法残缺直接报错', () => {
    ctrl.setInput('{"a":1,}');
    expect(dom.statusMsg.classList.contains('statusmsg--error')).toBe(true);
    expect(dom.btnCopy.disabled).toBe(true);
  });

  it('AC-70 切到容错档后修复成功并列出修正记录', () => {
    ctrl.setInput('{"a":1,}');
    ctrl.toggleStrict();
    expect(dom.fixbar.hidden).toBe(false);
    expect(dom.fixbar.textContent).toContain('已自动修正');
    expect(dom.fixbar.textContent).toContain('删除末尾多余逗号');
  });

  it('档位按钮文案反映当前状态', () => {
    ctrl.setInput('{"a":1}');
    expect(dom.btnFormat.textContent).toBe('档位：严格');
    ctrl.toggleStrict();
    expect(dom.btnFormat.textContent).toBe('档位：容错');
  });

  it('FR-K4 美化 / 压缩二选一', () => {
    ctrl.setInput('{"a":1,"b":2}');
    expect(ctrl.output).toContain('\n');
    ctrl.toggleCompact();
    expect(ctrl.output).not.toContain('\n');
    expect(dom.btnCompact.textContent).toBe('缩进：压缩');
  });

  it('FR-A19 格式化是同语言进出：JSON 进去 JSON 出来', () => {
    ctrl.setInput('{"a":1,"b":[1,2]}');
    expect(ctrl.output).toContain('"a": 1');
    // 不得变成 Python 字面量
    expect(ctrl.output).not.toContain("'a'");
  });
});

describe('转义 tab（FR-I1 / FR-I3 / FR-I4）', () => {
  it('AC-71 中文 Base64 编码', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('base64', 'encode');
    ctrl.setInput('中文');
    expect(ctrl.output).toBe('5Lit5paH');
  });

  it('AC-73 非法 Base64 报错且禁用复制', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('base64', 'decode');
    ctrl.setInput('!!!');
    expect(ctrl.output).toBe('');
    expect(dom.btnCopy.disabled).toBe(true);
    expect(dom.statusMsg.textContent).toContain('Base64');
  });

  it('FR-I1 转义 tab 不解析结构：任意文本都能编码', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('url', 'encode');
    ctrl.setInput('不是 JSON，也没有结构 {{{');
    expect(ctrl.output).toContain('%');
    expect(dom.statusMsg.classList.contains('statusmsg--error')).toBe(false);
  });

  it('FR-I2 四种风格可选，且只在转义 tab 出现', () => {
    // 非转义 tab：风格选择器隐藏
    expect(dom.escapeStyleSelect!.hidden).toBe(true);

    ctrl.switchTab('escape');
    const sel = dom.escapeStyleSelect!;
    expect(sel.hidden).toBe(false);
    const opts = Array.prototype.map.call(sel.options, (o: HTMLOptionElement) => o.value);
    expect(opts).toEqual(['json', 'java', 'url', 'base64']);

    // 切到 Base64 后立即生效
    sel.value = 'base64';
    sel.dispatchEvent(new Event('change'));
    ctrl.setInput('中文');
    expect(ctrl.output).toBe('5Lit5paH');
  });

  it('FR-I5 方向二选一常驻可见，默认「增加转义」', () => {
    ctrl.switchTab('escape');
    expect(dom.escapeDirSeg!.hidden).toBe(false);
    expect(ctrl.currentEscapeDir).toBe('encode');
    expect(dom.escapeDirEncode!.getAttribute('aria-pressed')).toBe('true');
    expect(dom.escapeDirDecode!.getAttribute('aria-pressed')).toBe('false');
    expect(dom.escapeDirEncode!.classList.contains('seg__btn--on')).toBe(true);
  });

  it('FR-I5 点「去除转义」立即生效，且底部按钮同步为反向', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('json', 'encode');
    ctrl.setInput('{"a":1}');
    expect(ctrl.output).toBe('{\\"a\\":1}');

    dom.escapeDirDecode!.click();
    expect(ctrl.currentEscapeDir).toBe('decode');
    expect(dom.escapeDirDecode!.getAttribute('aria-pressed')).toBe('true');
    expect(dom.escapeDirEncode!.getAttribute('aria-pressed')).toBe('false');
    expect(dom.btnConvert.textContent).toBe('反向：增加转义');
  });

  it('FR-I5 底部「反向」按钮等价于翻转方向控件', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('json', 'encode');
    dom.btnConvert.click();
    expect(ctrl.currentEscapeDir).toBe('decode');
    expect(dom.btnConvert.textContent).toBe('反向：增加转义');
    dom.btnConvert.click();
    expect(ctrl.currentEscapeDir).toBe('encode');
    expect(dom.btnConvert.textContent).toBe('反向：去除转义');
  });

  it('FR-I6 去除转义时自动脱掉外层引号，并显式提示', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('json', 'decode');
    ctrl.setInput('"{\\"a\\":1}"'); // 从代码里复制出来的常量，自带外层引号
    expect(ctrl.output).toBe('{"a":1}');
    expect(dom.statusMsg.textContent).toContain('已自动去除外层引号');
  });

  it('FR-I6 不得误伤含引号的正常文本', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('json', 'decode');
    ctrl.setInput('a" + "b');
    expect(ctrl.output).toBe('a" + "b');
  });

  it('FR-I7 四种风格往返一致（增加转义 → 去除转义）', () => {
    ctrl.switchTab('escape');
    const samples: Array<[string, string]> = [
      ['{"a":1}', 'json'],
      ['{"msg":"he said "}', 'java'],
      ['中文 ?&=', 'url'],
      ['中文', 'base64'],
    ];
    for (const [text, style] of samples) {
      ctrl.setEscape(style as never, 'encode');
      ctrl.setInput(text);
      const enc = ctrl.output;
      expect(enc).not.toBe('');
      ctrl.setEscape(style as never, 'decode');
      ctrl.setInput(enc);
      expect(ctrl.output).toBe(text);
    }
  });
});

describe('AC-58/59 日志前缀一键剥离（FR-D13 / FR-D14）', () => {
  it('报错时给出「剥离后重试」入口', () => {
    ctrl.switchTab('convert');
    ctrl.setInput('2024-01-01 12:00:00 INFO {"a":1}');
    const box = document.getElementById('prefixHintBox');
    expect(box).not.toBeNull();
    const btn = Array.prototype.find.call(
      box?.querySelectorAll('button') ?? [],
      (b: HTMLButtonElement) => b.textContent === '剥离后重试',
    );
    expect(btn).toBeDefined();
  });

  it('点击后恢复成功，并显示被剥离的内容（FR-D14）', () => {
    ctrl.switchTab('convert');
    ctrl.setInput('2024-01-01 12:00:00 INFO {"a":1}');
    const box = document.getElementById('prefixHintBox')!;
    const btn = Array.prototype.find.call(
      box.querySelectorAll('button'),
      (b: HTMLButtonElement) => b.textContent === '剥离后重试',
    ) as HTMLButtonElement;
    btn.click();

    expect(ctrl.output).toContain("'a': 1");
    // 剥离了什么必须可见
    expect(dom.fixbar.textContent).toContain('剥离日志前缀');
    expect(dom.fixbar.textContent).toContain('2024-01-01');
  });

  it('AC-61 无前缀输入不出现剥离入口', () => {
    ctrl.switchTab('convert');
    ctrl.setInput('{"a":1}');
    expect(document.getElementById('prefixHintBox')).toBeNull();
  });
});
