/**
 * IR → 标准 JSON 序列化（FR-E1 2空格缩进 / FR-E3 压缩 / FR-A11 / FR-A7）
 *
 * 压缩只去除结构空白，绝不触碰字符串内部（FR-A14）。
 */

import type { JVal } from '../ir.js';
import { keyToString } from '../ir.js';
import { encodeJsonString } from '../escape.js';

export interface SerializeOptions {
  /** true = 压缩成一行；false = 2 空格缩进 */
  compact?: boolean;
  indent?: number;
}

export function toJson(ir: JVal, opts: SerializeOptions = {}): string {
  const compact = opts.compact ?? false;
  const step = opts.indent ?? 2;
  const out: string[] = [];

  function walk(node: JVal, depth: number): void {
    switch (node.k) {
      case 'obj': {
        if (node.entries.length === 0) {
          out.push('{}');
          return;
        }
        out.push('{');
        if (!compact) out.push('\n');
        node.entries.forEach((e, i) => {
          if (i > 0) {
            out.push(compact ? ', ' : ',');
            if (!compact) out.push('\n');
          }
          if (!compact) out.push(' '.repeat((depth + 1) * step));
          out.push(encodeJsonString(keyToString(e.key)));
          out.push(': ');
          walk(e.val, depth + 1);
        });
        if (!compact) {
          out.push('\n');
          out.push(' '.repeat(depth * step));
        }
        out.push('}');
        return;
      }
      case 'arr': {
        if (node.items.length === 0) {
          out.push('[]');
          return;
        }
        out.push('[');
        if (!compact) out.push('\n');
        node.items.forEach((it, i) => {
          if (i > 0) {
            out.push(compact ? ', ' : ',');
            if (!compact) out.push('\n');
          }
          if (!compact) out.push(' '.repeat((depth + 1) * step));
          walk(it, depth + 1);
        });
        if (!compact) {
          out.push('\n');
          out.push(' '.repeat(depth * step));
        }
        out.push(']');
        return;
      }
      case 'str':
        out.push(encodeJsonString(node.value));
        return;
      case 'num':
        out.push(node.raw); // FR-A11 原始 token 透传
        return;
      case 'bool':
        out.push(node.value ? 'true' : 'false');
        return;
      case 'null':
        out.push('null');
        return;
    }
  }

  walk(ir, 0);
  return out.join('');
}
