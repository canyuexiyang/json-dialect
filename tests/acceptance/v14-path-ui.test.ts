/**
 * v1.4 路径条 UI 验收（AC-89～AC-101 / AC-103 / AC-104）
 *
 * 这一层测的是**装配契约**：光标事件 → 内核定位 → 路径条渲染 → 复制。
 * 内核正确性由 tests/unit/path.test.ts 覆盖，这里刻意不重复。
 *
 * 用真实 shell 模板挂载（而不是手写 fixture），顺带锁住模板里的节点 id：
 * 模板 id 写错时，症状与「功能没做」一模一样。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup/cm6-jsdom.js';
import { EditorView } from '@codemirror/view';
import { mountShell } from '../../src/ui/shell.js';
import { AppController } from '../../src/ui/controller.js';

const JSON_TEXT = '{"data":{"list":[{"userName":"张三","age":30}]}}';

let ctrl: AppController;
let written: string[];
let storageSets: number;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('缺少节点 #' + id);
  return node as T;
}

function viewOf(id: string): EditorView {
  const view = EditorView.findFromDOM(el(id));
  if (!view) throw new Error('找不到编辑器: #' + id);
  return view;
}

/** 把光标放到指定偏移（模拟点击 / 方向键 → selectionSet） */
function cursor(id: string, offset: number): void {
  viewOf(id).dispatch({ selection: { anchor: offset } });
}

function pathText(): string {
  return el('pathText').textContent ?? '';
}

function kindText(): string {
  return el('pathKind').textContent ?? '';
}

function copyBtn(): HTMLButtonElement {
  return el<HTMLButtonElement>('pathCopy');
}

beforeEach(async () => {
  written = [];
  storageSets = 0;
  vi.stubGlobal('navigator', {
    clipboard: { writeText: async (t: string) => { written.push(t); } },
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => { storageSets++; },
      },
      session: { set: async () => {}, get: async () => ({}), remove: async () => {} },
    },
  });
  document.body.innerHTML = '<div id="app"></div>';
  const dom = mountShell('tab');
  ctrl = new AppController(dom, { surface: 'tab' });
  await ctrl.init('');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('AC-89 / AC-90 键与值同路径、徽标区分', () => {
  it('点键 → 路径 + 「键」徽标', () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    expect(pathText()).toBe('$.data.list[0].userName');
    expect(kindText()).toBe('键');
    expect(copyBtn().disabled).toBe(false);
  });

  it('点值 → 同一条路径 + 值类型徽标', () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('张三'));
    expect(pathText()).toBe('$.data.list[0].userName');
    expect(kindText()).toBe('字符串');
  });

  it('点对象大括号 → 容器路径', () => {
    ctrl.setInput('{"a":{"b":1}}');
    cursor('editorIn', '{"a":'.length);
    expect(pathText()).toBe('$.a');
    expect(kindText()).toBe('对象');
  });
});

describe('AC-94 分隔符上保持上一次，不闪断', () => {
  it('先命中元素，再落到逗号 → 文案不变', () => {
    ctrl.setInput(JSON_TEXT);
    const nameAt = JSON_TEXT.indexOf('"userName"');
    cursor('editorIn', nameAt);
    const first = pathText();
    cursor('editorIn', JSON_TEXT.indexOf(','));
    expect(pathText()).toBe(first);
    expect(kindText()).toBe('键');
  });

  it('从未命中过时保持占位（前导空白不算元素）', () => {
    ctrl.setInput('  {"a":1}');
    cursor('editorIn', 0);
    expect(pathText()).toBe('点选 JSON 中的键或值');
    expect(copyBtn().disabled).toBe(true);
  });
});

describe('AC-95 / AC-96 复制链路', () => {
  it('点复制按钮 → 剪贴板收到路径纯串，按钮反馈「已复制」', async () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    copyBtn().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual(['$.data.list[0].userName']);
    expect(copyBtn().textContent).toBe('已复制');
  });

  it('双击路径文本 → 等价复制（且不阻止选中）', async () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    el('pathText').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual(['$.data.list[0].userName']);
  });

  it('回车键复制（a11y）', async () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    el('pathBar').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual(['$.data.list[0].userName']);
  });

  it('AC-103 复制取程序产物，不取 DOM —— 污染 DOM 也不影响结果', async () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    el('pathText').textContent = '被污染的文字';
    copyBtn().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual(['$.data.list[0].userName']);
  });
});

describe('AC-101 输入区与输出区路径口径一致', () => {
  it('同一字段在两侧得到完全相同的路径', () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    const inPath = pathText();

    // 输出是美化后的另一份文本（坐标系不同），必须各自解析
    const outText = viewOf('editorOut').state.doc.toString();
    expect(outText).not.toBe(JSON_TEXT);
    expect(outText).toContain('"userName"');
    cursor('editorOut', outText.indexOf('"userName"'));
    expect(pathText()).toBe(inPath);
  });

  it('输出区可点（只读编辑器也允许选光标）', () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorOut', viewOf('editorOut').state.doc.toString().indexOf('张三'));
    expect(pathText()).toBe('$.data.list[0].userName');
    expect(kindText()).toBe('字符串');
  });
});

describe('AC-97 切 tab 隐藏并清空', () => {
  it('切到转义 tab：路径条隐藏、内容清空；切回格式化是占位而非旧路径', () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    expect(pathText()).toBe('$.data.list[0].userName');

    ctrl.switchTab('escape');
    expect(el('pathBar').hidden).toBe(true);
    expect(pathText()).toBe('点选 JSON 中的键或值');
    expect(copyBtn().disabled).toBe(true);

    ctrl.switchTab('format');
    expect(el('pathBar').hidden).toBe(false);
    expect(pathText()).toBe('点选 JSON 中的键或值');
  });
});

describe('AC-99 严格档报错：输入区不可定位，输出区仍可', () => {
  it('报错时明确说明原因并禁用复制', () => {
    ctrl.setInput(JSON_TEXT);
    ctrl.setInput('{"a":1,}');
    cursor('editorIn', 1);
    expect(pathText()).toBe('语法错误，无法定位路径');
    expect(copyBtn().disabled).toBe(true);
    expect(el('pathKind').hidden).toBe(true);
  });

  it('报错后输出区（上次成功结果）依旧可定位', () => {
    ctrl.setInput(JSON_TEXT);
    ctrl.setInput('{"a":1,}');
    const outText = viewOf('editorOut').state.doc.toString();
    expect(outText).toContain('"userName"'); // 报错时保留上次成功结果（FR-D7）
    cursor('editorOut', outText.indexOf('"userName"'));
    expect(pathText()).toBe('$.data.list[0].userName');
  });
});

describe('AC-100 Java 转义格式明示不支持', () => {
  it('来源为 Java 转义 → 提示不支持，绝不给出近似路径', () => {
    const javaText = String.raw`"{\"a\":1}"`;
    ctrl.setInput(javaText);
    cursor('editorIn', 3);
    expect(pathText()).toBe('该格式不支持路径定位');
    expect(copyBtn().disabled).toBe(true);
  });
});

describe('AC-104 零落盘 / 无副作用', () => {
  it('光标移动与复制都不写 storage', async () => {
    ctrl.setInput(JSON_TEXT);
    const before = storageSets;
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    cursor('editorIn', JSON_TEXT.indexOf(':'));
    copyBtn().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(storageSets).toBe(before);
  });

  it('路径条具备可访问性属性', () => {
    expect(el('pathBar').getAttribute('tabindex')).toBe('0');
    expect(el('pathBar').getAttribute('aria-label')).toContain('路径');
    expect(el('pathText').getAttribute('role')).toBe('status');
    expect(el('pathText').getAttribute('aria-live')).toBe('polite');
  });
});

describe('空文档与初次挂载', () => {
  it('空输入显示占位、按钮禁用', () => {
    expect(el('pathBar').hidden).toBe(false);
    expect(pathText()).toBe('点选 JSON 中的键或值');
    expect(copyBtn().disabled).toBe(true);
  });

  it('输入为空时不残留上一次路径', () => {
    ctrl.setInput(JSON_TEXT);
    cursor('editorIn', JSON_TEXT.indexOf('"userName"'));
    ctrl.setInput('');
    expect(pathText()).toBe('点选 JSON 中的键或值');
    expect(copyBtn().disabled).toBe(true);
  });
});
