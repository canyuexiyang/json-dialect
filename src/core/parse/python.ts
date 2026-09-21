/**
 * Python 字面量 parser（FR-A1–A7、FR-A15/A16）
 * strict 模式：Python 规范 —— 允许单引号、True/False/None、元组、末尾逗号（元组单元素），
 * 但不允许裸键名、注释、NaN/Infinity、未闭合括号。
 */

import { parseValue, type ParseOptions, type ParseOut } from './engine.js';
import type { Token } from '../lexer.js';

export function parsePython(toks: Token[], opts: Omit<ParseOptions, 'fmt'>): ParseOut {
  return parseValue(toks, { ...opts, fmt: 'python' });
}
