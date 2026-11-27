/**
 * v1.8.0 / 视觉重构回归
 *
 * 只测「新结构不破坏既有契约」的三件事：
 *  1. 侧边栏「更多」菜单确实移动了既有按钮（不是复制），Esc / 点外关闭；
 *  2. 官方 DSH 令牌值落地，且不再出现 v1.8 案例里被用户否决的两个自定义值；
 *  3. 编辑器语法高亮不再依赖 oneDark，shell 新增节点齐全。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupMoreMenu } from '../../src/ui/moreMenu.js';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('v1.8.0 / 侧边栏更多菜单', () => {
  it('把四个既有按钮移进菜单，Esc / 点外关闭，chip 也能打开', () => {
    document.body.innerHTML = `
      <div id="app" class="app app--panel">
        <button id="moreActions" aria-expanded="false"></button>
        <span id="modeChip" role="button"></span>
        <div class="toolbar">
          <div class="toolbar__actions">
            <button id="btnFormat">档位：严格</button>
            <button id="btnCompact">缩进：美化</button>
            <button id="btnSnippet">存为片段</button>
            <button id="btnCompare">对比</button>
            <button id="moreActionsInActions"></button>
          </div>
          <div id="moreMenu" hidden></div>
        </div>
      </div>`;

    setupMoreMenu();
    const menu = document.getElementById('moreMenu') as HTMLElement;
    const trigger = document.getElementById('moreActions') as HTMLButtonElement;
    const chip = document.getElementById('modeChip') as HTMLButtonElement;

    // 移动而不是复制：原节点进入菜单，actions 里不再有它们
    expect(menu.querySelector('#btnFormat')).not.toBeNull();
    expect(menu.querySelector('#btnCompact')).not.toBeNull();
    expect(menu.querySelector('#btnSnippet')).not.toBeNull();
    expect(menu.querySelector('#btnCompare')).not.toBeNull();
    expect(document.querySelector('.toolbar__actions #btnFormat')).toBeNull();

    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-expanded')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true);

    chip.click();
    expect(menu.hidden).toBe(false);
    document.body.click();
    expect(menu.hidden).toBe(true);
  });
});

describe('v1.8.0 / 官方令牌与源码契约', () => {
  it('官方 tertiary / 错误文字值落地，不再出现被否决的替代值', () => {
    const css = code('src/ui/styles.css');
    expect(css).toContain('--dsw-alias-label-tertiary: #81858c');
    expect(css).toContain('--dsw-alias-state-error-text: #f25a5a');
    expect(css).not.toContain('#6b7076');
    expect(css).not.toContain('#ff9a9a');
    expect(css).not.toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('--j-code-string');
  });

  it('CM6 语法高亮改用 token HighlightStyle，不再 import oneDark', () => {
    const editor = code('src/ui/editor.ts');
    expect(editor).toContain("@lezer/highlight");
    expect(editor).toContain('HighlightStyle.define');
    expect(editor).not.toContain('oneDark');
  });

  it('shell 新增节点齐全：模式 chip、更多菜单、输出空态、下载/复制文字节点', () => {
    const shell = source('src/ui/shell.ts');
    for (const id of ['modeChip', 'moreActions', 'moreMenu', 'targetHint', 'emptyOut', 'downloadLabel', 'copyLabel']) {
      expect(shell, `缺少 #${id}`).toContain(`id="${id}"`);
    }
  });
});
