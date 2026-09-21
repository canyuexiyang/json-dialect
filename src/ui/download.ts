/**
 * 下载（FR-E7 / FR-E7a / FR-H6）
 * Blob URL + <a download> —— 扩展页内该方案不需要 downloads 权限。
 */

import type { OutputLang } from '../core/types.js';

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

export function fileNameFor(lang: OutputLang): string {
  return 'json-dialect-output-' + timestamp() + (lang === 'json' ? '.json' : '.py');
}

/** 按钮文案（FR-E7a） */
export function downloadLabel(lang: OutputLang): string {
  return lang === 'json' ? '下载 .json' : '下载 .py';
}

export function downloadText(text: string, lang: OutputLang): void {
  const blob = new Blob([text], { type: lang === 'json' ? 'application/json' : 'text/x-python' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(lang);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立即回收，避免内存泄漏
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
