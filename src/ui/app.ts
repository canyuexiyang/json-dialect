/**
 * 放大页入口（C-1 / FR-F6 / FR-H7）
 * 通过 chrome.storage.session 继承弹窗状态，读取后立即清除。
 *
 * 注意：consumeSession() 可能因 storage 不可用而长时间不 settle，
 * 因此这里也套了超时兜底 —— 超时就按「无继承」空白启动，
 * 绝不让用户面对一个卡死的空壳页面。
 */

import { AppController } from './controller.js';
import { consumeSession } from './sessionState.js';
import type { SourceFormat } from '../core/types.js';

function q<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少 DOM 节点: #${id}`);
  return el as T;
}

/** 会话读取超时兜底：宁可空白启动，也不卡死 */
const SESSION_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function main(): Promise<void> {
  const session = await withTimeout(consumeSession(), SESSION_TIMEOUT_MS, null); // 读后立即清除（FR-H7）

  const app = new AppController(
    {
      fmtLabel: q('fmtLabel'),
      lockBadge: q('lockBadge'),
      fmtSelect: q<HTMLSelectElement>('fmtSelect'),
      resetAuto: q<HTMLButtonElement>('resetAuto'),
    tabFormat: q<HTMLButtonElement>('tabFormat'),
    tabEscape: q<HTMLButtonElement>('tabEscape'),
    tabConvert: q<HTMLButtonElement>('tabConvert'),
    targetSelect: q<HTMLSelectElement>('targetSelect'),
    escapeStyleSelect: q<HTMLSelectElement>('escapeStyleSelect'),
    escapeDirSeg: q('escapeDirSeg'),
    escapeDirDecode: q<HTMLButtonElement>('escapeDirDecode'),
    escapeDirEncode: q<HTMLButtonElement>('escapeDirEncode'),
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
    },
    { isPage: true },
  );

  // AC-33：输入文本、来源判定、类型覆盖全部继承
  await app.init(session?.input ?? '', {
    source: session?.source,
    locked: session?.locked,
    compact: session?.compact,
    overrides: session?.overrides as Array<[string, string]> | undefined,
  });
}

void main();
