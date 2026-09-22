/**
 * JSON / Python 双模式递归下降解析器（评审 D-1：一次 token 化 + strict 开关）
 *
 * 两种格式共用同一份 Token 流与同一套递归下降骨架，
 * 仅「什么是合法的」的规则表不同 —— 这样 FR-B11 全格式回退零成本。
 *
 * strict = true ：严格按来源格式规范解析，任何偏差即失败
 * strict = false：放行 5 类异常（裸键名、引号互转、末尾逗号、注释、括号未闭合）并打 mark
 */

import type { JVal, ObjEntry, Span } from '../ir.js';
import { keyToString } from '../ir.js';
import { stripLeadingZeros } from '../escape.js';
import type { Mark, Token } from '../lexer.js';
import type { SourceFormat } from '../types.js';
import { Deadline, ParseError, errAt } from '../errors.js';

export interface ParseOptions {
  strict: boolean;
  fmt: SourceFormat;
  deadline?: Deadline;
  /** 最大嵌套深度（防栈溢出） */
  maxDepth?: number;
  /**
   * 原始输入文本。
   *
   * Map 语法无法由 Token 流无损还原 —— 裸词之间的空白是**有效内容**
   * （`{a=hello world}` 的值是 "hello world"，不是 "helloworld"），
   * 而 significant() 会滤掉空白 token。故 Map parser 需要直接拿原文扫描。
   */
  rawText?: string;
}

export interface ParseOut {
  ir: JVal;
  marks: Mark[];
  /** 结构路径 → 值，供类型覆盖与下拉定位（FR-C8 / D-2） */
  values: ValueSlot[];
}

/** 序列化器产出的「值位置索引」（评审 D-2） */
export interface ValueSlot {
  path: string;
  node: JVal;
  /** Map 模式下推断自文本的类型 */
  inferred: 'string' | 'number' | 'boolean' | 'null';
  /** 原始文本（Map 模式用于类型切换） */
  raw: string;
}

const MAX_DEPTH_DEFAULT = 200;

class Cursor {
  i = 0;
  constructor(public toks: Token[]) {}
  peek(o = 0): Token | undefined {
    return this.toks[this.i + o];
  }
  next(): Token | undefined {
    return this.toks[this.i++];
  }
  eof(): boolean {
    return this.i >= this.toks.length;
  }
}

function spanFrom(a: Token | undefined, b: Token | undefined): Span {
  if (!a) return { start: 0, end: 0, line: 1, col: 0 };
  return { start: a.start, end: b ? b.end : a.end, line: a.line, col: a.col };
}

const TRUE_WORDS = new Set(['true', 'True', 'TRUE']);
const FALSE_WORDS = new Set(['false', 'False', 'FALSE']);
const NULL_WORDS = new Set(['null', 'Null', 'NULL', 'none', 'None', 'NONE', 'nil', 'Nil']);
const NAN_WORDS = new Set(['nan', 'NaN', 'NAN', 'inf', 'Inf', 'INF', 'Infinity', 'infinity', 'INFINITY']);
/** 带符号的非 JSON 数值：-inf / +nan 等（FR-A15） */
const SIGNED_NAN = /^[+-](nan|inf|infinity)$/i;

function mk(
  type: Mark['type'],
  t: Token | undefined,
  before: string,
  after: string,
): Mark {
  return { type, line: t?.line ?? 1, col: t?.col ?? 0, before, after };
}

/** 报错文案里的片段截断，避免超长文本撑爆提示条 */
function clipSnippet(s: string): string {
  const one = s.replace(/\n/g, '\\n');
  return one.length > 16 ? one.slice(0, 16) + '…' : one;
}

export function parseValue(
  toks: Token[],
  opts: ParseOptions,
): ParseOut {
  const c = new Cursor(toks);
  const marks: Mark[] = [];
  const values: ValueSlot[] = [];
  const maxDepth = opts.maxDepth ?? MAX_DEPTH_DEFAULT;
  const strict = opts.strict;
  const isPy = opts.fmt === 'python';

  const die = (kind: ParseError['kind'], t?: Token, detail?: string): never => {
    throw errAt(kind, t ?? c.peek(-1), detail);
  };
  /** 断言守卫：`if (!t) die(...)` 之后 TS 仍认为 t 可能为 undefined，需显式收窄 */
  const need = (t: Token | undefined, kind: ParseError['kind'], detail?: string): Token => {
    if (!t) throw errAt(kind, undefined, detail);
    return t;
  };

  function collect(node: JVal, path: string): void {
    if (node.k === 'obj') {
      node.entries.forEach((e, idx) => {
        const key = keyToString(e.key);
        const child = `${path}/${key}`;
        collect(e.val, child);
        // 同名键在路径上加序号区分
        const dupCount = node.entries.slice(0, idx).filter((x) => keyToString(x.key) === key).length;
        if (dupCount > 0) collect(e.val, `${child}#${dupCount}`);
      });
      return;
    }
    if (node.k === 'arr') {
      node.items.forEach((it, idx) => collect(it, `${path}/${idx}`));
      return;
    }
    values.push({
      path,
      node,
      inferred:
        node.k === 'num'
          ? 'number'
          : node.k === 'bool'
            ? 'boolean'
            : node.k === 'null'
              ? 'null'
              : 'string',
      raw: node.k === 'num' ? node.raw : node.k === 'str' ? node.value : '',
    });
  }

  function parseNode(depth: number): JVal {
    if (depth > maxDepth) {
      return die('unexpected_token', c.peek(), '嵌套过深');
    }
    opts.deadline?.check();
    const t = need(c.peek(), 'unexpected_token', '内容不完整');

    // ---- 对象 ----
    if (t.type === 'punct' && t.raw === '{') {
      const open = c.next()!;
      const entries: ObjEntry[] = [];
      let closed = false;
      while (!c.eof()) {
        const p = c.peek();
        if (p?.type === 'punct' && p.raw === '}') {
          c.next();
          closed = true;
          break;
        }
        // 末尾多余逗号
        if (p?.type === 'punct' && p.raw === ',') {
          c.next();
          const after = c.peek();
          if (after?.type === 'punct' && after.raw === '}') {
            if (strict) die('unexpected_token', p, '多余逗号');
            marks.push(mk('trailing_comma', p, ',', ''));
            c.next();
            closed = true;
            break;
          }
          if (strict) die('unexpected_token', p, '多余逗号');
          marks.push(mk('trailing_comma', p, ',', ''));
          continue;
        }
        // 键
        const keyTok = c.peek()!;
        let key: JVal;
        if (keyTok.type === 'string') {
          c.next();
          if (strict && isPy && keyTok.quote === '"') {
            // JSON 模式下双引号是合法的；Python 模式下也接受（用户可能混用）
          }
          key = {
            k: 'str',
            value: keyTok.value ?? '',
            span: spanFrom(keyTok, keyTok),
          };
          if (keyTok.marks.length) marks.push(...keyTok.marks);
        } else if (keyTok.type === 'ident' || keyTok.type === 'number') {
          // 裸键名（FR-D3：键名补引号）
          if (keyTok.type === 'number') {
            c.next();
            key = { k: 'num', raw: stripLeadingZeros(keyTok.numRaw ?? keyTok.raw), span: spanFrom(keyTok, keyTok) };
            marks.push(mk('nonstring_key', keyTok, keyTok.raw, `"${keyTok.raw}"`));
          } else {
            const w = keyTok.raw;
            // True/False/None/NaN 这类字面量作键：严格模式判非法；
            // 宽松模式按 FR-A16 转为字符串键并记修正（JSON 对象键必须是字符串，
            // 报错不如转字符串 + 显式提示 —— 与 FR-A15/A16 同一取舍原则）。
            if (TRUE_WORDS.has(w) || FALSE_WORDS.has(w) || NAN_WORDS.has(w) || NULL_WORDS.has(w)) {
              if (strict) die('missing_colon', keyTok, `键名位置出现字面量 ${w}`);
            }
            c.next();
            key = { k: 'str', value: w, span: spanFrom(keyTok, keyTok) };
            if (strict) die('unexpected_token', keyTok, '键名缺少引号');
            marks.push(mk('key_quoted', keyTok, w, `'${w}'`));
          }
        } else if (keyTok.type === 'punct' && keyTok.raw === '(') {
          // 元组键： (1, 2): 'x' （FR-A16）
          c.next();
          const items: JVal[] = [];
          const openP = keyTok;
          let closedP = false;
          while (!c.eof()) {
            const q = c.peek();
            if (q?.type === 'punct' && q.raw === ')') {
              c.next();
              closedP = true;
              break;
            }
            if (q?.type === 'punct' && q.raw === ',') {
              c.next();
              continue;
            }
            items.push(parseNode(depth + 1));
          }
          if (!closedP) {
            if (strict) die('missing_bracket', openP, '元组键缺少右括号');
            marks.push(mk('bracket_closed', c.peek(-1), '(', ')'));
          }
          key = { k: 'arr', items, span: spanFrom(openP, c.peek(-1)) };
          marks.push(mk('nonstring_key', openP, keyToString(key), `"${keyToString(key)}"`));
        } else {
          return die('unexpected_token', keyTok, '键名位置无效');
        }

        // 分隔符 : 或 =
        const sep = c.peek();
        if (sep?.type === 'punct' && (sep.raw === ':' || sep.raw === '=')) {
          c.next();
          if (strict && opts.fmt === 'json' && sep.raw === '=') {
            die('missing_colon', sep, 'JSON 应使用 : 分隔');
          }
        } else {
          die('missing_colon', sep, '缺少键值分隔符');
        }

        const val = parseNode(depth + 1);
        entries.push({ key, val });

        // 逗号或结束
        const nx = c.peek();
        if (nx?.type === 'punct' && nx.raw === ',') {
          c.next();
          // 末尾多余逗号：逗号之后紧跟 } （AC-17/AC-18）
          const afterComma = c.peek();
          if (afterComma?.type === 'punct' && afterComma.raw === '}') {
            if (strict) die('unexpected_token', nx, '多余逗号');
            marks.push(mk('trailing_comma', nx, ',', ''));
            c.next();
            closed = true;
            break;
          }
          continue;
        }
        if (nx?.type === 'punct' && nx.raw === '}') {
          c.next();
          closed = true;
          break;
        }
        if (nx === undefined) {
          if (strict) die('missing_bracket', open, '缺少右花括号');
          marks.push(mk('bracket_closed', c.peek(-1), '', '}'));
          closed = true;
          break;
        }
        // 缺少逗号但直接跟了下一个键 → 宽松模式放行
        if (!strict) {
          marks.push(mk('trailing_comma', nx, '', ','));
          continue;
        }
        die('unexpected_token', nx, '缺少逗号');
      }
      if (!closed) {
        if (strict) die('missing_bracket', open, '缺少右花括号');
        marks.push(mk('bracket_closed', c.peek(-1), '', '}'));
      }
      return { k: 'obj', entries, span: spanFrom(open, c.peek(-1)) };
    }

    // ---- 数组 / 元组 ----
    if (t.type === 'punct' && (t.raw === '[' || t.raw === '(')) {
      const open = c.next()!;
      const openCh = t.raw;
      const closeCh = openCh === '[' ? ']' : ')';
      const items: JVal[] = [];
      let closed = false;
      while (!c.eof()) {
        const p = c.peek();
        if (p?.type === 'punct' && p.raw === closeCh) {
          c.next();
          closed = true;
          break;
        }
        if (p?.type === 'punct' && p.raw === ',') {
          c.next();
          const after = c.peek();
          if (after?.type === 'punct' && after.raw === closeCh) {
            if (strict) die('unexpected_token', p, '多余逗号');
            marks.push(mk('trailing_comma', p, ',', ''));
            c.next();
            closed = true;
            break;
          }
          if (strict) die('unexpected_token', p, '多余逗号');
          marks.push(mk('trailing_comma', p, ',', ''));
          continue;
        }
        items.push(parseNode(depth + 1));
        const nx = c.peek();
        if (nx?.type === 'punct' && nx.raw === ',') {
          c.next();
          // 末尾多余逗号：逗号之后紧跟闭合符（AC-17/AC-18）
          const afterComma = c.peek();
          if (afterComma?.type === 'punct' && afterComma.raw === closeCh) {
            if (strict) die('unexpected_token', nx, '多余逗号');
            marks.push(mk('trailing_comma', nx, ',', ''));
            c.next();
            closed = true;
            break;
          }
          continue;
        }
        if (nx?.type === 'punct' && nx.raw === closeCh) {
          c.next();
          closed = true;
          break;
        }
        if (nx === undefined) {
          if (strict) die('missing_bracket', open, `缺少${closeCh === ']' ? '右方括号' : '右括号'}`);
          marks.push(mk('bracket_closed', c.peek(-1), '', closeCh));
          closed = true;
          break;
        }
        if (!strict) {
          marks.push(mk('trailing_comma', nx, '', ','));
          continue;
        }
        die('unexpected_token', nx, '缺少逗号');
      }
      if (!closed) {
        if (strict) die('missing_bracket', open, `缺少${closeCh === ']' ? '右方括号' : '右括号'}`);
        marks.push(mk('bracket_closed', c.peek(-1), '', closeCh));
      }
      // FR-A5：Python 元组 → JSON 数组（arr 已统一表示）
      return { k: 'arr', items, span: spanFrom(open, c.peek(-1)) };
    }

    // ---- 字符串 ----
    if (t.type === 'string') {
      c.next();
      if (t.marks.length) marks.push(...t.marks);
      // strict 模式：引号形态不符规范 → 失败
      if (strict) {
        if (opts.fmt === 'json' && t.quote === "'") die('unclosed_quote', t, 'JSON 字符串应使用双引号');
        if (opts.fmt === 'python' && t.quote === '"' && false) die('unclosed_quote', t, '');
      }
      return { k: 'str', value: t.value ?? '', span: spanFrom(t, t) };
    }

    // ---- 数字 ----
    if (t.type === 'number') {
      c.next();
      return { k: 'num', raw: stripLeadingZeros(t.numRaw ?? t.raw), span: spanFrom(t, t) };
    }

    // ---- 标识符 ----
    if (t.type === 'ident') {
      const w = t.raw;
      c.next();
      if (TRUE_WORDS.has(w)) {
        if (strict && opts.fmt === 'json' && w !== 'true') die('bad_value', t, 'JSON 布尔应为 true');
        return { k: 'bool', value: true, span: spanFrom(t, t) };
      }
      if (FALSE_WORDS.has(w)) {
        if (strict && opts.fmt === 'json' && w !== 'false') die('bad_value', t, 'JSON 布尔应为 false');
        return { k: 'bool', value: false, span: spanFrom(t, t) };
      }
      if (NULL_WORDS.has(w)) {
        if (strict && opts.fmt === 'json' && w !== 'null') die('bad_value', t, 'JSON 空值应为 null');
        return { k: 'null', span: spanFrom(t, t) };
      }
      if (NAN_WORDS.has(w) || SIGNED_NAN.test(w)) {
        // FR-A15：NaN / Infinity / -Infinity → null
        if (strict) die('bad_value', t, `${w} 不是合法字面量`);
        marks.push(mk('nan_converted', t, w, 'null'));
        return { k: 'null', span: spanFrom(t, t) };
      }
      return die('unexpected_char', t, `无法识别的字面量 ${w}`);
    }

    return die('unexpected_char', t, `无法识别的字符 ${t.raw}`);
  }

  const root = parseNode(0);

  // 尾部残留（FR-D11）：主干结构解析完成后仍有未消费 token → 一律报错，绝不静默丢弃。
  //
  // 历史缺陷：这里曾无条件 push 一条 `trailing_comma` 修正后继续返回成功，
  // 导致 `2024-01-01 12:00:00 INFO {"a":1}` 输出成 `2024-01-01`、
  // `{"a":1}\n{"b":2}` 只输出第一个对象，而状态却报「已自动修正」—— 静默丢数据。
  // 「能救就救」只适用于**同一个值内部的语法残缺**，丢弃额外的值不是修复。
  if (!c.eof()) {
    const rest = c.peek()!;
    // 区分两种形态：并列多个值（JSON Lines）vs 单纯尾部垃圾
    const isAnotherValue =
      rest.type === 'punct' && (rest.raw === '{' || rest.raw === '[' || rest.raw === '(');
    if (isAnotherValue) {
      die('multiple_values', rest, '本工具一次只处理一个值');
    }
    die('trailing_content', rest, `多余内容「${clipSnippet(rest.raw)}」`);
  }

  collect(root, '');
  return { ir: root, marks, values };
}
