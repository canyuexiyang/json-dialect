/**
 * 转换引擎统一入口（评审 §5.2）
 *
 * 输入文本
 *   ├─ lexer(text)  → Token[]          // 一次扫描
 *   ├─ detect(Token[]) → 首选格式       // 手动锁定则跳过
 *   └─ for fmt of [首选, ...回退]:
 *        parse(strict=true)  成功 → 「已解析」
 *        parse(strict=false) 成功 → 「已修复」
 *      全部失败 → errors.from(failure)
 */

import { lex, significant, type Mark, type Token } from './lexer.js';
import { detect, fallbackOrder } from './detect.js';
import { parseJson } from './parse/json.js';
import { parsePython } from './parse/python.js';
import { parseMap } from './parse/mapText.js';
import { parseJavaEsc } from './parse/javaEsc.js';
import { toJson } from './serialize/toJson.js';
import { toPython, type TypeOverride } from './serialize/toPython.js';
import { toJavaEsc } from './serialize/toJavaEsc.js';
import { marksToFixes, dedupeFixes, type FixEntry, type DuplicateInfo } from './fixLog.js';
import { Deadline, ParseError, TimeoutError } from './errors.js';
import { findLogPrefix, type LogPrefix } from './logPrefix.js';
import { keyToString, type JVal } from './ir.js';
import {
  outputLangFor,
  sameTarget,
  type OutputLang,
  type SourceFormat,
  type TargetFormat,
} from './types.js';
import type { ValueSlot } from './parse/engine.js';

/** 日志前缀剥离尝试（FR-D13）：解析失败时附带，供 UI 提供一键入口 */
export interface PrefixHint {
  prefix: string;
  body: string;
}

export type ConvertStatus = 'empty' | 'ok' | 'fixed' | 'fallback' | 'error' | 'timeout';

export interface ConvertResult {
  status: ConvertStatus;
  /** 生效的来源格式 */
  source: SourceFormat;
  /** 是否手动锁定 */
  locked: boolean;
  /** 经由回退解析成功（FR-B11） */
  fallbackFrom?: SourceFormat;
  output: string;
  outputLang: OutputLang;
  ir?: JVal;
  values: ValueSlot[];
  fixes: FixEntry[];
  duplicates?: DuplicateInfo;
  error?: { kind: string; line: number; col: number; message: string };
  /** FR-D13：解析失败且疑似日志前缀时给出一键剥离入口 */
  prefixHint?: PrefixHint;
  /** 实际生效的目标（'same' 解析后）；map 来源取 'same' 会回退为 auto（O-7） */
  resolvedTarget?: TargetFormat | 'auto';
  stats: { lines: number; chars: number };
}

export interface ConvertOptions {
  /** 用户手动锁定的来源格式 */
  force?: SourceFormat | null;
  compact?: boolean;
  timeoutMs?: number;
  overrides?: TypeOverride;
  /** 已存在的 token 流（放大页复用，避免重复扫描） */
  tokens?: Token[];
  rawText?: string;
  /**
   * FR-A17：目标格式。默认 'auto'（沿用 v1.0 的「由来源推导」规则，行为不变）。
   * 该选择**不得**影响来源格式判定（AC-66）。
   *
   * `'same'` = FR-A19「目标 = 来源」，即同语言规范化（格式化 tab 使用）。
   * 来源为 map 时无对应序列化器，回退为 auto 并由 `sameTargetFallback` 标记告知。
   */
  target?: TargetFormat | 'auto' | 'same';
  /**
   * FR-K1：格式化 tab 的严格档。
   * true = 只跑严格解析，不进宽松层、不做跨格式回退 —— 任何偏差直接报错。
   * 与「目标 = 来源」配合即「同语言规范化且不改数据」。
   */
  strictOnly?: boolean;
  /**
   * FR-D13/D14：已由用户确认剥离的日志前缀。
   * 传入后不再解析该前缀，并把「剥离了什么」写进修正记录 —— 剥离本身必须可见。
   */
  strippedPrefix?: string;
}

interface ParserOpts {
  strict: boolean;
  deadline?: Deadline;
  /** 原始输入文本（Map parser 需要，见 engine.ts ParseOptions.rawText 说明） */
  rawText?: string;
}

const PARSERS: Record<
  SourceFormat,
  (t: Token[], o: ParserOpts) => { ir: JVal; marks: Mark[]; values: ValueSlot[] }
> = {
  json: parseJson,
  python: parsePython,
  map: parseMap,
  java: parseJavaEsc,
};

/** 修正记录片段截断，与 fixLog.ts 的 clip 保持一致 */
function clipForMark(s: string): string {
  const one = s.replace(/\n/g, '\\n');
  return one.length > 24 ? one.slice(0, 24) + '…' : one;
}

/** FR-F4：字符数按 Unicode 码点；行数 = 换行符数 + 1 */
export function computeStats(text: string): { lines: number; chars: number } {
  let lines = 1;
  for (const ch of text) if (ch === '\n') lines++;
  return { lines, chars: [...text].length };
}

function collectDuplicates(ir: JVal): DuplicateInfo | undefined {
  const seen = new Map<string, number>();
  const dupKeys = new Set<string>();
  function walk(n: JVal): void {
    if (n.k !== 'obj') {
      if (n.k === 'arr') n.items.forEach(walk);
      return;
    }
    const local = new Set<string>();
    for (const e of n.entries) {
      const k = keyToString(e.key);
      if (local.has(k)) dupKeys.add(k);
      local.add(k);
      walk(e.val);
    }
  }
  walk(ir);
  if (dupKeys.size === 0) return undefined;
  let count = 0;
  const keys: string[] = [];
  // 统计重复条目数
  function countDups(n: JVal): void {
    if (n.k !== 'obj') {
      if (n.k === 'arr') n.items.forEach(countDups);
      return;
    }
    const freq = new Map<string, number>();
    for (const e of n.entries) {
      const k = keyToString(e.key);
      freq.set(k, (freq.get(k) ?? 0) + 1);
      countDups(e.val);
    }
    for (const [k, v] of freq) {
      if (v > 1) {
        count += v - 1;
        keys.push(k);
      }
    }
  }
  countDups(ir);
  seen.clear();
  return { count, keys };
}

export function convert(text: string, opts: ConvertOptions = {}): ConvertResult {
  const stats = computeStats(text);
  const emptyBase = (source: SourceFormat, locked: boolean): ConvertResult => ({
    status: 'empty',
    source,
    locked,
    output: '',
    outputLang: outputLangFor(source, opts.target),
    values: [],
    fixes: [],
    stats,
  });

  if (text.trim() === '') {
    return emptyBase(opts.force ?? 'json', !!opts.force);
  }

  // FR-D13：已确认剥离的前缀 → 只解析主体，并把剥离动作记进修正记录（FR-D14）
  let working = text;
  let prefixMark: Mark | null = null;
  if (opts.strippedPrefix && text.startsWith(opts.strippedPrefix)) {
    working = text.slice(opts.strippedPrefix.length);
    prefixMark = {
      type: 'prefix_stripped',
      line: 1,
      col: 0,
      before: clipForMark(opts.strippedPrefix),
      after: '',
    };
  }

  const lexed = opts.tokens ? null : lex(working);
  const tokens = opts.tokens ?? lexed!.tokens;
  const sig = significant(tokens);
  const primary: SourceFormat = opts.force ?? detect(tokens, working).format;
  const locked = !!opts.force;

  const deadline = new Deadline(Date.now() + (opts.timeoutMs ?? 3000));

  // FR-K1 严格档：只跑严格层、不跨格式回退 —— 语法偏差一律报错，不自动修复
  const strictOnly = opts.strictOnly ?? false;
  const order: SourceFormat[] = locked || strictOnly
    ? [primary]
    : [primary, ...fallbackOrder(primary)];
  let lastErr: ParseError | null = null;
  // 注释剥离发生在 lexer 层，其修正记录存在于完整 token 流中；
  // 成功路径需把它并入 fixLog，否则 AC-19「修正条列出剥离位置」不成立。
  const lexMarks = prefixMark ? [prefixMark, ...(lexed?.marks ?? [])] : (lexed?.marks ?? []);

  for (let oi = 0; oi < order.length; oi++) {
    const fmt = order[oi];
    const parser = PARSERS[fmt];
    // 严格层
    try {
      const r = parser(sig, { strict: true, deadline, rawText: working });
      return buildResult(
        r.ir,
        r.marks,
        r.values,
        fmt,
        locked,
        opts,
        stats,
        false,
        oi > 0 ? primary : undefined,
        lexMarks,
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        return {
          ...emptyBase(fmt, locked),
          status: 'timeout',
          error: { kind: 'timeout', line: 1, col: 0, message: '转换超时，建议用放大页面或拆分文本' },
        };
      }
      lastErr = e as ParseError;
      // 严格档到此为止：不再进宽松层、不再跨格式回退
      if (strictOnly) break;
    }
    // 宽松层
    try {
      const r = parser(sig, { strict: false, deadline, rawText: working });
      return buildResult(
        r.ir,
        r.marks,
        r.values,
        fmt,
        locked,
        opts,
        stats,
        true,
        oi > 0 ? primary : undefined,
        lexMarks,
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        return {
          ...emptyBase(fmt, locked),
          status: 'timeout',
          error: { kind: 'timeout', line: 1, col: 0, message: '转换超时，建议用放大页面或拆分文本' },
        };
      }
      lastErr = e as ParseError;
    }
  }

  // 全部失败（FR-D13）：若主干结构之前存在疑似日志前缀，给出一键剥离入口。
  // 注意只在此处「建议」，是否真的剥离由用户点击决定 —— 绝不自动剥。
  const hint = prefixMark ? null : findLogPrefix(text);

  return {
    status: 'error',
    source: primary,
    locked,
    output: '',
    outputLang: outputLangFor(primary, opts.target),
    values: [],
    fixes: [],
    stats,
    prefixHint: hint ? { prefix: hint.prefix, body: hint.body } : undefined,
    error: lastErr
      ? { kind: lastErr.kind, line: lastErr.line, col: lastErr.col, message: lastErr.message }
      : { kind: 'unexpected_char', line: 1, col: 0, message: '第 1 行第 0 列：解析失败' },
  };
}

function buildResult(
  ir: JVal,
  marks: Mark[],
  values: ValueSlot[],
  fmt: SourceFormat,
  locked: boolean,
  opts: ConvertOptions,
  stats: { lines: number; chars: number },
  fixed: boolean,
  fallbackFrom?: SourceFormat,
  lexMarks: Mark[] = [],
): ConvertResult {
  const fixes = dedupeFixes(marksToFixes([...lexMarks, ...marks]));
  const resolved: TargetFormat | 'auto' = opts.target === 'same' ? sameTarget(fmt) : (opts.target ?? 'auto');
  const outLang = outputLangFor(fmt, resolved);
  const output = serialize(ir, outLang, opts);
  // 修正记录可能来自 lexer 层（如注释剥离），故以 fixes 是否为空为准，而非「走了第几层」
  const status: ConvertStatus = fallbackFrom ? 'fallback' : fixes.length > 0 ? 'fixed' : 'ok';
  return {
    status,
    source: fmt,
    locked,
    fallbackFrom,
    output,
    outputLang: outLang,
    resolvedTarget: resolved,
    ir,
    values,
    fixes,
    duplicates: collectDuplicates(ir),
    stats,
  };
}

/** 按目标语言选择序列化器（FR-A13 修订 / FR-A17 / FR-A18 / FR-A19） */
function serialize(ir: JVal, lang: OutputLang, opts: ConvertOptions): string {
  switch (lang) {
    case 'json':
      return toJson(ir, { compact: opts.compact });
    case 'java':
      return toJavaEsc(ir, { compact: opts.compact });
    case 'python':
      return toPython(ir, { compact: opts.compact }, opts.overrides);
  }
}

export { lex, detect, toJson, toPython, toJavaEsc, ParseError, TimeoutError };
export type { JVal, SourceFormat, OutputLang, TargetFormat, ValueSlot, FixEntry, Token };
