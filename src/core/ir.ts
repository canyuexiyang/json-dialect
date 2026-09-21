/**
 * 中间表示（IR）—— 技术评审报告 D-7
 *
 * 关键约束（FR-A11）：num 节点只存 raw 原始 token，
 * 全程不调用 Number()，杜绝精度丢失与科学计数法归一化。
 */

/** 位置信息：同时提供字符偏移量与行列（FR-D6 行列定位） */
export interface Span {
  start: number;
  end: number;
  line: number; // 1-based
  col: number; // 0-based
}

export type JVal =
  | { k: 'obj'; entries: Array<{ key: JVal; val: JVal }>; span: Span }
  | { k: 'arr'; items: JVal[]; span: Span }
  | { k: 'str'; value: string; span: Span }
  | { k: 'num'; raw: string; span: Span }
  | { k: 'bool'; value: boolean; span: Span }
  | { k: 'null'; span: Span };

export interface ObjEntry {
  key: JVal;
  val: JVal;
}

export function obj(entries: ObjEntry[], span: Span): JVal {
  return { k: 'obj', entries, span };
}
export function arr(items: JVal[], span: Span): JVal {
  return { k: 'arr', items, span };
}
export function str(value: string, span: Span): JVal {
  return { k: 'str', value, span };
}
export function num(raw: string, span: Span): JVal {
  return { k: 'num', raw, span };
}
export function bool(value: boolean, span: Span): JVal {
  return { k: 'bool', value, span };
}
export function nul(span: Span): JVal {
  return { k: 'null', span };
}

export const EMPTY_SPAN: Span = { start: 0, end: 0, line: 1, col: 0 };

/**
 * Map 模式的值类型（FR-C5 / FR-C6）
 * 'infer' 表示沿用自动推断结果，不强制覆盖。
 */
export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'infer';

/** 结构路径（评审 D-7）："/user/age"、"/tags/0"、"/list/2/name" */
export function makePath(parent: string, seg: string | number): string {
  return parent + '/' + String(seg);
}

/** 取对象键的字符串表示；非字符串键按 FR-A16 转换 */
export function keyToString(k: JVal): string {
  switch (k.k) {
    case 'str':
      return k.value;
    case 'num':
      return k.raw;
    case 'bool':
      return k.value ? 'True' : 'False';
    case 'null':
      return 'None';
    case 'arr':
      return '(' + k.items.map(keyToString).join(', ') + ')';
    case 'obj':
      return '{' + k.entries.map((e) => keyToString(e.key) + ': ' + keyToString(e.val)).join(', ') + '}';
  }
}

/** 该键是否属于「非字符串键」（FR-A16 需记录修正） */
export function isNonStringKey(k: JVal): boolean {
  return k.k !== 'str';
}
