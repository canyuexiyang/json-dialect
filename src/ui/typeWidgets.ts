/**
 * 类型下拉浮层（评审 D-2 / FR-C6 / FR-C11）
 *
 * 下拉是独立的行内 DOM 浮层，绝不注入只读编辑器内容 —— 这是 AC-39 的前提：
 * 复制/下载取 IR 序列化结果，界面控件不可能污染输出。
 *
 * FR-C11：值数量 > 50 时降级为「类型调整面板」列表。
 *
 * v1.6 / N08：把「降级」真正落地 —— 路径搜索 + 每页最多 20 行，
 *  并用 values 指纹避免每次 run() 全量重建 DOM（覆盖变更只同步选中态，
 *  焦点不丢；万级值文档不再每次输入重建数万节点）。
 * v1.6 / N17：重建前释放旧下拉的 MutationObserver / 全局打开态。
 * v1.6 / N18：明示面板路径是内部编号，与路径条的 $.… 口径区分。
 */

import type { ConvertResult, ValueSlot } from '../core/index.js';
import { closeOpenSelect, decorateSelect, releaseSelect } from './select.js';

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
  retain(paths: Set<string>): void;
}

const TYPE_LABEL: Record<string, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔',
  null: 'null',
};

const PANEL_THRESHOLD = 50; // FR-C11
const PAGE_SIZE = 20;       // v1.6 / N08

/** 原生 select 值被改写后，同步自绘触发器的文案（不派发 change，避免回环） */
function syncSelectVisual(sel: HTMLSelectElement): void {
  const valueEl = sel.parentElement?.querySelector<HTMLElement>('.sel__value');
  if (valueEl) valueEl.textContent = sel.options[sel.selectedIndex]?.textContent ?? '';
}

export function createTypePanel(): TypePanelHandle {
  const map = new Map<string, OverrideType>();
  let fingerprint = '';
  let page = 0;
  let query = '';
  let last: { host: HTMLElement; r: ConvertResult; onChange: () => void } | null = null;

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
      // v1.6 / N08：DOM 不再随覆盖变化重建，先就地同步触发器文案
      syncSelectVisual(sel);
      onChange();
      sel.parentElement?.querySelector<HTMLButtonElement>('.sel__trigger')?.focus();
    });
    return sel;
  }

  /** 指纹只由 values 内容与分页/搜索状态构成；覆盖值变化不触发重建 */
  function signature(slots: ValueSlot[], shown: number): string {
    return [
      slots.length,
      shown,
      slots.map((s) => `${s.path}\u0001${s.inferred}\u0001${s.raw}`).join('\u0002'),
      query,
      page,
    ].join('\u0003');
  }

  function releaseOld(host: HTMLElement): void {
    closeOpenSelect();
    for (const sel of Array.from(host.querySelectorAll<HTMLSelectElement>('select.typedrop'))) {
      releaseSelect(sel);
    }
  }

  function render(host: HTMLElement, r: ConvertResult, onChange: () => void): void {
    last = { host, r, onChange };
    const slots = r.values ?? [];
    if (slots.length === 0) {
      releaseOld(host);
      host.innerHTML = '';
      host.hidden = true;
      fingerprint = '';
      return;
    }
    host.hidden = false;

    const q = query.trim().toLowerCase();
    const shown = q ? slots.filter((s) => s.path.toLowerCase().includes(q)) : slots;
    const degraded = slots.length > PANEL_THRESHOLD;
    const pages = degraded ? Math.max(1, Math.ceil(shown.length / PAGE_SIZE)) : 1;
    page = Math.min(Math.max(0, page), pages - 1);
    const sig = signature(slots, shown.length);

    // v1.6 / N08：输入没变 / 只改了覆盖 → 不重建 DOM，只同步选中态
    if (sig === fingerprint && host.childElementCount > 0) {
      for (const sel of Array.from(host.querySelectorAll<HTMLSelectElement>('select.typedrop'))) {
        const path = sel.closest<HTMLElement>('.typepanel__row')?.dataset.path ?? '';
        const want = map.get(path) ?? 'infer';
        if (sel.value !== want) {
          sel.value = want;
          syncSelectVisual(sel);
        }
      }
      return;
    }

    fingerprint = sig;
    releaseOld(host);
    host.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'typepanel__head';
    head.textContent = degraded
      ? `类型调整面板（${slots.length} 个值 · 已降级为搜索 + 分页）`
      : `类型调整（${slots.length} 个值）`;
    host.appendChild(head);

    const note = document.createElement('div');
    note.className = 'typepanel__note';
    note.textContent = '面板路径为内部编号；路径条使用 $.a[0].b 口径。';
    host.appendChild(note);

    if (degraded) {
      const tools = document.createElement('div');
      tools.className = 'typepanel__tools';
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'typepanel__search';
      search.placeholder = '按路径筛选';
      search.value = query;
      search.setAttribute('aria-label', '按路径筛选值');
      const rerender = (): void => {
        if (last) render(last.host, last.r, last.onChange);
        host.querySelector<HTMLInputElement>('.typepanel__search')?.focus();
      };
      search.addEventListener('input', () => {
        query = search.value;
        page = 0;
        fingerprint = '';
        rerender();
        const next = host.querySelector<HTMLInputElement>('.typepanel__search');
        next?.setSelectionRange(next.value.length, next.value.length);
      });
      tools.appendChild(search);
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'btn btn--ghost';
      prev.textContent = '上一页';
      prev.disabled = page === 0;
      prev.addEventListener('click', () => {
        page = Math.max(0, page - 1);
        fingerprint = '';
        rerender();
      });
      tools.appendChild(prev);
      const pageInfo = document.createElement('span');
      pageInfo.className = 'typepanel__page';
      pageInfo.textContent = `${page + 1}/${pages}`;
      tools.appendChild(pageInfo);
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'btn btn--ghost';
      next.textContent = '下一页';
      next.disabled = page >= pages - 1;
      next.addEventListener('click', () => {
        page = Math.min(pages - 1, page + 1);
        fingerprint = '';
        rerender();
      });
      tools.appendChild(next);
      host.appendChild(tools);
    }

    const list = document.createElement('div');
    list.className = 'typepanel__list';
    const start = page * PAGE_SIZE;
    const pageSlots = degraded ? shown.slice(start, start + PAGE_SIZE) : shown;
    for (const slot of pageSlots) {
      const row = document.createElement('div');
      row.className = 'typepanel__row';
      row.dataset.path = slot.path;
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
      onChange();
    });
    host.appendChild(clear);
  }

  return {
    overrides: () => map,
    setOverride(path, t) {
      map.set(path, t);
    },
    render,
    clear() {
      map.clear();
    },
    retain(paths) {
      for (const path of map.keys()) if (!paths.has(path)) map.delete(path);
    },
  };
}
