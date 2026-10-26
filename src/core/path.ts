/**
 * JSON 路径定位（v1.4，FR-P1~P10 / AC-89~AC-104）
 *
 * 纯函数模块：IR（或「文本 + 格式」）+ 光标偏移 → JSONPath。
 *
 * 不可违背的三条：
 *  1. **不读 DOM** —— 路径由 IR 的 Span 计算（FR-P5 / AC-103）。
 *     复制取程序产物、不取编辑器文本，这是 AC-39 的同一条原则。
 *  2. **偏移坐标系是「源文本」** —— Span.start/end 直接来自 lexer 的
 *     Token.start/end。Java 转义串是「先解码再解析」，Span 落在解码空间，
 *     与源码对不上，因此 java 一律不支持（FR-P8）。**不做近似**：
 *     错路径会让用户照着改错代码，比没有路径危险得多。
 *  3. **落在分隔符/空白上返回 null，由调用方保持上一次** —— 不是偷懒。
 *     横拖经过逗号时若每次清空，路径条会连闪三下（FR-P4）。
 */

import type { JVal, Span } from './ir.js';
import { keyToString } from './ir.js';
import { lex } from './lexer.js';
import { parseJson } from './parse/json.js';
import { parsePython } from './parse/python.js';

/** 路径段：对象成员 / 数组下标 */
export type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

/** 命中的是键、值，还是容器自身（点中 `{` `}` `[` `]` 时） */
export type PathTarget = 'key' | 'value' | 'container';

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface PathHit {
  segments: PathSegment[];
  /** 已格式化的 JSONPath，如 `$.data.list[3].userName` */
  path: string;
  target: PathTarget;
  /** 成员值/容器本身的类型，供路径条右侧徽标使用 */
  valueKind: ValueKind;
  span: Span;
}

/** 分隔符与空白：命中这些一律「保持上一次」（FR-P4） */
const SEPARATOR = new Set([',', ':', '=', ' ', '\t', '\n', '\r']);

/** 括号：命中这些返回容器自身路径 */
const BRACKET = new Set(['{', '}', '[', ']']);

/** 合法标识符键才用点号；其余（含中文、点号、空格、数字开头、空串）一律方括号 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 路径段 → JSONPath 串。
 *
 * 为什么中文键也走方括号：`$.用户名` 在多数实现里能跑，但在 Java DSL、
 * 部分 CLI 里会出错。方括号是**所有实现都认**的交集写法 ——
 * 复制的目标是「贴到哪里都能用」，不是「看起来最短」。
 */
export function formatPath(segments: PathSegment[]): string {
  let out = '$';
  for (const seg of segments) {
    if (seg.kind === 'index') {
      out += '[' + String(seg.index) + ']';
    } else if (IDENT.test(seg.key)) {
      out += '.' + seg.key;
    } else {
      out += "['" + escapeKey(seg.key) + "']";
    }
  }
  return out;
}

function escapeKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function valueKindOf(node: JVal): ValueKind {
  switch (node.k) {
    case 'obj':
      return 'object';
    case 'arr':
      return 'array';
    case 'str':
      return 'string';
    case 'num':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'null':
      return 'null';
  }
}

function keySegment(key: JVal): PathSegment {
  return { kind: 'key', key: keyToString(key) };
}

function hit(
  segments: PathSegment[],
  target: PathTarget,
  node: JVal,
  span: Span,
): PathHit {
  return { segments, path: formatPath(segments), target, valueKind: valueKindOf(node), span };
}

/**
 * 在 IR 中定位光标所在的**最深的键或值**（不返回容器）。
 *
 * 复杂度：每层只扫描兄弟节点直到命中包含者，正常路径是 O(深度 × 兄弟数)，
 * 远小于全量遍历；500k 文档远低于一帧预算（AC-102）。
 */
function descend(node: JVal, segments: PathSegment[], off: number): PathHit | null {
  if (off < node.span.start || off >= node.span.end) return null;

  if (node.k === 'obj') {
    for (const entry of node.entries) {
      const seg = [...segments, keySegment(entry.key)];
      // 键命中：与该成员的值**同一条路径**，只把 target 标成 key（FR-P 决策 D-4）
      if (off >= entry.key.span.start && off < entry.key.span.end) {
        return hit(seg, 'key', entry.val, entry.key.span);
      }
      const sub = descend(entry.val, seg, off);
      if (sub) return sub;
    }
    return null;
  }

  if (node.k === 'arr') {
    for (let i = 0; i < node.items.length; i++) {
      const sub = descend(node.items[i], [...segments, { kind: 'index', index: i }], off);
      if (sub) return sub;
    }
    return null;
  }

  return hit(segments, 'value', node, node.span);
}

/**
 * 找光标所在的**最内层容器**，仅当其开/闭括号正好在光标下。
 * 字符串里的括号（`{"a":"{"}`）不会走到这里 —— descend 已优先命中字符串。
 */
function bracketAt(node: JVal, segments: PathSegment[], off: number): PathHit | null {
  if (node.k !== 'obj' && node.k !== 'arr') return null;

  if (off === node.span.start || off === node.span.end - 1) {
    return hit(segments, 'container', node, node.span);
  }

  if (node.k === 'obj') {
    for (const entry of node.entries) {
      const span = entry.val.span;
      if (off >= span.start && off <= span.end) {
        const sub = bracketAt(entry.val, [...segments, keySegment(entry.key)], off);
        if (sub) return sub;
      }
    }
    return null;
  }

  for (let i = 0; i < node.items.length; i++) {
    const span = node.items[i].span;
    if (off >= span.start && off <= span.end) {
      const sub = bracketAt(node.items[i], [...segments, { kind: 'index', index: i }], off);
      if (sub) return sub;
    }
  }
  return null;
}

/**
 * 定位：返回 null 表示「本次不该更新」，调用方应保持上一次显示。
 *
 * @param ir     源文本解析出的 IR（报错态无 IR 时传 undefined）
 * @param text   与 IR 同一坐标系的源文本（用于判断光标下是什么字符）
 * @param offset 光标偏移（CM6 的 `state.selection.main.head`，UTF-16 下标）
 */
export function locate(ir: JVal | null | undefined, text: string, offset: number): PathHit | null {
  if (!ir) return null;
  if (offset < 0 || offset >= text.length) return null;

  const ch = text[offset];

  // 先进 IR：字符串/键内可能包含 `{` `,` 等字符，它们属于元素而非结构
  const leaf = descend(ir, [], offset);
  if (leaf) return leaf;

  if (BRACKET.has(ch)) return bracketAt(ir, [], offset);
  if (SEPARATOR.has(ch)) return null;
  return null;
}

/** 输出区二次解析支持的输出语言（java 为转义串，坐标系不可映射，FR-P8） */
export type PathLang = 'json' | 'python';

/** 语言 → 是否支持路径定位 */
export function supportsPath(lang: string): lang is PathLang {
  return lang === 'json' || lang === 'python';
}

/**
 * 输出区用：对「显示出来的文本」重新解析出一份 IR。
 *
 * 格式化 tab 的输出是**同语言规范化结果**，来源可能是 JSON 也可能是
 * Python 字面量，所以不能复用输入侧的 IR（坐标系不同）。
 * 调用方必须缓存本函数的返回值 —— 它是一次完整 lex + parse。
 */
export function pathIrFor(text: string, lang: PathLang): JVal | null {
  if (!text.trim()) return null;
  try {
    const tokens = lex(text).tokens;
    const opts = { strict: true, rawText: text };
    return (lang === 'python' ? parsePython(tokens, opts) : parseJson(tokens, opts)).ir;
  } catch {
    // 显示中的文本理论上一定合法；万一不合法（旧结果/异常），安静地不提供路径
    return null;
  }
}
