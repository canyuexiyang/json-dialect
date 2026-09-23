/**
 * 可造型下拉框（v1.2 UI 重构）
 *
 * 【为什么不用原生 select】
 * 原生 <select> 的下拉面板由浏览器绘制，无法统一造型 —— 在仪器面板
 * 视觉方向下它会是唯一一处"不像这台机器"的控件。所以这里改为
 * 「触发器按键 + 自绘浮层菜单」。
 *
 * 【必须保留的契约】（改 UI 不能改行为）
 *  1. 真实 <select> 保留在 DOM 里（视觉隐藏），因为它承载：
 *     · 既有测试：`sel.value = 'x'; sel.dispatchEvent(new Event('change'))`
 *     · 表单语义与无障碍
 *  2. 代理层把自绘菜单的选择同步回真实 select，并派发 change 事件
 *     —— 控制器只监听 change，因此完全感知不到换了壳。
 *  3. `.hidden` 语义不变：控制器用它按 tab 显示/隐藏，隐藏时菜单必须关闭。
 *  4. `value` / `options` 读取必须仍然有效（测试直接读 sel.options）。
 *
 * 装饰时机：只在真实存在 <select> 时才升级，且升级失败一律静默降级 ——
 * 宁可用回原生 select，也不能让界面不可用。
 */

const CARET = '<svg class="sel__caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';

/** 页面上已打开的下拉（同时只允许一个） */
let openInstance: SelectHandle | null = null;

export interface SelectHandle {
  /** 关闭菜单 */
  close(): void;
  /** 触发器按键（供外部读取尺寸等） */
  readonly trigger: HTMLButtonElement;
  /** 被装饰的原始 select */
  readonly native: HTMLSelectElement;
  /** 移除装饰，恢复原生 select（测试/降级用） */
  destroy(): void;
}

/**
 * 把一个原生 <select> 升级为可造型下拉。
 *
 * @param native 原始 select（必须已在 DOM 中）
 * @param tag    触发器上显示的小标签，如「来源」「目标」（可省略）
 */
export function decorateSelect(
  native: HTMLSelectElement,
  tag?: string,
  ariaLabel?: string,
): SelectHandle {
  const wrap = document.createElement('div');
  wrap.className = 'sel';

  // 标签文案优先取参数，其次取原生 aria-label，最后留空
  const tagText = tag ?? native.getAttribute('aria-label') ?? '';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sel__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (ariaLabel ?? native.getAttribute('aria-label')) {
    trigger.setAttribute('aria-label', ariaLabel ?? native.getAttribute('aria-label')!);
  }
  trigger.innerHTML =
    (tagText ? `<span class="sel__tag">${escapeHtml(tagText)}</span>` : '') +
    '<span class="sel__value"></span>' +
    CARET;

  const menu = document.createElement('ul');
  menu.className = 'sel__menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  // 真实 select 移入容器内并视觉隐藏（保留给测试与无障碍）
  native.classList.add('sel__native');
  native.tabIndex = -1;
  native.setAttribute('aria-hidden', 'true');

  const valueEl = trigger.querySelector('.sel__value') as HTMLElement;

  /** 渲染菜单项（值变化后需重绘以更新选中态） */
  function renderOptions(): void {
    menu.innerHTML = '';
    const opts = Array.from(native.options);
    for (const opt of opts) {
      const li = document.createElement('li');
      li.className = 'sel__opt';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.textContent = opt.textContent ?? opt.value;
      li.setAttribute('aria-selected', opt.value === native.value ? 'true' : 'false');
      li.addEventListener('click', () => choose(opt.value));
      menu.appendChild(li);
    }
    syncLabel();
  }

  /** 触发器上显示当前选中项的文案 */
  function syncLabel(): void {
    const cur = native.options[native.selectedIndex];
    valueEl.textContent = cur ? (cur.textContent ?? cur.value) : '';
  }

  /** 选中某项：写回原生 select + 派发 change（控制器靠它响应） */
  function choose(v: string): void {
    if (native.value !== v) {
      native.value = v;
      // 用原生事件类型，控制器与既有测试的监听方式完全不变
      native.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderOptions();
    close();
  }

  function open(): void {
    if (openInstance && openInstance !== handle) openInstance.close();
    renderOptions();
    menu.hidden = false;
    wrap.classList.add('sel--on');
    trigger.setAttribute('aria-expanded', 'true');
    openInstance = handle;
    document.addEventListener('pointerdown', onDocDown, true);
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    wrap.classList.remove('sel--on');
    trigger.setAttribute('aria-expanded', 'false');
    if (openInstance === handle) openInstance = null;
    document.removeEventListener('pointerdown', onDocDown, true);
  }

  /** 点击别处 / 按 Esc / 滚动时收起 */
  function onDocDown(e: Event): void {
    if (!wrap.contains(e.target as Node)) close();
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    if (menu.hidden) open();
    else close();
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      trigger.focus();
    }
  });

  // 原生 select 被程序化改写值（控制器：targetSelect.value = t）时同步显示
  native.addEventListener('change', syncLabel);

  // 组装：wrapper 顶替原生 select 在 DOM 中的位置
  const parent = native.parentNode;
  if (!parent) throw new Error('decorateSelect: select 必须已在 DOM 中');
  parent.insertBefore(wrap, native);
  wrap.appendChild(trigger);
  wrap.appendChild(native);
  wrap.appendChild(menu);

  renderOptions();

  const handle: SelectHandle = {
    close,
    trigger,
    native,
    destroy() {
      document.removeEventListener('pointerdown', onDocDown, true);
      native.classList.remove('sel__native');
      native.removeAttribute('aria-hidden');
      native.removeAttribute('tabindex');
      parent.insertBefore(native, wrap);
      wrap.remove();
    },
  };

  return handle;
}

/**
 * 把装饰后的下拉纳入「隐藏即收起」的联动。
 *
 * 控制器用 `sel.hidden = true` 按 tab 切换显隐（既有测试直接断言 hidden）。
 * 但 hidden 只是让它不占位，已打开的菜单会残留 —— 必须联动关闭。
 */
export function bindHiddenClose(sel: HTMLSelectElement, handle: SelectHandle): void {
  const wrap = handle.trigger.parentElement; // .sel 容器
  const sync = (): void => {
    // 控制器只认识原生 select（既有测试也直接断言 sel.hidden），
    // 所以 wrapper 的显隐必须跟着原生 select 走 —— 否则隐藏后
    // 触发器仍占位，判定条上会留下一段空白缺口。
    if (wrap && wrap.classList.contains('sel')) wrap.hidden = sel.hidden;
    if (sel.hidden) handle.close();
  };
  const obs = new MutationObserver(sync);
  obs.observe(sel, { attributes: true, attributeFilter: ['hidden'] });
  sync();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
