/**
 * v1.7.2 维护批次回归（FR-U9 / AC-163）
 *
 * 切 tab 后浏览器把焦点留在 tab 按钮上，CM6 的 searchKeymap 只在编辑器内
 * 触发，Ctrl+F 会落到浏览器原生查找 —— 表现为「切 tab 后首次查找打不开」。
 * 这里钉死两层：编辑器句柄的 openSearch() 自身先聚焦再开面板；
 * 控制器全局键位在焦点位于编辑器外时兜底接管 Ctrl+F。
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../setup/cm6-jsdom.js';
import { createEditor } from '../../src/ui/editor.js';
import { AppController } from '../../src/ui/controller.js';
import { mountShell } from '../../src/ui/shell.js';

async function setup() {
  document.body.innerHTML = '<main id="app"></main>';
  const dom = mountShell('panel');
  const app = new AppController(dom, { surface: 'panel' });
  await app.init('', { compact: false });
  return { dom, app };
}

function ctrlF(): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('v1.7.2 / FR-U9：切 tab 后的编辑器内查找', () => {
  it('openSearch() 先聚焦编辑器再打开查找面板', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const ed = createEditor(host, { doc: '{"a":1}', lang: 'json' });

    ed.openSearch();

    expect(host.querySelector('.cm-panels')).not.toBeNull();
    expect(host.contains(document.activeElement)).toBe(true);
    ed.destroy();
  });

  it('切 tab 后焦点在 tab 按钮上，Ctrl+F 仍打开输入区查找面板', async () => {
    const { dom } = await setup();
    const tab = dom.tabConvert!;
    tab.click();
    // 真实 Chrome 点击 tab 会把焦点留在按钮上；jsdom 的 click 不移动焦点，显式补上。
    tab.focus();
    expect(document.activeElement).toBe(tab);

    const ev = ctrlF();

    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement?.closest('.cm-editor')).toBe(
      dom.editorIn.querySelector('.cm-editor'),
    );
    expect(dom.editorIn.querySelector('.cm-panels')).not.toBeNull();
  });
});