/**
 * 日志前缀定位（FR-D13）
 *
 * 典型输入：`2024-01-01 12:00:00 INFO {"a":1}`、`ERROR com.foo.Bar - {"a":1}`。
 *
 * 【实现要点：必须复用 lexer Token 流，不要写正则】
 * 实测过纯正则方案：`ERROR com.foo.Bar - {...}` 的 logger 名会漏剥，
 * 各种前缀形态穷举不完。而 Token 流天然带 start/line/col，
 * 定位结构起始 token 即可拿到精确偏移，零额外成本。
 */

import { lex } from './lexer.js';

export interface LogPrefix {
  /** 被剥离的前缀原文 */
  prefix: string;
  /** 剥离后的主体文本 */
  body: string;
  /** 结构起始处的偏移（= prefix.length） */
  start: number;
}

/** 形如 `[2024-01-01 12:00:00]` / `[http-nio-8080-exec-3]` 的方括号段 */
const BRACKET_SEGMENT = /^\s*\[[^\]]*\]\s*/;

/**
 * 判断某个 `[` token 是「数组起点」还是「日志里的方括号段」。
 *
 * 这是唯一需要正则的地方，且只做**排除**判断、不做前缀识别：
 * 时间戳 / 线程名这类方括号段后面跟的是日期或字母串，而 JSON 数组起点
 * 后面跟的是值。判据简单可靠，不涉及穷举日志格式。
 */
function isBracketSegment(text: string, at: number): boolean {
  return BRACKET_SEGMENT.test(text.slice(at));
}

/**
 * 定位主干结构之前的前缀。
 *
 * 返回 null 的三种情况：找不到结构起始 token / 它就在最开头（无前缀）/ 前缀全是空白。
 * 是否真的提供「一键剥离」入口由调用方决定（还需验证剥离后能解析成功）。
 */
export function findLogPrefix(text: string): LogPrefix | null {
  const { tokens } = lex(text);
  let start = -1;
  for (const t of tokens) {
    if (t.type !== 'punct') continue;
    if (t.raw === '{') {
      start = t.start;
      break;
    }
    if (t.raw === '[' && !isBracketSegment(text, t.start)) {
      start = t.start;
      break;
    }
  }
  if (start <= 0 || start >= text.length) return null;
  const prefix = text.slice(0, start);
  if (prefix.trim() === '') return null;
  return { prefix, body: text.slice(start), start };
}
