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
  indent?: number;
}

/** 应用手动类型覆盖（FR-C7/C8）：按路径替换值的类型 */
export type TypeOverride = Map<string, 'string' | 'number' | 'boolean' | 'null'>;

function applyOverride(node: JVal, type: string): JVal {
  switch (type) {
    case 'string':
      if (node.k === 'str') return node;
      if (node.k === 'num') return { k: 'str', value: node.raw, span: node.span };
      if (node.k === 'bool') return { k: 'str', value: node.value ? 'True' : 'False', span: node.span };
      return { k: 'str', value: '', span: node.span };
    case 'number':
      if (node.k === 'num') return node;
      if (node.k === 'str') {
        const raw = node.value.trim();
        return { k: 'num', raw: /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) ? raw : '0', span: node.span };
      }
      if (node.k === 'bool') return { k: 'num', raw: node.value ? '1' : '0', span: node.span };
      return { k: 'num', raw: '0', span: node.span };
    case 'boolean':
      if (node.k === 'bool') return node;
      if (node.k === 'num') return { k: 'bool', value: node.raw !== '0', span: node.span };
      if (node.k === 'str') return { k: 'bool', value: node.value.trim().toLowerCase() === 'true', span: node.span };
      return { k: 'bool', value: false, span: node.span };
    case 'null':
      return { k: 'null', span: node.span };
    default:
      return node;
  }
}

export function toPython(
  ir: JVal,
  opts: SerializeOptions = {},
  overrides?: TypeOverride,
): string {
  const compact = opts.compact ?? false;
  const step = opts.indent ?? 2;
  const out: string[] = [];

  function walk(node: JVal, depth: number, path: string, keySlot: string | number): void {
    // 覆盖作用在本节点上（keySlot 是自己在父容器中的段）
    let n = node;
    if (overrides && overrides.has(path)) {
      n = applyOverride(node, overrides.get(path)!);
    }
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
          out.push(encodePythonString(keyToString(e.key)));
          out.push(': ');
          walk(e.val, depth + 1, `${path}/${keyToString(e.key)}`, keyToString(e.key));
        });
        if (!compact) {
          out.push('\n');
          out.push(' '.repeat(depth * step));
        }
        out.push('}');
        return;
      }
      case 'arr': {
        if (n.items.length === 0) {
          out.push('[]');
          return;
        }
        out.push('[');
        if (!compact) out.push('\n');
        n.items.forEach((it, i) => {
          if (i > 0) {
            out.push(compact ? ', ' : ',');
            if (!compact) out.push('\n');
          }
          if (!compact) out.push(' '.repeat((depth + 1) * step));
          walk(it, depth + 1, `${path}/${i}`, i);
        });
        if (!compact) {
          out.push('\n');
          out.push(' '.repeat(depth * step));
        }
        out.push(']');
        return;
      }
      case 'str':
        out.push(encodePythonString(n.value));
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

  walk(ir, 0, '', '');
  return out.join('');
}
