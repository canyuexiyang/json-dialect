/**
 * 统一 tokenizer（技术评审 §5.1 / D-1）
 *
 * 核心架构约束：
 *  - **一次扫描**，产出带 {line, col, marks} 的 Token 流
 *  - 四种来源格式的 parser 与 detect 打分器共享同一份流（FR-B3 / FR-B11）
 *  - 绝不做「多轮重写文本再解析」——那会导致修复顺序依赖与行列漂移
 */

import { decodeStringBody } from './escape.js';

export type TokenType =
  | 'punct' // { } [ ] ( ) , : =
  | 'string' // 字符串字面量（单引号或双引号）
  | 'number'
  | 'ident' // 裸标识符：true/True/nan/foo...
  | 'comment' // Python # 行注释
  | 'ws'
  | 'invalid'; // 无法识别的字符

/** 该 token 生成时触发的「容忍修复」（评审 D-1） */
export type MarkType =
  | 'quote_fixed' // 单/双引号互转补齐或引号未闭合
  | 'key_quoted' // 裸键名补引号
  | 'trailing_comma' // 删除末尾多余逗号
  | 'missing_comma' // 补充缺失的逗号（两个条目之间）
  | 'tail_ignored' // 忽略主干结构之后的残留内容
  | 'comment_stripped' // 剥离 # 注释
  | 'bracket_closed' // 补齐缺失的右括号
  | 'nan_converted' // NaN / Infinity → null（FR-A15）
  | 'nonstring_key' // 非字符串键转字符串（FR-A16）
  | 'string_edge' // 字符串边界容错（越过未闭合引号继续扫描）
  | 'escaped_quote'; // 字符串内引号转义

export interface Mark {
  type: MarkType;
  line: number;
  col: number;
  before: string;
  after: string;
}

export interface Token {
  type: TokenType;
  /** 原始文本（字符串为 body，未反转义） */
  raw: string;
  /** 字符串的引号字符；非字符串为 null */
  quote?: '"' | "'" | null;
  /** 反转义后的字符串值（仅 string） */
  value?: string;
  /** 数字原始 token（仅 number，FR-A11 透传） */
  numRaw?: string;
  /** 三引号字符串标记 */
  triple?: boolean;
  start: number;
  end: number;
  line: number; // 1-based
  col: number; // 0-based
  marks: Mark[];
}

const PUNCT = new Set(['{', '}', '[', ']', '(', ')', ',', ':', '=']);
const NUM_START = /[0-9]/;
const NUM_BODY = /[0-9eE+\-.]/;
const IDENT_START = /[A-Za-z_$@]/;
const IDENT_BODY = /[A-Za-z0-9_$@.]/;

export interface LexOptions {
  /** 是否允许 Python `#` 注释（Python / Map 模式开启） */
  allowComment?: boolean;
}

/**
 * 行列跟踪器。
 *
 * 性能关键：不用「每次从头扫到 i」的实现（O(n²)，500 行文本会退化到数百毫秒），
 * 改为在 lex 主循环中随字符推进增量维护 line/lineStart，查询是 O(1)。
 */
class LineTracker {
  line = 1;
  lineStart = 0;
  /** 遇到换行时调用 */
  newline(at: number): void {
    this.line++;
    this.lineStart = at + 1;
  }
  /** 字符偏移 → {line, col}（1-based line，0-based col） */
  pos(i: number): { line: number; col: number } {
    return { line: this.line, col: i - this.lineStart };
  }
}

export interface LexResult {
  tokens: Token[];
  marks: Mark[];
}

/**
 * 扫描文本产出 Token 流。永不抛异常——无法识别的字符产出 invalid token，
 * 由 parser 决定在 strict 模式下报错还是在 lenient 模式下忽略。
 */
export function lex(text: string, opts: LexOptions = {}): LexResult {
  const allowComment = opts.allowComment ?? true;
  const tokens: Token[] = [];
  const marks: Mark[] = [];
  const lt = new LineTracker();
  let i = 0;

  const push = (
    type: TokenType,
    start: number,
    raw: string,
    extra: Partial<Token> = {},
    mk: Mark[] = [],
  ) => {
    const { line: ln, col } = lt.pos(start);
    tokens.push({
      type,
      raw,
      start,
      end: start + raw.length,
      line: ln,
      col,
      marks: mk,
      ...extra,
    });
    marks.push(...mk);
  };

  while (i < text.length) {
    const ch = text[i];

    // 换行：增量维护行列（O(1)，不回扫）
    if (ch === '\n') {
      lt.newline(i);
      i++;
      continue;
    }

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      const s = i;
      while (i < text.length && /[ \t\r\f\v]/.test(text[i])) i++;
      push('ws', s, text.slice(s, i));
      continue;
    }

    // 注释（Python # 行注释）
    if (ch === '#' && allowComment) {
      const s = i;
      while (i < text.length && text[i] !== '\n') i++;
      const raw = text.slice(s, i);
      const pos = lt.pos(s);
      const mk: Mark[] = [
        {
          type: 'comment_stripped',
          line: pos.line,
          col: pos.col,
          before: raw,
          after: '',
        },
      ];
      push('comment', s, raw, {}, mk);
      continue;
    }

    // 标点
    if (PUNCT.has(ch)) {
      push('punct', i, ch);
      i++;
      continue;
    }

    // 数字：可能是 -1、1e5、.5、1.
    // 注意：符号后必须紧跟数字才认定为数字，否则 `-inf` 会被切成 `-` + `inf`（FR-A15 需识别为 ident）
    if (
      NUM_START.test(ch) ||
      ((ch === '-' || ch === '+') && /[0-9]/.test(text[i + 1] ?? '')) ||
      (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))
    ) {
      const s = i;
      i++;
      while (i < text.length && NUM_BODY.test(text[i])) {
        // 允许 e/E 后跟 +/-，但不允许连续多个符号造成误吞
        i++;
      }
      // 回退尾部孤立符号（如 `1-` 不应把 - 吞进数字）
      while (i > s + 1 && /[+\-]$/.test(text.slice(s, i))) i--;
      let raw = text.slice(s, i);
      if (raw.endsWith('.')) {
        raw = raw.slice(0, -1);
        i--;
      }
      push('number', s, raw, { numRaw: raw });
      continue;
    }

    // 字符串（含三引号）
    if (ch === '"' || ch === "'") {
      const s = i;
      const q = ch as '"' | "'";
      const tripleQ = text.slice(i, i + 3) === q + q + q;
      const qLen = tripleQ ? 3 : 1;
      let j = i + qLen;
      let body = '';
      let closed = false;
      const mk: Mark[] = [];
      while (j < text.length) {
        const c = text[j];
        if (c === '\\') {
          const nx = text[j + 1];
          if (nx !== undefined) {
            body += c + nx;
            if (nx === q) {
              mk.push({
                type: 'escaped_quote',
                line: lt.pos(j).line,
                col: lt.pos(j).col,
                before: c + nx,
                after: nx,
              });
            }
            j += 2;
            continue;
          }
          body += c;
          j++;
          continue;
        }
        if (c === q) {
          if (tripleQ && text.slice(j, j + 3) === q + q + q) {
            j += 3;
            closed = true;
            break;
          }
          if (!tripleQ) {
            j++;
            closed = true;
            break;
          }
          body += c;
          j++;
          continue;
        }
        if (c === '\n' && !tripleQ) {
          // 单行字符串遇到换行 → 未闭合，容错继续（标记）
          const p = lt.pos(j);
          mk.push({
            type: 'quote_fixed',
            line: p.line,
            col: p.col,
            before: '(未闭合引号)',
            after: '(容错闭合)',
          });
          break;
        }
        // 三引号字符串可跨行：同步推进行列，否则后续 token 的行号会漂移
        if (tripleQ && c === '\n') {
          lt.newline(j);
        }
        body += c;
        j++;
      }
      const raw = text.slice(s, j);
      if (!closed) {
        mk.push({
          type: 'quote_fixed',
          line: lt.pos(s).line,
          col: lt.pos(s).col,
          before: '(未闭合引号)',
          after: '(已容错闭合)',
        });
      }
      push('string', s, raw, { quote: q, value: decodeStringBody(body), triple: tripleQ }, mk);
      i = j;
      continue;
    }

    // 标识符（含前导符号的 -inf / -Infinity / +nan，供 FR-A15 识别）
    if (
      IDENT_START.test(ch) ||
      ((ch === '-' || ch === '+') && IDENT_START.test(text[i + 1] ?? ''))
    ) {
      const s = i;
      if (ch === '-' || ch === '+') i++;
      while (i < text.length && IDENT_BODY.test(text[i])) i++;
      push('ident', s, text.slice(s, i));
      continue;
    }

    // 无法识别的字符
    push('invalid', i, ch, {}, [
      {
        type: 'bracket_closed',
        line: lt.pos(i).line,
        col: lt.pos(i).col,
        before: ch,
        after: '(无法识别的字符)',
      },
    ]);
    i++;
  }

  return { tokens, marks };
}

/** 过滤掉空白与注释，得到「有意义」的 token 流 */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment');
}

/** 兼容旧调用：只返回 tokens */
export function tokenize(text: string, opts?: LexOptions): Token[] {
  return lex(text, opts).tokens;
}
