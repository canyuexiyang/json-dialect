/**
 * 字符串转义 / 反转义工具（纯函数，零浏览器 API）
 *
 * 对应需求：
 *  - FR-A7  非 ASCII（含中文）原样输出，不转 \uXXXX
 *  - FR-A12 控制字符按目标语言转义，且不破坏字符串边界
 *  - FR-A9  §7.2 Python 侧引号选择算法
 *  - §7.7   转义对照表
 */

const JSON_SIMPLE: Record<string, string> = {
  '\"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

const PY_SIMPLE: Record<string, string> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** 控制字符 U+0000-U+001F + U+2028/U+2029 */
const CTRL_RE = /[\u0000-\u001F\u2028\u2029]/;

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

/** 标准 JSON 字符串内容编码（不含外层引号） */
export function encodeJsonContent(s: string): string {
  let out = '';
  for (const ch of s) {
    const simple = JSON_SIMPLE[ch];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x2028 || c === 0x2029) {
      out += '\\u' + hex(c, 4);
      continue;
    }
    out += ch; // FR-A7：中文等 CJK 原样输出
  }
  return out;
}

/**
 * §7.2 Python 侧引号选择算法
 * 优先级：含控制字符 → 双引号；否则按 单/双引号 出现情况选择。
 */
export function pickPythonQuote(s: string): "\"" | '\'' {
  if (CTRL_RE.test(s)) return "\"";
  const hasSingle = s.includes('\'');
  const hasDouble = s.includes("\"");
  if (!hasSingle && !hasDouble) return '\'';
  if (hasSingle && !hasDouble) return "\""; // AC-13
  if (hasDouble && !hasSingle) return '\''; // AC-14
  return '\'';
}

/** Python 字面量字符串内容编码（不含外层引号） */
export function encodePythonContent(s: string, quote: "\"" | '\''): string {
  let out = '';
  for (const ch of s) {
    if (ch === quote) {
      out += '\\' + quote;
      continue;
    }
    const simple = PY_SIMPLE[ch];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const c = ch.codePointAt(0)!;
    if (c < 0x20) {
      out += '\\x' + hex(c, 2);
      continue;
    }
    if (c === 0x2028 || c === 0x2029) {
      out += '\\u' + hex(c, 4);
      continue;
    }
    out += ch;
  }
  return out;
}

/** 带引号的完整 Python 字符串字面量 */
export function encodePythonString(s: string): string {
  const q = pickPythonQuote(s);
  return q + encodePythonContent(s, q) + q;
}

/** 带引号的完整 JSON 字符串 */
export function encodeJsonString(s: string): string {
  return "\"" + encodeJsonContent(s) + "\"";
}

const HEX2 = /^[0-9a-fA-F]{2}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * 反转义字符串 body（不含外层引号）。
 * 宽松策略：无法识别的转义序列保留原字符（容错优先，FR-D 总则）。
 */
export function decodeStringBody(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const n = body[i + 1];
    i += 2;
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '0':
        out += '\u0000';
        break;
      case 'a':
        out += '\u0007';
        break;
      case 'v':
        out += '\u000b';
        break;
      case '\\':
        out += '\\';
        break;
      case '\'':
        out += '\'';
        break;
      case '\"':
        out += "\"";
        break;
      case '/':
        out += '/';
        break;
      case 'x': {
        const h = body.slice(i, i + 2);
        if (HEX2.test(h)) {
          out += String.fromCharCode(parseInt(h, 16));
          i += 2;
        } else {
          out += 'x';
        }
        break;
      }
      case 'u': {
        const h = body.slice(i, i + 4);
        if (HEX4.test(h)) {
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else {
          out += 'u';
        }
        break;
      }
      case undefined:
        out += '\\';
        break;
      default:
        out += n;
        break;
    }
  }
  return out;
}

/**
 * FR-A11：数字全程以原始 token 透传，不做 Number() 转换。
 * 唯一例外：整数字面量的前导零在 JSON 与 Python 3 中都是非法的
 * （Python 3 会直接 SyntaxError，JSON 规范禁止 012），
 * 因此仅在「会产出非法字面量」时剥离前导零 —— 纯文本操作，不涉及数值精度。
 */
export function stripLeadingZeros(raw: string): string {
  const m = /^([+-]?)(0+)(\d+)(.*)$/.exec(raw);
  if (!m) return raw;
  return m[1] + m[3] + m[4];
}
