/**
 * Map.toString() parser（FR-C3/C4/C5/C12/C13）
 *
 * 关键规则：
 *  - FR-C4 按「当前括号深度为 1 处的第一个 =」切分键值 —— 值内部的 = 不被误切分（AC-12）
 *  - FR-C5 类型推断：纯数字 → 数字；true/false（忽略大小写）→ 布尔；null → null；其余 → 字符串
 *  - FR-C12 支持嵌套对象与数组（递归下降）
 *  - FR-C13 对象内条目无 = → 「键值分隔符缺失」报错；数组内无 = 属正常
 *
 * 实现：在原始文本上做深度感知扫描（Map 语法不是 token 流能直接表达的，
 * 因为裸词 `张三`、`a=b` 都是有效内容），但复用同一套 IR 与错误定位。
 */

import type { JVal, ObjEntry, Span } from '../ir.js';
import type { Mark, Token } from '../lexer.js';
import { significant } from '../lexer.js';
import { stripLeadingZeros } from '../escape.js';
import type { ParseOptions, ParseOut, ValueSlot } from './engine.js';
import { ParseError } from '../errors.js';


const TRUE_W = new Set(['true', 'True', 'TRUE']);
const FALSE_W = new Set(['false', 'False', 'FALSE']);
const NULL_W = new Set(['null', 'Null', 'NULL', 'none', 'None', 'NONE']);

function isNumberText(s: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
}

interface Ctx {
  marks: Mark[];
  strict: boolean;
  depth: number;
  maxDepth: number;
  values: ValueSlot[];
  path: string;
}

function mk(type: Mark['type'], line: number, col: number, before: string, after: string): Mark {
  return { type, line, col, before, after };
}

/** 扫描一个片段，找到深度为 0（相对该片段）的分隔符位置 */
function findAtDepth(s: string, target: string): number {
  let depth = 0;
  let i = 0;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (depth === 0 && c === target) return i;
    i++;
  }
  return -1;
}

/** 按深度 0 处的分隔符切分（FR-C4 步骤 2） */
function splitAtDepth(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let quote: string | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === '\\' && i + 1 < s.length) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (depth === 0 && c === sep) {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  out.push(buf);
  return out;
}

/**
 * 剥离 `#` 行注释（引号内的 `#` 不算）。
 *
 * Map parser 直接用原文扫描（因为空白是有效内容），
 * 但注释必须剔除 —— 否则 `{a=1}  # 备注` 的注释会被当成值的一部分。
 */
function stripComments(s: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#') {
      // 跳到行尾
      while (i < s.length && s[i] !== '\n') i++;
      if (i < s.length) out += '\n'; // 保留换行，避免行号漂移
      continue;
    }
    out += c;
  }
  return out;
}

/** 去掉外层包裹的引号 */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' || a === "'") && a === b) return t.slice(1, -1);
  }
  return t;
}

function inferValue(text: string, ctx: Ctx, line: number, col: number, path: string): JVal {
  const t = text.trim();
  const span: Span = { start: 0, end: t.length, line, col };
  if (isNumberText(t)) {
    const node: JVal = { k: 'num', raw: stripLeadingZeros(t), span };
    ctx.values.push({ path, node, inferred: 'number', raw: t });
    return node;
  }
  const low = t.toLowerCase();
  if (TRUE_W.has(t)) {
    const node: JVal = { k: 'bool', value: true, span };
    ctx.values.push({ path, node, inferred: 'boolean', raw: t });
    return node;
  }
  if (FALSE_W.has(t)) {
    const node: JVal = { k: 'bool', value: false, span };
    ctx.values.push({ path, node, inferred: 'boolean', raw: t });
    return node;
  }
  if (NULL_W.has(t)) {
    const node: JVal = { k: 'null', span };
    ctx.values.push({ path, node, inferred: 'null', raw: t });
    return node;
  }
  const node: JVal = { k: 'str', value: unquote(t), span };
  ctx.values.push({ path, node, inferred: 'string', raw: t });
  return node;
}

function parseMapNode(text: string, ctx: Ctx, line: number, col: number, path: string): JVal {
  const t = text.trim();
  if (ctx.depth > ctx.maxDepth) {
    throw new ParseError('unexpected_token', line, col, '嵌套过深');
  }

  // 嵌套对象 { ... }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1);
    const entries = parseMapEntries(inner, ctx, line, col + 1, path);
    return { k: 'obj', entries, span: { start: 0, end: t.length, line, col } };
  }

  // 数组 [ ... ]
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1);
    const items: JVal[] = [];
    for (const raw of splitAtDepth(inner, ',')) {
      const piece = raw.trim();
      if (piece === '') continue;
      items.push(parseMapNode(piece, ctx, line, col + 1, `${path}/${items.length}`));
    }
    return { k: 'arr', items, span: { start: 0, end: t.length, line, col } };
  }

  return inferValue(t, ctx, line, col, path);
}

function parseMapEntries(inner: string, ctx: Ctx, line: number, col: number, path: string): ObjEntry[] {
  const entries: ObjEntry[] = [];
  if (inner.trim() === '') return entries;
  const pieces = splitAtDepth(inner, ',');
  let offset = 0;
  for (const piece of pieces) {
    const trimmed = piece.trim();
    const pieceCol = col + offset;
    offset += piece.length + 1;
    if (trimmed === '') continue;
    const eq = findAtDepth(trimmed, '=');
    if (eq === -1) {
      // FR-C13：对象内无 = → 键值分隔符缺失
      throw new ParseError('missing_colon', line, pieceCol + (piece.length - piece.trimStart().length), '键值分隔符缺失');
    }
    const keyText = trimmed.slice(0, eq).trim();
    const valText = trimmed.slice(eq + 1).trim();
    const key: JVal = { k: 'str', value: unquote(keyText), span: { start: 0, end: keyText.length, line, col: pieceCol } };
    const childPath = `${path}/${key.value}`;
    const prev = ctx;
    ctx.depth++;
    const val = parseMapNode(valText, prev, line, pieceCol + eq + 1, childPath);
    ctx.depth--;
    entries.push({ key, val });
  }
  return entries;
}

export function parseMap(toks: Token[], opts: Omit<ParseOptions, 'fmt'>): ParseOut {
  // 原文优先（Map 语法里裸词之间的空白是有效内容：
  // `{a=hello world}` 的值是 "hello world"，用 significant() 拼接会得到 "helloworld"）。
  // 用原文时需自行剥离注释 —— token 流里的 comment 已被 significant 滤掉，
  // 直接用 rawText 会把 `# 备注` 当成值的一部分。
  const text =
    opts.rawText !== undefined
      ? stripComments(opts.rawText)
      : significant(toks) // 无原文时退化为 token 拼接（保持向后兼容）
          .map((t) => t.raw)
          .join('');
  const ctx: Ctx = {
    marks: [],
    strict: opts.strict,
    depth: 0,
    maxDepth: opts.maxDepth ?? 200,
    values: [],
    path: '',
  };
  const trimmed = text.trim();
  let ir: JVal;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const entries = parseMapEntries(trimmed.slice(1, -1), ctx, 1, 1, '');
    ir = { k: 'obj', entries, span: { start: 0, end: trimmed.length, line: 1, col: 0 } };
  } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const items: JVal[] = [];
    for (const raw of splitAtDepth(trimmed.slice(1, -1), ',')) {
      const piece = raw.trim();
      if (piece === '') continue;
      items.push(parseMapNode(piece, ctx, 1, 1, `/${items.length}`));
    }
    ir = { k: 'arr', items, span: { start: 0, end: trimmed.length, line: 1, col: 0 } };
  } else {
    throw new ParseError('unexpected_token', 1, 0, '不是有效的 Map.toString() 结构');
  }
  return { ir, marks: ctx.marks, values: ctx.values };
}
