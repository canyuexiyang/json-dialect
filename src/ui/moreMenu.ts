/**
 * 侧边栏「更多」菜单（v1.8）
 *
 * 设计约束：
 *  - 侧边栏 320–400px 放不下全部动作；把「档位 / 缩进 / 存为片段 / 对比」
 *    收进一个 224px 的浮层，核心动作（转换 / 复制 / 下载）常驻底栏；
 *  - **不复制按钮**：直接把既有按钮节点移进菜单，ID、事件监听、hidden 语义
 *    全部保持，控制器无需感知菜单存在；
 *  - 当前档位在状态行的 chip 上始终可见；chip 与「更多」图标都能打开菜单；
 *  - 只在侧边栏形态启用；标签页形态没有触发器，函数直接返回。
 *
 * 为什么移动节点而不是重建：
 *  - 测试与真机脚本直接点 #btnFormat / #btnCompact，重建会丢监听；
 *  - 控制器通过 DomRefs 持有同一个节点，移动后引用仍然有效；
 *  - hidden 由控制器按 tab 维护，菜单只需沿用 [hidden] 的 display:none。
 */

const MOVE_IDS = ['btnFormat', 'btnCompact', 'btnSnippet', 'btnCompare'] as const;

export function setupMoreMenu(): void {
  const app = document.getElementById('app');
  if (!app || !app.classList.contains('app--panel')) return;

  const trigger = document.getElementById('moreActions') as HTMLButtonElement | null;
  const chip = document.getElementById('modeChip') as HTMLButtonElement | null;
  const menu = document.getElementById('moreMenu') as HTMLElement | null;
  if (!trigger || !menu) return;

  const items = MOVE_IDS.map((id) => document.getElementById(id) as HTMLButtonElement | null).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  );
  if (items.length === 0) return;

  const label = document.createElement('div');
  label.className = 'menu__label';
  label.textContent = '更多操作';
  menu.appendChild(label);
  for (const item of items) {
    item.classList.add('menu-item');
    menu.appendChild(item);
  }

  // ARIA 在运行时设置：shell 模板里不出现 "popup" 字样，避免 v1.3 的
  // 「popup 链路已删除」源码门禁把 aria-haspopup 误判成重新引入 popup。
  trigger.setAttribute('aria-haspopup', 'menu');
  chip?.setAttribute('aria-haspopup', 'menu');

  let open = false;

  const setOpen = (next: boolean, focusFirst = false): void => {
    open = next;
    menu.hidden = !next;
    trigger.classList.toggle('is-open', next);
    trigger.setAttribute('aria-expanded', String(next));
    chip?.classList.toggle('is-open', next);
    chip?.setAttribute('aria-expanded', String(next));
    if (next && focusFirst) {
      items.find((item) => !item.hidden)?.focus();
    }
  };

  const toggle = (): void => setOpen(!open, !open);

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  chip?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });

  // 选中任一项后收起；按钮自身的 click 监听由控制器持有，先执行，再关。
  menu.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest('button');
    if (btn) window.setTimeout(() => setOpen(false), 0);
  });

  document.addEventListener('click', (event) => {
    if (!open) return;
    const target = event.target as Node;
    if (menu.contains(target) || trigger.contains(target) || chip?.contains(target)) return;
    setOpen(false);
  });

  // capture 阶段：菜单打开时 Esc 只关菜单，不能继续走到控制器的「关闭侧边栏」。
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.focus();
    },
    true,
  );
}