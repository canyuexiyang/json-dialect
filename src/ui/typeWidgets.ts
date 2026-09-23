/**
 * 类型下拉浮层（评审 D-2 / FR-C6 / FR-C11）
 *
 * 下拉是独立的行内 DOM 浮层，绝不注入只读编辑器内容 —— 这是 AC-39 的前提：
 * 复制/下载取 IR 序列化结果，界面控件不可能污染输出。
 *
 * FR-C11：值数量 > 50 时降级为「类型调整面板」列表。
 */

import type { ConvertResult } from '../core/index.js';
import type { ValueSlot } from '../core/index.js';
import { decorateSelect } from './select.js';

export type OverrideType = 'string' | 'number' | 'boolean' | 'null';

/** SessionState 里的 override 是 string，需收窄 */
export function isOverrideType(v: string): v is OverrideType {
  return v === 'string' || v === 'number' || v === 'boolean' || v === 'null';
}

export interface TypePanelHandle {
  overrides(): Map<string, OverrideType>;
  /** 按路径写入覆盖（放大页继承 AC-33 时使用） */
  setOverride(path: string, t: OverrideType): void;
  render(host: HTMLElement, r: ConvertResult, onChange: () => void): void;
  clear(): void;
}

const TYPE_LABEL: Record<string, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔',
  null: 'null',
};

const PANEL_THRESHOLD = 50; // FR-C11

export function createTypePanel(): TypePanelHandle {
  const map = new Map<string, OverrideType>();

  function choose(slot: ValueSlot, onChange: () => void): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'typedrop';
    const infer = document.createElement('option');
    infer.value = 'infer';
    infer.textContent = `推断（${TYPE_LABEL[slot.inferred]}）`;
    sel.appendChild(infer);
    for (const t of ['string', 'number', 'boolean', 'null']) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = TYPE_LABEL[t];
      sel.appendChild(o);
    }
    const cur = map.get(slot.path);
    sel.value = cur ?? 'infer';
    sel.addEventListener('change', () => {
      if (sel.value === 'infer') map.delete(slot.path);
      else map.set(slot.path, sel.value as OverrideType);
      onChange();
    });
    return sel;
  }

  return {
    overrides: () => map,
    setOverride(path, t) {
      map.set(path, t);
    },
    render(host, r, onChange) {
      host.innerHTML = '';
      const slots = r.values ?? [];
      if (slots.length === 0) {
        host.hidden = true;
        return;
      }
      host.hidden = false;

      const head = document.createElement('div');
      head.className = 'typepanel__head';
      head.textContent =
        slots.length > PANEL_THRESHOLD
          ? `类型调整面板（${slots.length} 个值，已降级为列表）`
          : `类型调整（${slots.length} 个值）`;
      host.appendChild(head);

      const list = document.createElement('div');
      list.className = 'typepanel__list';
      for (const slot of slots) {
        const row = document.createElement('div');
        row.className = 'typepanel__row';
        const path = document.createElement('span');
        path.className = 'typepanel__path';
        path.textContent = slot.path || '(根)';
        row.appendChild(path);
        row.appendChild(choose(slot, onChange));
        list.appendChild(row);
      }
      host.appendChild(list);

      // v1.2：把面板内的原生 select 升级为可造型下拉。
      // 必须在 row 已入 DOM 之后（decorateSelect 需要 parentNode），
      // 且失败静默降级 —— 原生 select 本身功能完整。
      for (const sel of Array.from(list.querySelectorAll('select.typedrop'))) {
        try {
          decorateSelect(sel as HTMLSelectElement);
        } catch {
          /* 静默降级 */
        }
      }

      const clear = document.createElement('button');
      clear.className = 'btn btn--ghost';
      clear.textContent = '清除覆盖';
      clear.addEventListener('click', () => {
        map.clear();
        host.innerHTML = '';
        onChange();
      });
      host.appendChild(clear);
    },
    clear() {
      map.clear();
    },
  };
}
