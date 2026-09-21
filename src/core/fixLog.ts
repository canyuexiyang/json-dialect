/**
 * 修正记录（FR-D4 / FR-D5）
 *
 * 评审 D-1：修正记录天然来自 token.marks，行列定位免费得到。
 * 评审补充：修正记录补列号 —— 单行压缩输入只有行号时用户无法定位。
 */

import type { Mark } from './lexer.js';

export interface FixEntry {
  line: number;
  col: number;
  /** 涉及片段（截断显示） */
  before: string;
  /** 修正后的形态 */
  after: string;
  /** 执行的修正动作 */
  action: string;
}

const ACTION_TEXT: Record<Mark['type'], string> = {
  quote_fixed: '引号未闭合，已容错闭合',
  key_quoted: '键名补充引号',
  trailing_comma: '删除末尾多余逗号',
  missing_comma: '补充缺失的逗号',
  tail_ignored: '忽略主干结构之后的残留内容',
  comment_stripped: '剥离行注释',
  bracket_closed: '补齐缺失的右括号',
  nan_converted: '非 JSON 数值转换为 null',
  nonstring_key: '非字符串键转换为字符串',
  string_edge: '字符串边界容错',
  escaped_quote: '字符串内引号转义',
};

const MAX_SNIPPET = 24;

function clip(s: string): string {
  const one = s.replace(/\n/g, '\\n');
  return one.length > MAX_SNIPPET ? one.slice(0, MAX_SNIPPET) + '…' : one;
}

export function marksToFixes(marks: Mark[]): FixEntry[] {
  return marks.map((m) => ({
    line: m.line,
    col: m.col,
    before: clip(m.before),
    after: clip(m.after),
    action: ACTION_TEXT[m.type] ?? m.type,
  }));
}

/** 去重：同一位置同一动作只保留一条 */
export function dedupeFixes(fixes: FixEntry[]): FixEntry[] {
  const seen = new Set<string>();
  const out: FixEntry[] = [];
  for (const f of fixes) {
    const key = `${f.line}|${f.col}|${f.action}|${f.before}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** 重复键提示（FR-A6 修订 / G-5 / AC-44） */
export interface DuplicateInfo {
  count: number;
  keys: string[];
}

export function formatDuplicateHint(dup: DuplicateInfo): string {
  return `存在重复键 ${dup.count} 个，目标语言求值时后者将覆盖前者（${dup.keys.join('、')}）`;
}
