/** Map.toString() 原文解析：保留空白、原始值和准确偏移，不丢弃尾部内容。 */
import type { JVal, ObjEntry, Span } from '../ir.js';
import { makePath } from '../ir.js';
import type { Mark, Token } from '../lexer.js';
import { normalizeNumber } from '../escape.js';
import type { ParseOptions, ParseOut, ValueSlot } from './engine.js';
import { ParseError } from '../errors.js';

export function parseMap(toks: Token[], opts: Omit<ParseOptions, 'fmt'>): ParseOut {
  opts.deadline?.check(true);
  const original = opts.rawText ?? toks.map((t) => t.raw).join('');
  const lines = [0];
  for (let i = 0; i < original.length; i++) {
    opts.deadline?.check();
    if (original[i] === '\n') lines.push(i + 1);
  }
  function span(start: number, end: number): Span {
    let lo = 0;
    let hi = lines.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid] <= start) lo = mid;
      else hi = mid;
    }
    return { start, end, line: lo + 1, col: start - lines[lo] };
  }
  function fail(start: number, kind: ParseError['kind'], detail: string): never {
    const p = span(start, start);
    throw new ParseError(kind, p.line, p.col, detail, p);
  }
  const marks: Mark[] = [];
  const values: ValueSlot[] = [];
  // 以等长空白替换注释，保留原文偏移；裸值中的 # 不当作注释。
  const chars = original.split('');
  let quote = '';
  for (let i = 0; i < chars.length; i++) {
    opts.deadline?.check();
    const ch = original[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(original[i - 1]))) {
      const start = i;
      while (i < chars.length && original[i] !== '\n') { opts.deadline?.check(); chars[i++] = ' '; }
      const p = span(start, i);
      marks.push({ type: 'comment_stripped', line: p.line, col: p.col, before: original.slice(start, i), after: '' });
    }
  }
  const text = chars.join('');
  function trim(start: number, end: number): [number, number] {
    while (start < end && /\s|\uFEFF/.test(text[start])) { opts.deadline?.check(); start++; }
    while (end > start && /\s|\uFEFF/.test(text[end - 1])) { opts.deadline?.check(); end--; }
    return [start, end];
  }
  /** 返回顶层分隔符，且验证所有嵌套括号/引号。 */
  function separators(start: number, end: number, sep: string): number[] {
    const stack: string[] = [];
    const found: number[] = [];
    let q = '';
    const closes: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
    for (let i = start; i < end; i++) {
      opts.deadline?.check();
      const ch = text[i];
      if (q) {
        if (ch === '\\') i++;
        else if (ch === q) q = '';
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      else if ('{[('.includes(ch)) {
        stack.push(ch);
        if (stack.length > (opts.maxDepth ?? 200)) fail(i, 'unexpected_token', '嵌套过深');
      } else if ('}])'.includes(ch)) {
        if (stack.pop() !== closes[ch]) fail(i, 'unexpected_token', '括号不匹配或存在尾部内容');
      } else if (ch === sep && stack.length === 0) found.push(i);
    }
    if (q) fail(end, 'unclosed_quote', 'Map 字符串引号未闭合');
    if (stack.length) fail(end, 'missing_bracket', 'Map 括号未闭合');
    return found;
  }
  function unquote(raw: string): string {
    return raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0] ? raw.slice(1, -1) : raw;
  }
  function node(start: number, end: number, path: string, depth: number): JVal {
    opts.deadline?.check();
    [start, end] = trim(start, end);
    if (depth > (opts.maxDepth ?? 200)) fail(start, 'unexpected_token', '嵌套过深');
    const raw = text.slice(start, end);
    const location = span(start, end);
    if (raw.startsWith('{') || raw.startsWith('[')) {
      const close = raw[0] === '{' ? '}' : ']';
      if (!raw.endsWith(close)) fail(end, 'missing_bracket', 'Map 括号未闭合或尾部有多余内容');
      // 去掉外壳后若遇到负深度，则是并列根结构或尾部残留。
      const commas = separators(start + 1, end - 1, ',');
      const boundaries = [start, ...commas, end - 1];
      const entries: ObjEntry[] = [];
      const items: JVal[] = [];
      const counts = new Map<string, number>();
      for (let i = 0; i < boundaries.length - 1; i++) {
        const [a, b] = trim(boundaries[i] + 1, boundaries[i + 1]);
        if (a === b) continue;
        if (raw[0] === '[') {
          items.push(node(a, b, makePath(path, items.length), depth + 1));
          continue;
        }
        const eq = separators(a, b, '=')[0];
        if (eq === undefined) fail(a, 'missing_colon', '键值分隔符缺失');
        const [keyStart, keyEnd] = trim(a, eq);
        const keyText = unquote(text.slice(keyStart, keyEnd));
        const occurrence = counts.get(keyText) ?? 0;
        counts.set(keyText, occurrence + 1);
        entries.push({
          key: { k: 'str', value: keyText, span: span(keyStart, keyEnd) },
          val: node(eq + 1, b, makePath(path, keyText, occurrence), depth + 1),
        });
      }
      return raw[0] === '{' ? { k: 'obj', entries, span: location } : { k: 'arr', items, span: location };
    }
    let value: JVal;
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      const normalized = normalizeNumber(raw);
      value = { k: 'num', raw: normalized, span: location };
      if (normalized !== raw) marks.push({ type: 'number_normalized', line: location.line, col: location.col, before: raw, after: normalized });
    } else if (/^(true|false)$/i.test(raw)) {
      value = { k: 'bool', value: raw.toLowerCase() === 'true', span: location };
    } else if (/^(null|none)$/i.test(raw)) {
      value = { k: 'null', span: location };
    } else {
      value = { k: 'str', value: unquote(raw), span: location };
    }
    values.push({ path, node: value, raw: unquote(raw), inferred: value.k === 'num' ? 'number' : value.k === 'bool' ? 'boolean' : value.k === 'null' ? 'null' : 'string' });
    return value;
  }
  const [start, end] = trim(0, text.length);
  if (text[start] !== '{' && text[start] !== '[') fail(start, 'unexpected_token', '不是有效的 Map.toString() 结构');
  const ir = node(start, end, '', 0);
  opts.deadline?.check(true);
  return { ir, marks, values };
}
