/**
 * 弹窗入口（M1 主路径：粘贴 Python → 复制 JSON）
 */

import { AppController } from './controller.js';

function q<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少 DOM 节点: #${id}`);
  return el as T;
}

async function main(): Promise<void> {
  const app = new AppController({
    fmtLabel: q('fmtLabel'),
    lockBadge: q('lockBadge'),
    fmtSelect: q<HTMLSelectElement>('fmtSelect'),
    resetAuto: q<HTMLButtonElement>('resetAuto'),
    enlarge: q<HTMLButtonElement>('enlarge'),
    editorIn: q('editorIn'),
    editorOut: q('editorOut'),
    statsIn: q('statsIn'),
    statsOut: q('statsOut'),
    staleBadge: q('staleBadge'),
    fixbar: q('fixbar'),
    typePanel: q('typePanel'),
    statusMsg: q('statusMsg'),
    btnConvert: q<HTMLButtonElement>('btnConvert'),
    btnFormat: q<HTMLButtonElement>('btnFormat'),
    btnCompact: q<HTMLButtonElement>('btnCompact'),
    btnCopy: q<HTMLButtonElement>('btnCopy'),
    btnDownload: q<HTMLButtonElement>('btnDownload'),
    splitter: q('splitter'),
  });
  await app.init();
}

void main();
