/** 共享类型导出，避免模块循环依赖 */

export type { Token, TokenType, Mark, MarkType, LexOptions, LexResult } from './lexer.js';
export type { JVal, Span, ObjEntry, ValueType } from './ir.js';
export type { FixEntry } from './fixLog.js';
export type { ErrorKind } from './errors.js';

export type SourceFormat = 'python' | 'json' | 'java' | 'map';

export const FORMAT_LABEL: Record<SourceFormat, string> = {
  python: 'Python 字面量',
  json: '标准 JSON',
  java: 'Java 转义字符串',
  map: 'Map.toString()',
};

export const ALL_FORMATS: SourceFormat[] = ['python', 'json', 'java', 'map'];

/** 输出方向（FR-A13） */
export type OutputLang = 'json' | 'python';

export function outputLangFor(src: SourceFormat): OutputLang {
  return src === 'python' ? 'json' : 'python';
}
