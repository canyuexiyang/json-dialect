import type { Deadline } from '../errors.js';

/**
 * IR → Python 字面量序列化（FR-A8–A10、§7.2 引号选择算法）
 *
 * 输出必须可被 ast.literal_eval 求值（FR-A10）—— 这是交叉验证的硬标准。
 */

import type { JVal } from '../ir.js';
import { keyToString } from '../ir.js';
import { encodePythonString } from '../escape.js';

export interface SerializeOptions {
  compact?: boolean;
  deadline?: Deadline;
  preserveTypes?: boolean;
  indent?: number;
}

/** 应用手动类型覆盖（FR-C7/C8）：按路径替换值的类型 */
export type TypeOverride = Map<string, 'string' | 'number' | 'boolean' | 'null'>;

export function toPython(
  ir: JVal,
  opts: SerializeOptions = {},
): string {
  const compact = opts.compact ?? false;
  const step = opts.indent ?? 2;
  const out: string[] = [];

  function walk(node: JVal, depth: number): void {
    const n = node;
    opts.deadline?.check();
    switch (n.k) {
      case 'obj': {
        if (n.entries.length === 0) {
          out.push('{}');
          return;
        }
        out.push('{');
        if (!compact) out.push('\n');
        n.entries.forEach((e, i) => {
          if (i > 0) {
            out.push(compact ? ', ' : ',');
            if (!compact) out.push('\n');
          }
          if (!compact) out.push(' '.repeat((depth + 1) * step));
          if (opts.preserveTypes) walk(e.key, depth + 1);
          else out.push(encodePythonString(keyToString(e.key), opts.deadline));
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
        const tuple = opts.preserveTypes && n.tuple;
        if (n.items.length === 0) {
          out.push(tuple ? '()' : '[]');
          return;
        }
        out.push(tuple ? '(' : '[');
        if (!compact) out.push('\n');
        n.items.forEach((it, i) => {
          if (i > 0) {
            out.push(compact ? ', ' : ',');
            if (!compact) out.push('\n');
          }
          if (!compact) out.push(' '.repeat((depth + 1) * step));
          walk(it, depth + 1);
        });
        if (tuple && n.items.length === 1) out.push(',');
        if (!compact) {
          out.push('\n');
          out.push(' '.repeat(depth * step));
        }
        out.push(tuple ? ')' : ']');
        return;
      }
      case 'str':
        out.push(encodePythonString(n.value, opts.deadline));
        return;
      case 'num':
        out.push(n.raw); // FR-A11
        return;
      case 'bool':
        out.push(n.value ? 'True' : 'False');
        return;
      case 'null':
        out.push('None');
        return;
    }
  }

  walk(ir, 0);
  return out.join('');
}
