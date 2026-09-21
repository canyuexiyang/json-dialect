/**
 * 解析失败时的来源格式建议（FR-D10）
 *
 * 三层解析与全格式回退（FR-B11）都已失败，说明文本确实不符合任何已知格式的规范。
 * 此时仍应给用户一个可点击的出口，而不是只丢一句「解析失败」。
 *
 * 策略：复用 detect 的打分（同一份 Token 流，零额外扫描），
 * 排除当前失败的格式，按分数降序给出建议。
 */

import { lex } from './lexer.js';
import { detect } from './detect.js';
import type { SourceFormat } from './types.js';

export interface FormatSuggestion {
  format: SourceFormat;
  label: string;
  /** 命中该格式的信号说明，用于给用户解释「为什么建议你切这个」 */
  reason: string;
}

const LABEL: Record<SourceFormat, string> = {
  json: '标准 JSON',
  python: 'Python 字面量',
  java: 'Java 转义字符串',
  map: 'Map.toString()',
};

/**
 * 给出建议切换的来源格式。
 *
 * @param text   原始输入
 * @param failed 当前失败的来源格式（会被排除）
 * @param limit  最多返回几条
 */
export function suggestFormats(
  text: string,
  failed: SourceFormat,
  limit = 2,
): FormatSuggestion[] {
  if (text.trim() === '') return [];
  let scores: Record<SourceFormat, number>;
  try {
    scores = detect(lex(text).tokens, text).scores;
  } catch {
    return [];
  }
  const out: FormatSuggestion[] = [];
  const cands = (Object.keys(scores) as SourceFormat[]).filter((f) => f !== failed);
  cands.sort((a, b) => scores[b] - scores[a]);

  for (const f of cands) {
    if (scores[f] <= 0) continue;
    out.push({ format: f, label: LABEL[f], reason: `文本中检测到 ${LABEL[f]} 的特征` });
    if (out.length >= limit) break;
  }
  if (out.length > 0) return out;

  // 完全没有任何信号（例如纯乱码）时，仍要给出口 —— FR-D10 要求「提示可手动切换」，
  // 而不是让用户对着一句报错束手无策。按最可能被用户粘错的形态给出默认顺序。
  const DEFAULT_ORDER: SourceFormat[] = ['python', 'json', 'map', 'java'];
  for (const f of DEFAULT_ORDER) {
    if (f === failed) continue;
    out.push({ format: f, label: LABEL[f], reason: '未识别到明确特征，可尝试手动切换' });
    if (out.length >= limit) break;
  }
  return out;
}

/** 取最可能的一条建议（供 UI 一键切换按钮使用） */
export function topSuggestion(text: string, failed: SourceFormat): FormatSuggestion | null {
  return suggestFormats(text, failed, 1)[0] ?? null;
}

export function formatLabel(f: SourceFormat): string {
  return LABEL[f];
}
