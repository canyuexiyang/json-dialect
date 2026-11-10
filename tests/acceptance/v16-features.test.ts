/**
 * v1.6 批次回归（N08 / N10 / N13 / N14 / N17 / E4）
 *
 * 这里只放不依赖完整控制器的单元级断言；真机 computed style、类型面板分页的
 * 真实布局、Ctrl+F 面板造型由 `npm run verify:ui` 负责。
 * 控制器集成项（N16 切 tab 关对比 / 片段来源、N12 上限）搭车在
 * `v151-regressions.test.ts` 的同一套 DOM 里。
 */

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { convert } from '../../src/core/index.js';
import { createTypePanel } from '../../src/ui/typeWidgets.js';
import { decorateSelect, bindHiddenClose, releaseSelect } from '../../src/ui/select.js';

/** 剥掉注释再断言源码，避免注释里的关键字造成假阳性 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('v1.6 / N10：严格档「任何偏差都可见」', () => {
  it('Python 严格档把 .5 规范化成 0.5 必须记入修正记录', () => {
    const r = convert("{'a': .5}", { force: 'python', strictOnly: true, target: 'json' });
    expect(r.status).not.toBe('error');
    expect((JSON.parse(r.output) as Record<string, number>).a).toBe(0.5);
    expect(r.fixes.some((f) => f.before === '.5' && f.after === '0.5')).toBe(true);
  });

  it('Python 严格档剥离注释必须记入修正记录', () => {
    const r = convert("{'a': 1} # tail", { force: 'python', strictOnly: true, target: 'json' });
    expect(r.status).not.toBe('error');
    expect(r.fixes.some((f) => f.action.includes('注释'))).toBe(true);
  });
});

describe('v1.6 / N08：类型面板真降级 + 指纹避免重建', () => {
  const text = '{' + Array.from({ length: 64 }, (_, i) => `"k${i}":${i}`).join(',') + '}';

  it('64 个值：每页 ≤20 行，带搜索 / 分页 / 口径说明', () => {
    const r = convert(text, { target: 'json' });
    expect(r.values.length).toBe(64);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createTypePanel().render(host, r, () => {});
    expect(host.querySelectorAll('.typepanel__row').length).toBeLessThanOrEqual(20);
    expect(host.querySelector('.typepanel__head')?.textContent).toContain('降级');
    expect(host.querySelector('.typepanel__search')).not.toBeNull();
    expect(host.querySelector('.typepanel__page')?.textContent).toContain('/');
    expect(host.querySelector('.typepanel__note')?.textContent).toContain('$.');
  });

  it('搜索按路径过滤，翻页换一批行', () => {
    const r = convert(text, { target: 'json' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    createTypePanel().render(host, r, () => {});
    const search = host.querySelector<HTMLInputElement>('.typepanel__search')!;
    search.value = 'k1';
    search.dispatchEvent(new Event('input'));
    const filtered = Array.from(host.querySelectorAll<HTMLElement>('.typepanel__row'));
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((row) => (row.dataset.path ?? '').includes('k1'))).toBe(true);

    const reset = host.querySelector<HTMLInputElement>('.typepanel__search')!;
    reset.value = '';
    reset.dispatchEvent(new Event('input'));
    const first = host.querySelector<HTMLElement>('.typepanel__row')?.dataset.path;
    const next = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === '下一页')!;
    next.click();
    expect(host.querySelector<HTMLElement>('.typepanel__row')?.dataset.path).not.toBe(first);
  });

  it('values 未变 / 只改覆盖时不重建 DOM（焦点与节点保持）', () => {
    const r = convert(text, { target: 'json' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = createTypePanel();
    let changes = 0;
    panel.render(host, r, () => { changes++; });
    const firstRow = host.querySelector('.typepanel__row');
    const sel = host.querySelector<HTMLSelectElement>('select.typedrop')!;

    // 同输入重复渲染：不重建
    panel.render(host, r, () => { changes++; });
    expect(host.querySelector('.typepanel__row')).toBe(firstRow);

    // 改覆盖：触发 change → onChange；再渲染仍复用节点并同步选中态
    sel.value = 'string';
    sel.dispatchEvent(new Event('change'));
    expect(changes).toBe(1);
    panel.render(host, r, () => { changes++; });
    expect(host.querySelector('.typepanel__row')).toBe(firstRow);
    expect(host.querySelector<HTMLSelectElement>('select.typedrop')?.value).toBe('string');
    expect(panel.overrides().get('/k0')).toBe('string');
  });
});

describe('v1.6 / N17：下拉资源可显式释放', () => {
  it('releaseSelect 断开 bindHiddenClose 的 MutationObserver', () => {
    const host = document.createElement('div');
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="a">A</option>';
    host.appendChild(sel);
    document.body.appendChild(host);
    const handle = decorateSelect(sel);
    bindHiddenClose(sel, handle);
    const spy = vi.spyOn(MutationObserver.prototype, 'disconnect');
    releaseSelect(sel);
    expect(spy).toHaveBeenCalled();
    handle.destroy();
  });
});

describe('v1.6 / E4 + N13 + N14：源码级契约', () => {
  it('E4：编辑器装了 search() 与 searchKeymap（白名单扩展的有意反转）', () => {
    const src = code('src/ui/editor.ts');
    expect(src).toContain('search({ top: true })');
    expect(src).toContain('...searchKeymap');
    // macOS 的 Cmd+F 被浏览器查找占用，必须补 Control-f 网页可达键位
    expect(src).toContain("key: 'Control-f'");
    expect(src).not.toContain('indentWithTab');
  });

  it('N13：深色令牌不再双写，且 CM6 底色钉回设计令牌', () => {
    const css = code('src/ui/styles.css');
    expect(css).not.toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('body.theme-dark');
    expect(css).toContain('background-color: var(--bg-inset)');
    expect(css).toContain('box-shadow: 0 -1px 0 var(--border)');
  });

  it('N14：容器纵向可滚兜底 + 菜单右边界收敛 + 空态层不再写死 top', () => {
    const css = code('src/ui/styles.css');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('top: 0;');
    expect(code('src/ui/select.ts')).toContain('maxLeft');
  });
});
