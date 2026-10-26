/**
 * CodeMirror 6 封装（Spike S-2 验证对象）
 *
 * 关键约束（评审 D-4）：
 *  - 关闭高亮不得重建编辑器 —— 用 Compartment 动态卸载，保住光标/undo/滚动状态
 *  - 输出区只读（FR-F9）
 */

import { EditorView, basicSetup } from 'codemirror';
import {
  Decoration,
  type DecorationSet,
  gutter,
  GutterMarker,
  type ViewUpdate,
} from '@codemirror/view';
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  RangeSet,
  RangeSetBuilder,
  type Extension,
} from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * 编辑器语言。
 * `java` 为 Java 转义字符串输出（FR-A18）—— 它是一整行字符串常量，
 * 套 JSON/Python 语法高亮都会误导，故映射为「无高亮」。
 */
export type EditorLang = 'json' | 'python' | 'java';

function langExt(lang: EditorLang): Extension[] {
  if (lang === 'json') return [json()];
  if (lang === 'python') return [python()];
  return [];
}

/** 错误行装饰：由 StateField 管理，绝不直接操作 DOM（CM6 会重排行元素） */
const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setErrorLine)) return e.value;
    return value;
  },
});

const errorLineDeco = EditorView.decorations.compute([errorLineField], (state) => {
  const ln = state.field(errorLineField);
  if (ln == null || ln < 1 || ln > state.doc.lines) return Decoration.none;
  const line = state.doc.line(ln);
  return Decoration.set([
    Decoration.line({ class: 'cm-errorLine' }).range(line.from),
    ...(line.length > 0
      ? [Decoration.mark({ class: 'cm-errorText' }).range(line.from, line.to)]
      : []),
  ]);
});

class ErrorGutterMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-errorGutter';
    el.textContent = '●';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}
const errorMarker = new ErrorGutterMarker();

const errorGutter = gutter({
  class: 'cm-errorGutter-gutter',
  markers: (view) => {
    const ln = view.state.field(errorLineField);
    if (ln == null || ln < 1 || ln > view.state.doc.lines) return RangeSet.empty;
    const line = view.state.doc.line(ln);
    const b = new RangeSetBuilder<GutterMarker>();
    b.add(line.from, line.from, errorMarker);
    return b.finish();
  },
  initialSpacer: () => errorMarker,
});

export interface EditorHandle {
  view: EditorView;
  setDoc(text: string): void;
  getDoc(): string;
  /** 动态开关语法高亮（D-4） */
  setHighlight(on: boolean): void;
  setLang(lang: EditorLang): void;
  setEditable(editable: boolean): void;
  /** 高亮错误行（M2-2） */
  highlightLine(line: number): void;
  clearHighlight(): void;
  destroy(): void;
}

const themeCompartment = new Compartment();
const editableCompartment = new Compartment();

export function createEditor(
  parent: HTMLElement,
  opts: {
    doc?: string;
    lang?: EditorLang;
    readOnly?: boolean;
    dark?: boolean;
    onChange?: (text: string) => void;
    /** v1.4：光标位置变化（单击 / 双击 / 拖选 / 方向键），供路径条跟随 */
    onCursor?: (offset: number) => void;
  } = {},
): EditorHandle {
  const highlightCompartment = new Compartment();
  const lang = opts.lang ?? 'json';
  const readOnly = opts.readOnly ?? false;
  const dark = opts.dark ?? false;

  const extensions = [
    basicSetup,
    errorLineField,
    errorLineDeco,
    errorGutter,
    themeCompartment.of(dark ? [oneDark] : []),
    highlightCompartment.of(langExt(lang)),
    editableCompartment.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ tabindex: '0' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && opts.onChange) {
        opts.onChange(u.state.doc.toString());
      }
      // v1.4：光标移动即报告位置（FR-P3）。键盘方向键、点击、拖选都会触发。
      if (u.selectionSet && opts.onCursor) {
        opts.onCursor(u.state.selection.main.head);
      }
    }),
    /**
     * v1.4：**必须与 selectionSet 双挂**。
     *
     * CM6 在点击「光标已经在的位置」时不会产生 selectionSet ——
     * 只监听选择变化会漏掉「再点一次」，症状与「功能没做」一模一样。
     * mousedown 能直接拿到坐标对应的偏移，补上这个缺口。
     */
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        if (!opts.onCursor) return false;
        try {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos != null) opts.onCursor(pos);
        } catch {
          // 布局尚未就绪（jsdom / 首帧）时静默跳过，绝不因此中断交互
        }
        return false; // 不阻止默认行为：选中、拖拽照常
      },
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: opts.doc ?? '', extensions }),
    parent,
  });

  let currentLang = lang;
  let highlightOn = true;

  return {
    view,
    setDoc(text: string) {
      if (view.state.doc.toString() === text) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    getDoc() {
      return view.state.doc.toString();
    },
    setHighlight(on: boolean) {
      if (on === highlightOn) return;
      highlightOn = on;
      view.dispatch({
        effects: highlightCompartment.reconfigure(on ? langExt(currentLang) : []),
      });
    },
    setLang(next: EditorLang) {
      if (next === currentLang) return;
      currentLang = next;
      if (highlightOn) {
        view.dispatch({
          effects: highlightCompartment.reconfigure(langExt(next)),
        });
      }
    },
    setEditable(editable: boolean) {
      view.dispatch({
        effects: editableCompartment.reconfigure([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
      });
    },
    /** 高亮错误行并滚动到视野内（M2-2） */
    highlightLine(line: number) {
      const total = view.state.doc.lines;
      if (total === 0) return;
      const ln = Math.min(Math.max(line, 1), total);
      view.dispatch({
        effects: setErrorLine.of(ln),
      });

    },
    clearHighlight() {
      view.dispatch({ effects: setErrorLine.of(null) });
    },
    destroy() {
      view.destroy();
    },
  };
}
