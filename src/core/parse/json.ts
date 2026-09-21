/**
 * 标准 JSON parser（FR-C1）
 * 复用统一引擎，strict 模式下强制双引号 / 小写 true|false|null / 无末尾逗号。
 */

import { parseValue, type ParseOptions, type ParseOut } from './engine.js';
import type { Token } from '../lexer.js';

export function parseJson(toks: Token[], opts: Omit<ParseOptions, 'fmt'>): ParseOut {
  return parseValue(toks, { ...opts, fmt: 'json' });
}
