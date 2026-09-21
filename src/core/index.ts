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
import { marksToFixes, dedupeFixes, type FixEntry, type DuplicateInfo } from './fixLog.js';
import { Deadline, ParseError, TimeoutError } from './errors.js';
import { keyToString, type JVal } from './ir.js';
import { outputLangFor, type OutputLang, type SourceFormat } from './types.js';
import type { ValueSlot } from './parse/engine.js';

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
    outputLang: outputLangFor(source),
    values: [],
    fixes: [],
    stats,
  });

  if (text.trim() === '') {
    return emptyBase(opts.force ?? 'json', !!opts.force);
  }

  const lexed = opts.tokens ? null : lex(text);
  const tokens = opts.tokens ?? lexed!.tokens;
  const sig = significant(tokens);
  const primary: SourceFormat = opts.force ?? detect(tokens, text).format;
  const locked = !!opts.force;

  const deadline = new Deadline(Date.now() + (opts.timeoutMs ?? 3000));

  const order: SourceFormat[] = locked ? [primary] : [primary, ...fallbackOrder(primary)];
  let lastErr: ParseError | null = null;
  // 注释剥离发生在 lexer 层，其修正记录存在于完整 token 流中；
  // 成功路径需把它并入 fixLog，否则 AC-19「修正条列出剥离位置」不成立。
  const lexMarks = lexed?.marks ?? [];

  for (let oi = 0; oi < order.length; oi++) {
    const fmt = order[oi];
    const parser = PARSERS[fmt];
    // 严格层
    try {
      const r = parser(sig, { strict: true, deadline, rawText: text });
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
    }
    // 宽松层
    try {
      const r = parser(sig, { strict: false, deadline, rawText: text });
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

  // 全部失败
  return {
    status: 'error',
    source: primary,
    locked,
    output: '',
    outputLang: outputLangFor(primary),
    values: [],
    fixes: [],
    stats,
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
  const outLang = outputLangFor(fmt);
  const output =
    outLang === 'json'
      ? toJson(ir, { compact: opts.compact })
      : toPython(ir, { compact: opts.compact }, opts.overrides);
  // 修正记录可能来自 lexer 层（如注释剥离），故以 fixes 是否为空为准，而非「走了第几层」
  const status: ConvertStatus = fallbackFrom ? 'fallback' : fixes.length > 0 ? 'fixed' : 'ok';
  return {
    status,
    source: fmt,
    locked,
    fallbackFrom,
    output,
    outputLang: outLang,
    ir,
    values,
    fixes,
    duplicates: collectDuplicates(ir),
    stats,
  };
}

export { lex, detect, toJson, toPython, ParseError, TimeoutError };
export type { JVal, SourceFormat, OutputLang, ValueSlot, FixEntry, Token };
