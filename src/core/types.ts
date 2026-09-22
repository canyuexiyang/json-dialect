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

/**
 * 输出方向（FR-A13 修订：由**目标格式**决定，而非来源）
 *
 * `java` = Java 转义字符串（FR-A18 / US-17）。
 */
export type OutputLang = 'json' | 'python' | 'java';

/**
 * 可选目标格式（FR-A17 / O-7）
 *
 * `Map.toString()` **不作为目标** —— Map 输出有损（类型信息丢失、字符串无引号、
 * 嵌套歧义），会产出「看起来对但语义已变」的文本，违背 FR-D11 的宁可明确失败精神。
 * 故目标矩阵为 4 来源 × 3 目标 = 12 种组合。
 */
export type TargetFormat = 'json' | 'python' | 'java';

export const TARGET_LABEL: Record<TargetFormat, string> = {
  json: '标准 JSON',
  python: 'Python 字面量',
  java: 'Java 转义字符串',
};

export const ALL_TARGETS: TargetFormat[] = ['json', 'python', 'java'];

/**
 * FR-A19「目标 = 来源」映射（格式化 tab 使用）。
 *
 * `map` 无对应序列化器（Map.toString() 不作为目标，见 O-7 的有损论证），
 * 故回退为 'auto' —— 由调用方明示告知用户，绝不静默改格式。
 */
export function sameTarget(src: SourceFormat): TargetFormat | 'auto' {
  if (src === 'json') return 'json';
  if (src === 'python') return 'python';
  if (src === 'java') return 'java';
  return 'auto';
}

/** FR-A13：目标为「自动」时沿用原有推导规则（来源 = Python → JSON；其余 → Python） */
export function outputLangFor(
  src: SourceFormat,
  target?: TargetFormat | 'auto' | 'same' | null,
): OutputLang {
  if (target && target !== 'auto' && target !== 'same') return target;
  if (target === 'same') {
    const t = sameTarget(src);
    if (t !== 'auto') return t;
  }
  return src === 'python' ? 'json' : 'python';
}
