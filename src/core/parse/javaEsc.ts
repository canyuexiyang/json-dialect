/**
 * Java 转义字符串 parser（FR-C2 / AC-10）
 *
 * 输入形如：{\"name\": \"张三\", \"age\": 18}
 * 处理：整段被双引号包裹 → 先反转义 → 再按 JSON 解析。
 *
 * 严格模式额外要求「整段包裹」这一结构前提（C-2 修订）；
 * 宽松模式下也接受未包裹但含 \" 的文本。
 */

import type { Token } from '../lexer.js';
import { lex, significant } from '../lexer.js';
import { decodeStringBody } from '../escape.js';
import { parseJson } from './json.js';
import type { ParseOptions, ParseOut } from './engine.js';
import { ParseError } from '../errors.js';

/** 判断是否呈现 Java 转义字符串特征（§7.1 C-2 结构前提） */
export function looksLikeJavaEscaped(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  if (!(t[0] === '"' && t[t.length - 1] === '"')) return false;
  return t.slice(1, -1).includes('\\"');
}

export function unescapeJavaText(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return decodeStringBody(t.slice(1, -1));
  }
  return decodeStringBody(t);
}

export function parseJavaEsc(toks: Token[], opts: Omit<ParseOptions, 'fmt'>): ParseOut {
  const raw = significant(toks)
    .map((t) => t.raw)
    .join('');
  if (opts.strict && !looksLikeJavaEscaped(raw)) {
    throw new ParseError('unexpected_char', 1, 0, '不是整段包裹的 Java 转义字符串');
  }
  const inner = unescapeJavaText(raw);
  const innerToks = lex(inner).tokens.filter((t) => t.type !== 'ws');
  return parseJson(innerToks, opts);
}
