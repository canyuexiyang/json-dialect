/**
 * CodeMirror 6 封装（Spike S-2 验证对象）
 *
 * 关键约束（评审 D-4）：
 *  - 关闭高亮不得重建编辑器 —— 用 Compartment 动态卸载，保住光标/undo/滚动状态
 *  - 输出区只读（FR-F9）
 *
 * v1.5 / D15：放弃 `basicSetup`，改用**白名单扩展**。
 * basicSetup 附带的 autocompletion（无 completion source，纯死重量）、
 * foldGutter（用户不知道的「意外功能」且从未造型）、rectangularSelection /
 * crosshairCursor / highlightSelectionMatches 一概不需要。
 * 新增任何扩展前先问一句「这台仪器上用户用得到吗」。
 *
 * v1.6 / E4：**恢复编辑器内查找** —— 白名单移除 searchKeymap 后只剩浏览器原生
 * Ctrl+F，而 CM6 是虚拟滚动，浏览器查找命中率很差（看不见的 DOM 根本不存在）。
 * 这次只加 `search()` + `searchKeymap` 两个必要扩展，搜索面板已在 styles.css
 * 里令牌化；这是 v1.5「Ctrl+F 回落浏览器」决策的**有意反转**，PRD 已并入正文。
 *
 * v1.7 / FR-T：**启用结构化节点折叠** —— v1.5 / D15 白名单不装折叠的定论是
 * 「用户不知道的意外功能且从未造型」；v1.6.0 交付后大文档浏览成为实测痛点，
 * 本次为它正式造型（折叠槽走铭牌视觉、占位符用 [+] 文本）后引入。
 * 与 E4 恢复 search 完全同构的**有意反转**，PRD v1.10 / §6 FR-T 已并入正文。
 * 折叠能力挂在 langExt() 语言管线上：json / python 档启用，无高亮档（转义
 * tab 纯文本）自然无折叠点 —— 无结构不折叠，与 FR-P8 同一原则。
 */

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  gutter,
  GutterMarker,
  type ViewUpdate,
  Decoration,
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
import {
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  codeFolding,
  foldGutter,
  foldKeymap,
  foldEffect,
  unfoldEffect,
  foldable,
  foldedRanges,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * 编辑器语言。
 * `java` 为 Java 转义字符串输出（FR-A18）—— 它是一整行字符串常量，
 * 套 JSON/Python 语法高亮都会误导，故映射为「无高亮」。
 */
export type EditorLang = 'json' | 'python' | 'java';

/**
 * v1.7 / FR-T1：折叠能力随语言管线分流。
 * json / python 档装 codeFolding + foldGutter（占位符 [+]，FR-T7）；
 * 无高亮档（java 转义串）不装 —— 无结构不折叠，与 FR-P8 同一原则。
 * foldGutter() 自带 codeFolding()（默认 ⋯ 占位符），这里显式传
 * codeFolding({ placeholderText: '[+]' }) 覆盖默认（FR-T7 决策）。
 */
function foldExtensions(): Extension[] {
  return [
    codeFolding({ placeholderText: '[+]' }),
    foldGutter({
      openText: '▾',
      closedText: '▸',
      domEventHandlers: {
        /** FR-T3：Alt+Click 手风琴 —— 折该节点 + 全部同级（CM6 默认不带，需自实现） */
        mousedown: (view, line, event) => {
          if (!(event as MouseEvent).altKey) return false;
          return foldSiblings(view, line.from);
        },
      },
    }),
  ];
}

/**
 * FR-T3：手风琴模式 —— 折叠 lineFrom 所在节点及其全部同级节点。
 * 同级 = 与该节点在文档中同层并列的可折叠区间（起止行对齐判断）。
 * 返回 true 表示已处理（阻止 gutter 默认 click 折单个）。
 */
function foldSiblings(view: EditorView, lineFrom: number): boolean {
  const state = view.state;
  // 该行的可折叠区间
  const first = foldable(state, lineFrom, lineFrom);
  if (!first) {
    // 点的是已折叠行 → 展开同级（含自身）
    const folded = foldedRanges(state).iter();
    let target: { from: number; to: number } | null = null;
    while (folded.value) {
      const r = folded.from < lineFrom + 1 && folded.to > lineFrom ? { from: folded.from, to: folded.to } : null;
      if (r) { target = r; break; }
      folded.next();
    }
    if (!target) return false;
    return unfoldSiblings(view, target);
  }
  // 收集同级：扫描全文档所有可折叠顶层区间，取与 first 同层（父区间相同）的
  const siblings = collectSiblings(view, first);
  const effects = siblings.map((r) => foldEffect.of(r));
  if (effects.length) {
    view.dispatch({ effects });
    return true;
  }
  return false;
}

/** 展开与 target 同层且起点在 target 父区间内的已折叠节点（FR-T3 展开侧） */
function unfoldSiblings(view: EditorView, target: { from: number; to: number }): boolean {
  const state = view.state;
  const parent = containingRange(view, target);
  const folded = foldedRanges(state).iter();
  const effects: ReturnType<typeof unfoldEffect.of>[] = [];
  while (folded.value) {
    const r = { from: folded.from, to: folded.to };
    const p = containingRange(view, r);
    if (sameParent(parent, p) && r.from >= target.from) {
      effects.push(unfoldEffect.of(r));
    }
    folded.next();
  }
  if (effects.length) {
    view.dispatch({ effects });
    return true;
  }
  view.dispatch({ effects: unfoldEffect.of(target) });
  return true;
}

/** 收集与 first 同层（父区间相同）的全部可折叠区间，含 first 自身 */
function collectSiblings(view: EditorView, first: { from: number; to: number }): Array<{ from: number; to: number }> {
  const state = view.state;
  const parent = containingRange(view, first);
  const out: Array<{ from: number; to: number }> = [];
  // 逐行扫可折叠区间太粗（一行可能有多个括号对）；改用「顶层区间收集」：
  // 从文档头开始，每找到一个可折叠区间就跳到区间尾，收集全部互不嵌套的顶层区间；
  // 再递归进入 parent 区间内部收集与其同层者。first 的层级由 parent 决定。
  const topRanges = collectTopRanges(state, 0, state.doc.length);
  if (!parent) return topRanges; // 顶层：全部顶层区间即同级
  // parent 内部的顶层区间 = first 的同级
  return collectTopRanges(state, parent.from, parent.to);
}

/** 收集 [from, to) 内互不嵌套的顶层可折叠区间（foldAll 同款扫描法） */
function collectTopRanges(state: import('@codemirror/state').EditorState, from: number, to: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let pos = from;
  while (pos < to) {
    const line = state.doc.lineAt(pos);
    const lineTo = Math.min(line.to, to);
    const range = foldable(state, line.from, lineTo);
    if (range && range.to <= to) {
      out.push(range);
      pos = range.to + 1;
    } else {
      pos = line.to + 1;
    }
  }
  return out;
}

/** 找包含 range 的最小可折叠区间（父区间）；无则 null。只在同层扫描可见范围 */
function containingRange(view: EditorView, range: { from: number; to: number }): { from: number; to: number } | null {
  const state = view.state;
  const top = collectTopRanges(state, 0, state.doc.length);
  return findContainer(top, range, state, 0);
}

function findContainer(
  ranges: Array<{ from: number; to: number }>,
  target: { from: number; to: number },
  state: import('@codemirror/state').EditorState,
  depth: number,
): { from: number; to: number } | null {
  for (const r of ranges) {
    if (r.from < target.from && r.to > target.to) {
      // r 包含 target；再看 r 内部有没有更小的包含者
      const inner = collectTopRanges(state, r.from, r.to);
      const deeper = findContainer(inner, target, state, depth + 1);
      return deeper ?? r;
    }
  }
  return null;
}

function sameParent(
  a: { from: number; to: number } | null,
  b: { from: number; to: number } | null,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.from === b.from && a.to === b.to;
}

function langExt(lang: EditorLang): Extension[] {
  if (lang === 'json') return [json(), ...foldExtensions()];
  if (lang === 'python') return [python(), ...foldExtensions()];
  return []; // 无高亮档：无折叠点（FR-T1）
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
  /** v1.5 / D4：运行时切换深浅色主题（跟随系统），不重建编辑器 */
  setDark(on: boolean): void;
  /** 高亮错误行（M2-2） */
  highlightLine(line: number): void;
  clearHighlight(): void;
  destroy(): void;
}

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
  // v1.5：Compartment 移到编辑器实例局部 —— 原先是模块级共享，
  // 两个编辑器共用同一个键。虽然 Compartment 本身无状态、不会串台，
  // 但局部化后每个实例的生命周期一目了然。
  const themeCompartment = new Compartment();
  const editableCompartment = new Compartment();
  const highlightCompartment = new Compartment();
  const lang = opts.lang ?? 'json';
  const readOnly = opts.readOnly ?? false;
  const dark = opts.dark ?? false;

  let currentLang = lang;
  let highlightOn = true;

  const extensions = [
    // v1.5 / D15 白名单：只装这台仪器真正用到的扩展
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    // v1.5.1 / N19：只读输出区不需要撤销栈。1M 文本每次 setDoc 都会往 history
    // 里塞一个巨型事务，纯浪费内存；输入区仍保留完整 undo/redo。
    ...(readOnly ? [] : [history()]),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    // v1.6 / E4：编辑器内查找（Ctrl/Cmd+F）。两个编辑器都能用，
    // search() 提供状态与面板，searchKeymap 只负责快捷键。
    search({ top: true }),
    // v1.5.1 / N04：刻意不装 indentWithTab —— 它会吃掉 Tab / Shift+Tab，
    // 键盘用户永远走不出编辑器。缩进仍可用 defaultKeymap 的 Mod-[ / Mod-]。
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...(readOnly ? [] : historyKeymap),
      ...searchKeymap,
      // v1.7 / FR-T4：折叠快捷键（CM6 默认：Ctrl-Shift-[ 折叠 / Ctrl-Shift-] 展开 /
      // Ctrl-Alt-[ 全折 / Ctrl-Alt-] 全展；macOS 上自动映射为 Cmd-Alt-[ 等）。
      // 与既有键位零冲突：全局 Alt+1/2/3/T/C/S/A、Ctrl+F、缩进 Mod-[/]、Tab 不拦截。
      ...foldKeymap,
      // macOS 上 Mod 是 Cmd，而 Cmd+F 被浏览器查找占用（网页收不到 keydown）；
      // 显式补一条 Control-f，让 Mac 用户与真机脚本都能打开编辑器内查找。
      { key: 'Control-f', run: openSearchPanel },
    ]),
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

  return {
    view,
    setDoc(text: string) {
      if (view.state.doc.toString() === text) return;
      // v1.7 / FR-T5：全量替换文档时折叠态自然重置（折叠区间映射到新文本即失效）。
      // CM6 foldState 是 StateField，事务按 changes 映射；整段替换时旧折叠区间
      // 收缩为零长被清理，无需显式 unfoldAll。
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
    /**
     * v1.5 / D4：系统深浅色切换时动态换主题，不重建编辑器（保住 undo / 滚动）。
     * 同时兑现了原先「themeCompartment 声明了却从未 reconfigure」的死代码；
     * 零调用的 setEditable（原死代码之二）已删除 —— 只读性由构造参数一次定型。
     */
    setDark(on: boolean): void {
      view.dispatch({
        effects: themeCompartment.reconfigure(on ? [oneDark] : []),
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
