/**
 * 来源格式打分器（§7.1 / FR-B3）
 *
 * 硬约束（评审 C-2）：
 *  1. 打分**复用 lexer 的 Token 流**，不另写引号状态机
 *  2. 每类信号**最多计 2 次**（次数封顶），避免长文本偏置
 *  3. Java 转义信号加**结构前提**：整段被双引号包裹且内部含 \" ；存在即计一次，不累加
 *
 * 裁决：总分最高者胜；平局 → 标准 JSON（FR-B4）；
 *      Map 信号 ≥3 且 JSON 信号为 0 → 直接判 Map；
 *      无任何信号 → 标准 JSON。
 */

import type { SourceFormat } from './types.js';
import type { Token } from './lexer.js';
import { significant } from './lexer.js';

const CAP = 2; // 每类信号最多计 2 次

const PY_TRUE = new Set(['True', 'False', 'None']);
const JSON_TRUE = new Set(['true', 'false', 'null']);
const PY_TUPLE_RANGE = ['('];

interface Score {
  python: number;
  json: number;
  java: number;
  map: number;
}

export interface DetectResult {
  format: SourceFormat;
  scores: Score;
  /** 命中的信号说明（调试与测试用） */
  reasons: string[];
}

export function detect(tokens: Token[], rawText: string): DetectResult {
  const toks = significant(tokens);
  const scores: Score = { python: 0, json: 0, java: 0, map: 0 };
  const counts = { pyTrue: 0, pyQuote: 0, pyComment: 0, pyTuple: 0, mapEq: 0, jsonTrue: 0, jsonKey: 0 };
  const reasons: string[] = [];

  // 深度跟踪（用于「深度 1 处出现 = 」）
  let depth = 0;

  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx];

    if (t.type === 'punct') {
      if (t.raw === '{' || t.raw === '[') depth++;
      else if (t.raw === '}' || t.raw === ']') depth--;
      else if (t.raw === '(') {
        depth++;
        if (counts.pyTuple < CAP) {
          counts.pyTuple++;
          scores.python += 2;
          reasons.push('元组起始 (+2)');
        }
      } else if (t.raw === ')') depth--;
      else if (t.raw === '=' && depth === 1) {
        if (counts.mapEq < CAP) {
          counts.mapEq++;
          scores.map += 3;
          reasons.push('深度1处 = 分隔 (+3)');
        }
      }
      continue;
    }

    if (t.type === 'ident') {
      if (PY_TRUE.has(t.raw) && counts.pyTrue < CAP) {
        counts.pyTrue++;
        scores.python += 3;
        reasons.push(`裸字面量 ${t.raw} (+3)`);
      } else if (JSON_TRUE.has(t.raw) && counts.jsonTrue < CAP) {
        counts.jsonTrue++;
        scores.json += 3;
        reasons.push(`裸字面量 ${t.raw} (+3)`);
      }
      continue;
    }

    if (t.type === 'string') {
      // 仅当该字符串处于「键位置」或明显是单引号值时才计引号信号
      const prev = toks[idx - 1];
      const next = toks[idx + 1];
      const isValue = prev?.type === 'punct' && (prev.raw === ':' || prev.raw === '=' || prev.raw === ',' || prev.raw === '[' || prev.raw === '(');
      const isKey = next?.type === 'punct' && (next.raw === ':' || next.raw === '=');
      if (t.quote === "'" && (isKey || isValue) && counts.pyQuote < CAP) {
        counts.pyQuote++;
        scores.python += 2;
        reasons.push('单引号键或值 (+2)');
      } else if (t.quote === '"' && isKey && counts.jsonKey < CAP) {
        counts.jsonKey++;
        scores.json += 2;
        reasons.push('双引号键 (+2)');
      }
      continue;
    }
  }

  // 注释信号（取自原始 token 流，significant 已过滤，需单独统计）
  for (const t of tokens) {
    if (t.type === 'comment' && counts.pyComment < CAP) {
      counts.pyComment++;
      scores.python += 2;
      reasons.push('行内 # 注释 (+2)');
    }
  }

  // Java 转义信号（C-2 结构前提）
  // 三个条件必须同时满足，否则合法 JSON 会被误判（AC-51 反例）：
  //   ① 去空白后整段被双引号包裹
  //   ② 内部存在 \" 转义序列
  //   ③ 反转义后的内容是一个 JSON 容器（{ 或 [ 开头）
  // ③ 是关键：单独的 JSON 字符串 '"\\""' 也满足 ①②，但它是合法 JSON 标量，
  //    按 Java 转义反转义会丢值。
  const trimmed = rawText.trim();
  if (
    trimmed.length >= 2 &&
    trimmed[0] === '"' &&
    trimmed[trimmed.length - 1] === '"' &&
    trimmed.slice(1, -1).includes('\\"')
  ) {
    const inner = trimmed.slice(1, -1).replace(/\\"/g, '\"');
    if (/^\s*[{[]/.test(inner)) {
      scores.java += 4;
      reasons.push('整段包裹且含 \\" 且反转义后为 JSON 容器 (+4，不累加)');
    } else {
      reasons.push('整段包裹但反转义后非 JSON 容器 → 不计 Java 分（C-2 结构前提）');
    }
  }

  // 裁决
  let format: SourceFormat;
  const max = Math.max(scores.python, scores.json, scores.java, scores.map);

  if (max === 0) {
    format = 'json'; // 无任何信号 → 默认 JSON（FR-B4）
    reasons.push('无信号 → 默认 JSON');
  } else if (scores.map >= 3 && scores.json === 0 && scores.map === max) {
    format = 'map';
    reasons.push('Map 信号独立且 JSON 为 0 → Map');
  } else {
    // 平局 → JSON（FR-B4）
    const winners: SourceFormat[] = [];
    if (scores.python === max) winners.push('python');
    if (scores.json === max) winners.push('json');
    if (scores.java === max) winners.push('java');
    if (scores.map === max) winners.push('map');
    if (winners.length > 1) {
      // 优先非 JSON 的最高分？不 —— 规范要求平局默认 JSON
      format = winners.includes('json') ? 'json' : winners[0];
      if (format !== 'json' && !winners.includes('json')) {
        // 多个非 JSON 平局，取第一个
      }
      reasons.push(`平局 → ${format}`);
    } else {
      format = winners[0];
    }
  }

  return { format, scores, reasons };
}

/** FR-B11 回退顺序：除当前格式外依次尝试其余三种 */
export function fallbackOrder(primary: SourceFormat): SourceFormat[] {
  const all: SourceFormat[] = ['json', 'python', 'java', 'map'];
  const rest = all.filter((f) => f !== primary);
  // FR-B8：判定为 JSON 失败时，优先尝试 java 与 map
  if (primary === 'json') return ['java', 'map', 'python'];
  return rest;
}
