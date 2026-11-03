/**
 * 转义 tab 内核（FR-I1～I7）
 *
 * 【架构定位：纯字符串通道，不经过 IR】
 * 转换/格式化是 IR → 文本（结构化），转义是文本 → 文本（非结构化）。
 * 它**不得**尝试解析输入结构，也**不得**被塞进 convert()。
 *
 * 【FR-I4 实测硬约束】
 * 原生 btoa('中文') 抛 InvalidCharacterError —— btoa 只接受 Latin-1。
 * 必须走 TextEncoder → btoa（编码）与 atob → TextDecoder（解码）。
 * 实测：'中文' → '5Lit5paH'，可逆。
 *
 * 【FR-I5 方向语义】
 * 方向是**一等操作**，必须由用户显式选择，不得藏进按钮的隐式翻转。
 */

import { decodeStringBody, encodeJsonContent } from './escape.js';

export type EscapeStyle = 'json' | 'java' | 'url' | 'base64';
export type EscapeDir = 'encode' | 'decode';

/**
 * v1.5 / D3：JSON 与 Java 的字符串转义表在数据层完全等价（实测双向逐字符相同）。
 * 原先下拉里并列两个选项，让用户以为 8 格矩阵有 8 种行为，实际只有 3 种。
 * 现把两者合并为「JSON / Java 字符串」一个可见风格；`java` 仅作为兼容别名保留
 * （老 prefs / 程序化调用 / 既有测试仍可用），不再单列入口。
 *
 * 与转换 tab 的语义冲突由「包裹外层引号」开关解决：转义 tab 默认只转义内容，
 * 勾上开关才产出带引号的完整字符串常量（等价于 toJavaEsc 的外壳）。
 */
export const ESCAPE_LABEL: Record<EscapeStyle, string> = {
  json: 'JSON / Java 字符串',
  java: 'JSON / Java 字符串（兼容别名）',
  url: 'URL 百分号',
  base64: 'Base64',
};

/** FR-I5：方向文案。encode = 增加转义，decode = 去除转义 */
export const ESCAPE_DIR_LABEL: Record<EscapeDir, string> = {
  encode: '增加转义',
  decode: '去除转义',
};

export const ALL_ESCAPE_STYLES: EscapeStyle[] = ['json', 'java', 'url', 'base64'];

/** 界面实际展示的风格（D3：java 是兼容别名，不单列） */
export const VISIBLE_ESCAPE_STYLES: EscapeStyle[] = ['json', 'url', 'base64'];

export const ALL_ESCAPE_DIRS: EscapeDir[] = ['encode', 'decode'];

/** 取反方向（用于底部「反向」按钮） */
export function oppositeDir(dir: EscapeDir): EscapeDir {
  return dir === 'encode' ? 'decode' : 'encode';
}

// ── Base64（UTF-8 安全） ────────────────────────────────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i++) B64_INDEX[B64_CHARS[i]] = i;

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Base64 编码。
 * 优先用浏览器原生 API（TextEncoder + btoa），无 btoa 的环境（Node 测试）退化到手写实现。
 */
export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const g = globalThis as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return g.btoa(bin);
  }
  return base64EncodeBytes(bytes);
}

/** Base64 解码。非法输入抛 Error（FR-I3：不得返回部分结果） */
export function base64Decode(text: string): string {
  const s = text.replace(/\s+/g, '');
  if (s === '') return '';
  if (s.length % 4 !== 0 || !B64_RE.test(s)) {
    throw new Error('不是合法的 Base64 字符串（长度须为 4 的倍数，且只含 A-Z a-z 0-9 + / =）');
  }
  const bytes = base64DecodeBytes(s);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Base64 解码结果不是合法的 UTF-8 字节序列');
  }
}

function base64EncodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 63];
  }
  return out;
}

function base64DecodeBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_INDEX[clean[i]];
    const c1 = B64_INDEX[clean[i + 1] ?? ''];
    const c2 = B64_INDEX[clean[i + 2] ?? ''];
    const c3 = B64_INDEX[clean[i + 3] ?? ''];
    if (c0 === undefined || c1 === undefined) throw new Error('Base64 含非法字符');
    if (p < len) out[p++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined && p < len) out[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 !== undefined && p < len) out[p++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

// ── 各风格编解码 ────────────────────────────────────────────────────────

/**
 * Java 字符串编码（v1.5 / D3：显式声明为 JSON 的别名）。
 * Java 与 JSON 的字符串转义表在数据层逐字符等价（\n \t \" \\ \uXXXX 均一致；
 * 唯一差异 \/ 是 JSON 专有且本实现不用），所以两个风格共用同一实现。
 */
function javaEncode(s: string): string {
  return encodeJsonContent(s);
}

function javaDecode(s: string): string {
  return decodeStringBody(s, 'java');
}

/**
 * URL 百分号编码（component 语义）。
 * encodeURIComponent 不转义 ! ' ( ) * ，这里按 RFC 3986 补齐，保证往返一致。
 */
function urlEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function urlDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new Error('不是合法的 URL 百分号编码（% 后须跟两位十六进制）');
  }
}

/**
 * 执行转义 / 反转义。
 * 失败一律抛 Error（FR-I3）—— 由调用方转成报错提示，绝不返回部分结果或空串。
 */
export function applyEscape(text: string, style: EscapeStyle, dir: EscapeDir): string {
  if (dir === 'encode') {
    switch (style) {
      case 'json':
        return encodeJsonContent(text);
      case 'java':
        return javaEncode(text);
      case 'url':
        return urlEncode(text);
      case 'base64':
        return base64Encode(text);
    }
  }
  switch (style) {
    case 'json':
    case 'java':
      return javaDecode(text);
    case 'url':
      return urlDecode(text);
    case 'base64':
      return base64Decode(text);
  }
}

export interface EscapeResult {
  ok: boolean;
  output: string;
  error?: string;
  /** FR-I6：额外说明（如「已去除外层引号」），供状态条显示，让操作可追溯 */
  note?: string;
}

export interface EscapeOptions {
  /**
   * v1.5 / D3：encode 时给结果包裹一对双引号，产出可直接贴进代码的
   * 完整字符串常量 —— 与转换 tab 的「Java 转义字符串」输出（带外壳）语义对齐。
   * decode 方向不需要它：剥壳由 FR-I6 自动完成。
   */
  wrapQuotes?: boolean;
}

// ── 外层引号剥离（FR-I6） ──────────────────────────────────────────────

/**
 * 判断一对引号是否真的包住整段文本。
 *
 * 用「扫描一遍确认中间的引号都被反斜杠转义」来代替简单首尾比较 ——
 * 否则 `a" + "b` 这类输入会被误判成带外层引号。
 */
function isWrappedByQuotes(text: string, quote: string): boolean {
  if (text.length < 2) return false;
  if (!text.startsWith(quote) || !text.endsWith(quote)) return false;
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++; // 跳过被转义的字符
      continue;
    }
    if (ch === quote) return false; // 中间出现未转义的同种引号 → 不是外层包裹
  }
  return true;
}

/**
 * 剥离一对配对的外层引号（FR-I6）。
 *
 * 【为什么只在「去除转义」时做】
 * 从 Java / JSON 代码里复制出来的字符串常量**自带外层引号**，
 * 如 `"{\"a\":1}"`。直接反转义会得到 `"{"a":1}"` —— 外层引号残留，
 * 用户还得手删。这不是"解析结构"（FR-I1 禁止的），只是把「常量外壳」脱掉。
 *
 * 【为什么四种风格都做，且不会破坏数据】
 * url 编码后 `"` 变成 `%22`、base64 字母表根本不含 `"` ——
 * 这两种风格的输出里**不可能**出现裸引号。所以只要输入首尾是同种引号、
 * 且中间没有未转义的同种引号，那对引号就一定是复制带来的外壳，不是内容。
 * 实测：`"5Lit5paH"` 剥壳后可正常解码（不剥会直接报错，逼用户手删）。
 *
 * 【安全性】只在确认首尾配对、且中间无未转义的同种引号时才剥，
 * 剥了必须记进 note，让用户看得见。
 */
export function stripOuterQuotes(
  text: string,
  style: EscapeStyle,
): { text: string; stripped: boolean } {
  void style; // 四种风格判据一致，参数保留以便调用方写明意图
  const t = text.trim();
  if (isWrappedByQuotes(t, '"') || isWrappedByQuotes(t, "'")) {
    return { text: t.slice(1, -1), stripped: true };
  }
  return { text, stripped: false };
}

/** 不抛异常的版本，供 UI 直接消费 */
export function escapeText(
  text: string,
  style: EscapeStyle,
  dir: EscapeDir,
  opts: EscapeOptions = {},
): EscapeResult {
  let stripped = false;
  let note: string | undefined;
  try {
    // FR-I6：仅「去除转义」时脱掉常量外壳（复制自代码的字符串自带外层引号）
    let working = text;
    if (dir === 'decode') {
      const s = stripOuterQuotes(text, style);
      if (s.stripped) {
        working = s.text;
        stripped = true;
        note = '已自动去除外层引号';
      }
    }
    let output = applyEscape(working, style, dir);
    // v1.5 / D3：encode + wrapQuotes → 带外壳的完整字符串常量
    if (dir === 'encode' && opts.wrapQuotes) {
      output = '"' + output + '"';
      note = note ? `${note}；已包裹外层引号` : '已包裹外层引号';
    }
    return { ok: true, output, note };
  } catch (e) {
    const base = e instanceof Error ? e.message : String(e);
    // v1.5 / D21：剥壳后失败必须说明因果，否则用户对照原文看不出
    // 错误来自「剥掉引号之后的那段」而不是原始输入。
    return {
      ok: false,
      output: '',
      error: stripped ? `已尝试剥离外层引号后仍失败：${base}` : base,
    };
  }
}
