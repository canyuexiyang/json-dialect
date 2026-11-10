import type { JVal } from './ir.js';
import type { OutputLang } from './types.js';
import type { ValueSlot } from './parse/engine.js';
import type { TypeOverride } from './serialize/toPython.js';
import { normalizeNumber } from './escape.js';
import { ParseError, type Deadline } from './errors.js';

/** 覆盖绑定解析得到的节点，所有目标格式共用；原始 IR 与原始值保持不变。 */
export function applyOverrides(
  ir: JVal,
  values: ValueSlot[],
  overrides?: TypeOverride,
  deadline?: Deadline,
  outLang: OutputLang = 'json',
): JVal {
  if (!overrides?.size) return ir;
  const replacements = new Map<JVal, JVal>();
  for (const slot of values) {
    deadline?.check();
    const type = overrides.get(slot.path);
    if (!type) continue;
    const span = slot.node.span;
    let replacement: JVal;
    switch (type) {
      case 'string': {
        // v1.5.1 / N06：bool/null 原先没有 raw（空串），强制转字符串会静默丢数据。
        // 现在按节点语义生成，并随目标语言切换 True/False/None ↔ true/false/null；
        // num/str 仍用 slot.raw 保留原始文本 —— Map 的前导零「0012」不能丢（AC 回归）。
        const py = outLang === 'python';
        let text: string;
        if (slot.node.k === 'bool') {
          text = py ? (slot.node.value ? 'True' : 'False') : (slot.node.value ? 'true' : 'false');
        } else if (slot.node.k === 'null') {
          text = py ? 'None' : 'null';
        } else {
          text = slot.raw;
        }
        replacement = { k: 'str', value: text, span };
        break;
      }
      case 'number':
        try {
          replacement = { k: 'num', raw: slot.node.k === 'bool' ? slot.node.value ? '1' : '0' : normalizeNumber(slot.raw.trim()), span };
        } catch {
          throw new ParseError('bad_value', span.line, span.col, `${slot.path} 不能转换为数字`);
        }
        break;
      case 'boolean': {
        // v1.5.1 / N06：已经是布尔值就原样保留，否则「保持原类型」也会报错。
        if (slot.node.k === 'bool') { replacement = slot.node; break; }
        const raw = slot.raw.trim().toLowerCase();
        if (slot.node.k === 'num') replacement = { k: 'bool', value: !/^-?0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(slot.node.raw), span };
        else if (raw === 'true' || raw === 'false') replacement = { k: 'bool', value: raw === 'true', span };
        else throw new ParseError('bad_value', span.line, span.col, `${slot.path} 不能转换为布尔值`);
        break;
      }
      case 'null':
        replacement = { k: 'null', span };
        break;
    }
    replacements.set(slot.node, replacement);
  }
  function walk(node: JVal): JVal {
    deadline?.check();
    const replacement = replacements.get(node);
    if (replacement) return replacement;
    if (node.k === 'obj') return { ...node, entries: node.entries.map((entry) => ({ ...entry, val: walk(entry.val) })) };
    if (node.k === 'arr') return { ...node, items: node.items.map(walk) };
    return node;
  }
  return walk(ir);
}
