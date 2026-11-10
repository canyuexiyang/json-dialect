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
let nextSelectId = 0;
/** v1.6 / N17：bindHiddenClose 建的观察器需要能被重建方显式断开 */
const observers = new WeakMap<HTMLSelectElement, MutationObserver>();

/**
 * v1.6 / N17：释放一个下拉的全局资源。
 * 类型面板每次转换都会 `innerHTML = ''` 重建，旧 MutationObserver 会一直
 * 持有被移除的 select；长会话下只增不减。重建前必须调用本函数。
 */
export function releaseSelect(native: HTMLSelectElement): void {
  const obs = observers.get(native);
  if (obs) {
    obs.disconnect();
    observers.delete(native);
  }
  if (openInstance?.native === native) {
    openInstance.close();
    openInstance = null;
  }
}

/** v1.5：关闭当前打开的下拉（全局 Esc 兜底用）。返回是否确实关了一个。 */
export function closeOpenSelect(): boolean {
  if (!openInstance) return false;
  openInstance.close();
  return true;
}

export interface SelectHandle {
  /** 关闭菜单 */
  close(): void;
  sync(): void;
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

  const selectId = ++nextSelectId;
  const menu = document.createElement('ul');
  menu.id = `select-menu-${selectId}`;
  trigger.setAttribute('aria-controls', menu.id);
  menu.className = 'sel__menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  // 真实 select 移入容器内并视觉隐藏（保留给测试与无障碍）
  native.classList.add('sel__native');
  native.tabIndex = -1;
  native.setAttribute('aria-hidden', 'true');

  const valueEl = trigger.querySelector('.sel__value') as HTMLElement;

  /** 渲染菜单项（值变化后需重绘以更新选中态） */
  let active = 0;

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
      li.id = `select-option-${selectId}-${menu.children.length}`;
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
    active = Math.max(0, native.selectedIndex);
    menu.hidden = false;
    // v1.5 / D10：菜单用 fixed 定位锚到视口，脱离了 .typepanel 等祖先的
    // overflow:auto / max-height 裁剪。祖先若无 transform，fixed 不受其影响。
    // jsdom / 布局未就绪时 rect 全 0 —— 保持 CSS 默认定位，功能不受影响。
    try {
      const r = trigger.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        menu.style.position = 'fixed';
        menu.style.top = `${Math.round(r.bottom + 4)}px`;
        menu.style.minWidth = `${Math.round(r.width)}px`;
        // 向下放不下（类型面板靠近视口底部）就向上翻
        const vh = window.innerHeight || 0;
        const vw = window.innerWidth || 0;
        const mh = menu.offsetHeight || 0;
        // v1.6 / N14：320px 侧边栏里靠右的触发器会把菜单推出视口右边界
        const mw = menu.offsetWidth || Math.round(r.width);
        const maxLeft = Math.max(0, vw - mw - 4);
        menu.style.left = `${Math.min(Math.max(0, Math.round(r.left)), maxLeft)}px`;
        if (vh > 0 && mh > 0 && r.bottom + 4 + mh > vh && r.top - 4 - mh >= 0) {
          menu.style.top = `${Math.round(r.top - mh - 4)}px`;
        }
      }
    } catch {
      /* 布局未就绪：静默退回默认定位 */
    }
    highlightOption();
    wrap.classList.add('sel--on');
    trigger.setAttribute('aria-expanded', 'true');
    openInstance = handle;
    document.addEventListener('pointerdown', onDocDown, true);
    // fixed 定位不随滚动 —— 视口一滚就与触发器错位，干脆收起（捕获阶段，
    // 捕获任何祖先容器滚动，typepanel 内部滚动同样触发）
    document.addEventListener('scroll', onScrollClose, true);
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    // 清掉 open() 写的视口定位内联样式，回到 CSS 默认（absolute）
    menu.style.removeProperty('position');
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
    menu.style.removeProperty('min-width');
    wrap.classList.remove('sel--on');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    if (openInstance === handle) openInstance = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('scroll', onScrollClose, true);
  }

  /** 点击别处 / 按 Esc / 滚动时收起 */
  function onDocDown(e: Event): void {
    if (!wrap.contains(e.target as Node)) close();
  }

  function onScrollClose(): void {
    close();
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    if (menu.hidden) open();
    else close();
  });

  function highlightOption(): void {
    const options = Array.from(menu.children) as HTMLElement[];
    options.forEach((option, index) => option.classList.toggle('sel__opt--active', index === active));
    const option = options[active];
    if (option) trigger.setAttribute('aria-activedescendant', option.id);
  }

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      close();
      if (e.key === 'Escape') { e.preventDefault(); trigger.focus(); }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') {
      if (menu.hidden) open();
      else { choose(native.options[active].value); trigger.focus(); }
      return;
    }
    if (menu.hidden) open();
    if (e.key === 'ArrowDown') active = (active + 1) % native.options.length;
    if (e.key === 'ArrowUp') active = (active - 1 + native.options.length) % native.options.length;
    if (e.key === 'Home') active = 0;
    if (e.key === 'End') active = native.options.length - 1;
    highlightOption();
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
    sync: syncLabel,
    trigger,
    native,
    destroy() {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('scroll', onScrollClose, true);
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
  observers.set(sel, obs);
  sync();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
