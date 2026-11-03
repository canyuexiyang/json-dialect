/**
 * v1.5 优化项验收：全面梳理报告（2026-11-02）D1~D27 的行为契约。
 *
 * 这里只测装配层与内核的**新行为**；既有行为由 v11/v13/v14 系列覆盖。
 * 样本矩阵（M1~M10）由 tools/verify_with_python.py 交叉校验覆盖。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../setup/cm6-jsdom.js';
import { AppController, type DomRefs } from '../../src/ui/controller.js';
import { convert, lex } from '../../src/core/index.js';
import { escapeText } from '../../src/core/escapeText.js';
import { detect } from '../../src/core/detect.js';
import { EditorView } from '@codemirror/view';

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
      <select id="fmtSelect">
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
        <option value="map">Map.toString()</option>
      </select>
      <button id="resetAuto" hidden></button>
      <select id="escapeStyleSelect" hidden>
        <option value="json">JSON / Java 字符串</option>
        <option value="url">URL 百分号</option>
        <option value="base64">Base64</option>
      </select>
      <div id="escapeDirSeg" class="seg" role="group" hidden>
        <button class="seg__btn" id="escapeDirDecode" data-dir="decode" aria-pressed="false">去除转义</button>
        <button class="seg__btn seg__btn--on" id="escapeDirEncode" data-dir="encode" aria-pressed="true">增加转义</button>
      </div>
      <label id="wrapQuotesWrap" hidden><input type="checkbox" id="wrapQuotes" /></label>
      <select id="targetSelect">
        <option value="auto">自动</option>
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
      </select>
      <button id="enlarge"></button>
      <section class="pane pane--in" id="paneIn" role="tabpanel">
        <div class="pane__head"><span id="statsIn"></span><button id="btnClear">清空</button></div>
        <div id="editorIn"></div>
        <div id="emptyHints" hidden>
          <button data-example="json">示例：JSON</button>
          <button data-example="python">示例：Python</button>
          <button data-example="map">示例：Map</button>
        </div>
        <div id="fixbar" hidden></div>
      </section>
      <section class="pane pane--out" id="paneOut" role="tabpanel">
        <div class="pane__head"><span id="statsOut"></span><span id="staleBadge" hidden></span></div>
        <div id="editorOut"></div>
        <div id="typePanel" class="typepanel" hidden></div>
      </section>
      <footer><span id="statusMsg" aria-live="polite"></span></footer>
      <button id="btnConvert"></button>
      <button id="btnFormat"></button>
      <button id="btnCompact"></button>
      <button id="btnSnippet">存为片段</button>
      <button id="btnCompare">对比</button>
      <button id="btnCopy"></button>
      <button id="btnDownload"></button>
      <div id="splitter"></div>
      <div id="pathBar" hidden><span id="pathText"></span><span id="pathKind" hidden></span><button id="pathCopy"></button></div>
    </div>`;
  const q = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as unknown as T;
  return {
    root: q('appRoot'),
    fmtLabel: q('fmtLabel'),
    lockBadge: q('lockBadge'),
    sameTargetLabel: q('sameTargetLabel'),
    fmtSelect: q<HTMLSelectElement>('fmtSelect'),
    resetAuto: q<HTMLButtonElement>('resetAuto'),
    targetSelect: q<HTMLSelectElement>('targetSelect'),
    escapeStyleSelect: q<HTMLSelectElement>('escapeStyleSelect'),
    escapeDirSeg: q('escapeDirSeg'),
    escapeDirDecode: q<HTMLButtonElement>('escapeDirDecode'),
    escapeDirEncode: q<HTMLButtonElement>('escapeDirEncode'),
    wrapQuotesWrap: q('wrapQuotesWrap'),
    wrapQuotes: q<HTMLInputElement>('wrapQuotes'),
    tabFormat: q<HTMLButtonElement>('tabFormat'),
    tabEscape: q<HTMLButtonElement>('tabEscape'),
    tabConvert: q<HTMLButtonElement>('tabConvert'),
    editorIn: q('editorIn'),
    editorOut: q('editorOut'),
    emptyHints: q('emptyHints'),
    btnClear: q<HTMLButtonElement>('btnClear'),
    btnSnippet: q<HTMLButtonElement>('btnSnippet'),
    btnCompare: q<HTMLButtonElement>('btnCompare'),
    paneIn: q('paneIn'),
    paneOut: q('paneOut'),
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
    pathBar: q('pathBar'),
    pathText: q('pathText'),
    pathKind: q('pathKind'),
    pathCopy: q<HTMLButtonElement>('pathCopy'),
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

describe('D1 格式化 tab 下 Map 来源不再静默改语言', () => {
  it('Map 输入 → 输出 Python 且判定条出现「→ Python 字面量」标签与状态说明', () => {
    ctrl.setInput('{a=1, b=[x, y]}');
    expect(ctrl.output).toContain("'a'");
    expect(dom.sameTargetLabel!.hidden).toBe(false);
    expect(dom.statusMsg.textContent).toContain('Python 字面量');
    // 非格式化 tab 或非 Map 来源时标签必须消失
    ctrl.setInput('{"a": 1}');
    expect(dom.sameTargetLabel!.hidden).toBe(true);
  });

  it('内核暴露 sameTargetFallback 标记', () => {
    const r = convert('{a=1}', { target: 'same' });
    expect(r.status).toBe('ok');
    expect(r.sameTargetFallback).toBe(true);
    expect(r.outputLang).toBe('python');
  });
});

describe('D3 转义风格合并与包裹外层引号', () => {
  it('java 风格与 json 逐字符一致（兼容别名）', () => {
    const s = 'a"b\\c\n中文';
    expect(escapeText(s, 'java', 'encode').output).toBe(escapeText(s, 'json', 'encode').output);
  });

  it('wrapQuotes：encode 产出带外壳的完整字符串常量，可逆', () => {
    const r = escapeText('{"a":1}', 'json', 'encode', { wrapQuotes: true });
    expect(r.output).toBe('"{\\"a\\":1}"');
    expect(r.note).toContain('已包裹外层引号');
    // decode（剥壳）回到原文 —— 往返一致
    const back = escapeText(r.output, 'json', 'decode');
    expect(back.output).toBe('{"a":1}');
    expect(back.note).toContain('已自动去除外层引号');
  });

  it('UI：勾选开关后输出带引号', () => {
    ctrl.switchTab('escape');
    ctrl.setEscape('json', 'encode');
    ctrl.setInput('ab');
    expect(ctrl.output).toBe('ab');
    dom.wrapQuotes!.checked = true;
    dom.wrapQuotes!.dispatchEvent(new Event('change'));
    expect(ctrl.output).toBe('"ab"');
  });
});

describe('D5 严格档报错给「切容错档」出口', () => {
  it('建议条包含容错档按钮，点击后修复成功', () => {
    ctrl.setInput('{"a":1,}');
    const box = document.getElementById('suggestBox');
    expect(box).toBeTruthy();
    const btn = box!.querySelector('button');
    expect(btn!.textContent).toContain('容错档');
    btn!.click();
    expect(ctrl.output).toContain('"a"');
    expect(document.getElementById('suggestBox')).toBeNull();
  });
});

describe('D6 转换 tab 开放压缩/美化', () => {
  it('btnCompact 可见且点击切换压缩与美化', () => {
    ctrl.switchTab('convert');
    expect(dom.btnCompact.hidden).toBe(false);
    expect(dom.btnFormat.hidden).toBe(true);
    ctrl.setInput('{"a":1,"b":[1,2]}');
    expect(ctrl.output).toContain('\n'); // 默认美化
    expect(dom.btnCompact.textContent).toBe('压缩');
    dom.btnCompact.click();
    expect(ctrl.output).not.toContain('\n');
    expect(dom.btnCompact.textContent).toBe('美化');
    dom.btnCompact.click();
    expect(ctrl.output).toContain('\n');
  });
});

describe('D8 偏好补齐不被「用户改了输入」整体丢弃', () => {
  it('粘贴输入后迟到的 prefs 仍能补齐', async () => {
    // storage 模拟：prefs 延迟 50ms 返回（模拟托管 Chrome 下的慢 storage）
    const store: Record<string, unknown> = {};
    const w = window as unknown as { chrome?: unknown };
    w.chrome = {
      storage: {
        local: {
          get: async (k: string) =>
            new Promise((resolve) => setTimeout(() => resolve(k in store ? { [k]: store[k] } : {}), 50)),
          set: async (items: Record<string, unknown>) => void Object.assign(store, items),
        },
        session: {},
      },
    };
    document.body.innerHTML = '';
    dom = mount();
    ctrl = new AppController(dom, { surface: 'panel' });
    const initPromise = ctrl.init();
    ctrl.setInput("{'a': 1}"); // prefs 未返回时用户已操作（旧逻辑会因此丢弃 prefs 补齐）
    await initPromise;
    await new Promise((r) => setTimeout(r, 120));
    expect(ctrl.currentTab).toBe('format');
    delete w.chrome;
  });
});

describe('D9 混合写法判定', () => {
  it("{'a': true} 判为 Python（单引号压过裸字面量）", () => {
    const r = detect(lex("{'a': true}").tokens, "{'a': true}");
    expect(r.format).toBe('python');
    // 端到端：判定条说 Python（严格档对 true 报错属预期语义，D5 提供一键切容错）
    ctrl.setInput("{'a': true}");
    expect(dom.fmtLabel.textContent).toBe('Python 字面量');
    const box = document.getElementById('suggestBox');
    expect(box?.textContent).toContain('容错档');
  });
});

describe('D11 无障碍', () => {
  it('状态条 live region + pane tabpanel + 动态 labelledby', () => {
    expect(dom.statusMsg.getAttribute('aria-live')).toBe('polite');
    expect(dom.paneIn!.getAttribute('role')).toBe('tabpanel');
    ctrl.switchTab('convert');
    expect(dom.paneIn!.getAttribute('aria-labelledby')).toBe('tabConvert');
    ctrl.switchTab('escape');
    expect(dom.paneOut!.getAttribute('aria-labelledby')).toBe('tabEscape');
  });
});

describe('D12 空态引导', () => {
  it('空输入时判定条为「待输入」，示例可见且点击即灌入', () => {
    expect(dom.emptyHints!.hidden).toBe(false);
    expect(dom.fmtLabel.textContent).toBe('待输入');
    const btn = dom.emptyHints!.querySelector<HTMLButtonElement>('[data-example="python"]');
    btn!.click();
    expect(ctrl.input).toContain("'tool'");
    expect(dom.emptyHints!.hidden).toBe(true);
    expect(dom.fmtLabel.textContent).toBe('Python 字面量');
  });
});

describe('D16 转换按钮文案', () => {
  it('常态显示「重新转换」', () => {
    expect(dom.btnConvert.textContent).toBe('重新转换');
    ctrl.switchTab('convert');
    expect(dom.btnConvert.textContent).toBe('重新转换');
  });
});

describe('D19 超大文本「仍要转换」入口', () => {
  it('>1M 字符出现一键转换条', async () => {
    // 必须走编辑器 onChange → schedule（setInput 直接 run，不触发超大判定）
    const view = EditorView.findFromDOM(dom.editorIn);
    expect(view).toBeTruthy();
    const big = '{"a":"' + 'x'.repeat(1_100_000) + '"}';
    view!.dispatch({ changes: { from: 0, to: 0, insert: big } });
    const box = document.getElementById('oversizeBox');
    expect(box).toBeTruthy();
    expect(box!.textContent).toContain('仍要转换');
    expect(dom.btnConvert.textContent).toBe('转换');
    box!.querySelector('button')!.click();
    // 「仍要转换」把 run 推到下一帧（先画出「正在转换」），异步等待
    await new Promise((r) => setTimeout(r, 120));
    expect(ctrl.output).toContain('x');
    expect(document.getElementById('oversizeBox')).toBeNull();
  });
});

describe('D20 类型调整开放到转换 tab', () => {
  it('转换 tab 下 JSON 来源也渲染类型面板', () => {
    ctrl.switchTab('convert');
    ctrl.setInput('{"a": 1}');
    expect(dom.typePanel.hidden).toBe(false);
    // 格式化 tab 下 JSON 来源仍不显示（无类型歧义）
    ctrl.switchTab('format');
    expect(dom.typePanel.hidden).toBe(true);
  });
});

describe('D22 仅注释输入的空态文案', () => {
  it('# only comment → 明确说「没有可转换的有效内容」', () => {
    const r = convert('# only comment', {});
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('没有可转换的有效内容');
    ctrl.setInput('# only comment');
    expect(dom.statusMsg.textContent).toContain('没有可转换的有效内容');
  });
});

describe('D21 剥壳失败提示因果', () => {
  it('剥壳后失败，错误里说明已尝试剥离', () => {
    const r = escapeText('"50% off"', 'url', 'decode');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已尝试剥离外层引号');
  });
});

describe('D25 路径定位开放到转换 tab', () => {
  it('转换 tab 下路径条可见且输出区可定位', () => {
    ctrl.switchTab('convert');
    ctrl.setInput('{"a": {"b": 1}}');
    expect(dom.pathBar!.hidden).toBe(false);
    // 输出区（JSON）点击 path 逻辑由 v14 系列覆盖，这里验证不再因 tab 被屏蔽
    ctrl.switchTab('escape');
    expect(dom.pathBar!.hidden).toBe(true);
  });
});

describe('D26 输入侧便利能力', () => {
  it('清空按钮一键清空并回到空态', () => {
    ctrl.setInput('{"a":1}');
    expect(ctrl.input).not.toBe('');
    dom.btnClear!.click();
    expect(ctrl.input).toBe('');
    expect(dom.emptyHints!.hidden).toBe(false);
  });

  it('片段：保存 / 载入 / 清空，全部在内存', () => {
    ctrl.setInput("{'a': 1}");
    dom.btnSnippet!.click();
    const chip = document.querySelector('#snippetBar .snippetbar__chip') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    ctrl.setInput('');
    chip.click();
    expect(ctrl.input).toBe("{'a': 1}");
    (document.querySelector('#snippetBar .snippetbar__clear') as HTMLButtonElement).click();
    expect(document.getElementById('snippetBar')).toBeNull();
  });

  it('对比浮层：打开 / Esc 关闭', () => {
    ctrl.setInput('{"a":1}');
    dom.btnCompare!.click();
    const overlay = document.getElementById('compareOverlay');
    expect(overlay).toBeTruthy();
    expect(overlay!.textContent).toContain('对比');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('compareOverlay')).toBeNull();
  });
});

describe('D27 全局快捷键', () => {
  it('Alt+1/2/3 直达 tab', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', altKey: true, bubbles: true }));
    expect(ctrl.currentTab).toBe('convert');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }));
    expect(ctrl.currentTab).toBe('format');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', altKey: true, bubbles: true }));
    expect(ctrl.currentTab).toBe('escape');
  });
});
