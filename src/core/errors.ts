/**
 * 错误定位与原因分类（FR-D6 / FR-D8）
 *
 * 评审 D-1：第 3 层不是「再解析一次」，而是把失败 token 的 line/col 格式化输出。
 * 位置信息天然精确，因为 Token 流只扫描一次。
 */

import type { Span, Token } from './types.js';

export type ErrorKind =
  | 'missing_bracket' // 缺少右括号/右方括号/右花括号
  | 'unclosed_quote' // 引号未闭合
  | 'missing_colon' // 键值分隔符缺失（FR-C13 对象内）
  | 'unexpected_char' // 存在无法识别的字符
  | 'bad_value' // 类型无法推断 / 非法值
  | 'unexpected_token' // 结构位置出现不应出现的 token
  | 'trailing_content' // 主干结构之后存在多余内容（FR-D11）
  | 'multiple_values' // 检测到多个并列值（JSON Lines，FR-D11）
  | 'empty_input';

const KIND_TEXT: Record<ErrorKind, string> = {
  missing_bracket: '缺少右括号',
  unclosed_quote: '引号未闭合',
  missing_colon: '键值分隔符缺失',
  unexpected_char: '存在无法识别的字符',
  bad_value: '类型无法推断',
  unexpected_token: '结构不完整',
  trailing_content: '尾部存在多余内容',
  multiple_values: '检测到多个并列值',
  empty_input: '输入为空',
};

export class ParseError extends Error {
  kind: ErrorKind;
  line: number;
  col: number;
  span?: Span;

  constructor(kind: ErrorKind, line: number, col: number, detail?: string, span?: Span) {
    super(`第 ${line} 行第 ${col} 列：${KIND_TEXT[kind]}${detail ? `（${detail}）` : ''}`);
    this.name = 'ParseError';
    this.kind = kind;
    this.line = line;
    this.col = col;
    this.span = span;
  }
}

export class TimeoutError extends Error {
  constructor() {
    super('转换超时');
    this.name = 'TimeoutError';
  }
}

/** FR-G6 / 评审 D-3：deadline checkpoint */
export class Deadline {
  private counter = 0;
  constructor(
    readonly deadlineAt: number,
    private readonly interval = 4096,
  ) {}
  check(): void {
    if (++this.counter % this.interval === 0 && Date.now() > this.deadlineAt) {
      throw new TimeoutError();
    }
  }
}

export function tokenSpan(t: Token | undefined): Span {
  if (!t) return { start: 0, end: 0, line: 1, col: 0 };
  return { start: t.start, end: t.end, line: t.line, col: t.col };
}

export function errAt(kind: ErrorKind, t: Token | undefined, detail?: string): ParseError {
  const s = tokenSpan(t);
  return new ParseError(kind, s.line, s.col, detail, s);
}

/** 分类名 → 展示文案（供 UI 直接取用） */
export function kindText(kind: ErrorKind): string {
  return KIND_TEXT[kind];
}
