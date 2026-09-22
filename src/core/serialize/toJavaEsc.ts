/**
 * IR → Java 转义字符串（FR-A18 / US-17）
 *
 * 语义：先按标准 JSON 序列化，再把整段结果做一次 JSON 字符串编码，
 * 产出的文本可直接贴进 Java 源码的字符串常量里。
 *
 * 例：{"msg":"he said \"hi\""}
 *  → toJson：{"msg": "he said \"hi\""}
 *  → 二次编码："{\"msg\": \"he said \\\"hi\\\"\"}"
 */

import type { JVal } from '../ir.js';
import { toJson } from './toJson.js';
import { encodeJsonString } from '../escape.js';

export function toJavaEsc(ir: JVal, opts: { compact?: boolean } = {}): string {
  return encodeJsonString(toJson(ir, opts));
}
