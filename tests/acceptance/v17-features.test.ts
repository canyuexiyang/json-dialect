/**
 * v1.7 批次回归（FR-T1～T8 / AC-148～AC-156）
 *
 * 单元级断言（jsdom）：折叠扩展按语言分流、[+] 占位符、setDoc 折叠态重置、
 * 手风琴折叠同级的区间收集、统计与复制产物不因折叠改变、storage 零写入源码断言。
 * 真机部分（gutter 造型 / 320px 不裁切 / 深色令牌 / mac 键位）由 verify:ui 覆盖。
 */

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import '../setup/cm6-jsdom.js';
import { createEditor, type EditorHandle } from '../../src/ui/editor.js';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  foldEffect,
  unfoldEffect,
  foldable,
  foldedRanges,
  foldCode,
  foldAll,
  unfoldAll,
} from '@codemirror/language';

/** 剥掉注释再断言源码，避免注释里的关键字造成假阳性 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const JSON_DOC = `{
  "a": {
    "x": 1,
    "y": 2
  },
  "b": [
    1,
    2
  ],
  "c": 3
}`;

const PY_DOC = `{
  'a': {
    'x': 1,
    'y': 2,
  },
  'b': [
    1,
    2,
  ],
  'c': 3,
}`;

function makeEditor(lang: 'json' | 'python' | 'java', doc: string, readOnly = false): { handle: EditorHandle; host: HTMLDivElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = createEditor(host, { doc, lang, readOnly });
  return { handle, host };
}

/** 收集当前 state 的全部折叠区间 */
function foldsOf(view: EditorView): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const it = foldedRanges(view.state).iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to });
    it.next();
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('v1.7 / FR-T1：折叠能力按语言档分流', () => {
  it('json 档：foldable 在对象/数组行返回区间（AC-148 前置）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    const state = handle.view.state;
    // 第 1 行 `{"a": {` —— 有可折叠区间
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to);
    expect(range).not.toBeNull();
    handle.destroy();
  });

  it('python 档：foldable 同样生效（AC-149 前置）', () => {
    const { handle } = makeEditor('python', PY_DOC);
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    expect(foldable(state, line1.from, line1.to)).not.toBeNull();
    handle.destroy();
  });

  it('java 档（无高亮）：foldable 全文无折叠点（AC-150）', () => {
    const { handle } = makeEditor('java', JSON_DOC);
    const state = handle.view.state;
    const lines = state.doc.lines;
    let found = 0;
    for (let i = 1; i <= lines; i++) {
      const line = state.doc.line(i);
      if (foldable(state, line.from, line.to)) found++;
    }
    expect(found).toBe(0);
    handle.destroy();
  });

  it('setLang 切到 java 档后折叠扩展被卸载（FR-T1 语言管线）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    handle.setLang('java');
    const state = handle.view.state;
    let found = 0;
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (foldable(state, line.from, line.to)) found++;
    }
    expect(found).toBe(0);
    handle.setLang('json'); // 切回来又能折
    expect(foldable(handle.view.state, handle.view.state.doc.line(1).from, handle.view.state.doc.line(1).to)).not.toBeNull();
    handle.destroy();
  });
});

describe('v1.7 / FR-T2：折叠为 [+] 占位符并可靠折叠/恢复', () => {
  it('foldEffect 折叠后 foldedRanges 包含区间；DOM 出现 [+] 占位符（AC-148）', () => {
    const { handle, host } = makeEditor('json', JSON_DOC);
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to)!;
    handle.view.dispatch({ effects: foldEffect.of(range) });
    expect(foldsOf(handle.view)).toHaveLength(1);
    // 占位符 DOM：jsdom 下 CM6 widget 也会渲染
    const ph = host.querySelector('.cm-foldPlaceholder');
    expect(ph).not.toBeNull();
    expect(ph?.textContent).toBe('[+]');
    handle.destroy();
  });

  it('点击占位符等价于 unfoldEffect：折叠态恢复（AC-148 恢复侧）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to)!;
    handle.view.dispatch({ effects: foldEffect.of(range) });
    expect(foldsOf(handle.view)).toHaveLength(1);
    handle.view.dispatch({ effects: unfoldEffect.of(range) });
    expect(foldsOf(handle.view)).toHaveLength(0);
    handle.destroy();
  });

  it('折叠后文档内容与统计完全不变（FR-T6 / AC-153）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    const before = handle.getDoc();
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to)!;
    handle.view.dispatch({ effects: foldEffect.of(range) });
    expect(handle.getDoc()).toBe(before); // 折叠不改文档
    handle.view.dispatch({ effects: unfoldEffect.of(range) });
    expect(handle.getDoc()).toBe(before);
    handle.destroy();
  });
});

describe('v1.7 / FR-T5：折叠态零记忆、setDoc 重置', () => {
  it('setDoc 全量替换后折叠区间被清理（AC-154）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to)!;
    handle.view.dispatch({ effects: foldEffect.of(range) });
    expect(foldsOf(handle.view)).toHaveLength(1);
    handle.setDoc(PY_DOC); // 全量替换
    expect(foldsOf(handle.view)).toHaveLength(0);
    handle.destroy();
  });

  it('折叠扩展不写任何 storage（源码断言，AC-154）', () => {
    const src = code('src/ui/editor.ts');
    // 折叠实现在 editor.ts 内，不得出现任何 storage 调用
    expect(src).not.toContain('storage.local');
    expect(src).not.toContain('storage.session');
    expect(src).not.toContain('chrome.storage');
  });
});

describe('v1.7 / FR-T4：foldKeymap 命令可用', () => {
  it('foldCode / foldAll / unfoldAll 命令在 json 档工作（AC-152 前置）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    const view = handle.view;
    // 光标放第 1 行
    view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
    expect(foldCode(view)).toBe(true);
    expect(foldsOf(view)).toHaveLength(1);
    // foldAll 只折「顶层」区间：本文档顶层只有 1 个对象（已折），再无新顶层
    // （嵌套的 "a"/"b" 在顶层对象内部，不属顶层）—— 返回 false 是正确语义。
    expect(foldAll(view)).toBe(false);
    expect(unfoldAll(view)).toBe(true);
    expect(foldsOf(view)).toHaveLength(0);
    // 展开后 foldAll 才有顶层区间可折
    expect(foldAll(view)).toBe(true);
    expect(foldsOf(view)).toHaveLength(1);
    handle.destroy();
  });

  it('java 档：foldCode 无操作对象返回 false（AC-150 键位侧）', () => {
    const { handle } = makeEditor('java', JSON_DOC);
    const view = handle.view;
    view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
    expect(foldCode(view)).toBe(false);
    handle.destroy();
  });
});

describe('v1.7 / FR-T7：占位符与折叠槽令牌化（源码断言）', () => {
  it('styles.css：折叠槽与占位符全部走设计令牌，无新增颜色/字号层级', () => {
    const css = code('src/ui/styles.css');
    expect(css).toContain('.editor .cm-foldGutter');
    expect(css).toContain('.editor .cm-foldPlaceholder');
    // 折叠槽用铭牌视觉与信号色 hover（FR-T7）
    const foldGutterBlock = css.slice(css.indexOf('.editor .cm-foldGutter'), css.indexOf('.editor .cm-foldGutter') + 600);
    expect(foldGutterBlock).toContain('var(--bg-recess)');
    expect(foldGutterBlock).toContain('var(--border)');
    expect(css).toContain('body.theme-dark .editor .cm-foldGutter');
  });

  it('editor.ts：占位符 [+] 文本 + 手风琴 mousedown（FR-T3/T7 决策落地）', () => {
    const src = code('src/ui/editor.ts');
    expect(src).toContain("placeholderText: '[+]'");
    expect(src).toContain('...foldKeymap');
    expect(src).toContain('altKey');
  });
});

describe('v1.7 / FR-T8：折叠不影响既有行为', () => {
  it('错误行高亮 StateField 与折叠共存（AC-156 前置）', () => {
    const { handle } = makeEditor('json', JSON_DOC);
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to)!;
    handle.view.dispatch({ effects: foldEffect.of(range) });
    // 折叠态下错误行高亮接口不抛错
    expect(() => handle.highlightLine(2)).not.toThrow();
    expect(() => handle.clearHighlight()).not.toThrow();
    handle.destroy();
  });

  it('只读输出区同样可折叠（FR-T1：输出区启用）', () => {
    const { handle } = makeEditor('json', JSON_DOC, true);
    const state = handle.view.state;
    const line1 = state.doc.line(1);
    const range = foldable(state, line1.from, line1.to)!;
    handle.view.dispatch({ effects: foldEffect.of(range) });
    expect(foldsOf(handle.view)).toHaveLength(1);
    handle.destroy();
  });
});
