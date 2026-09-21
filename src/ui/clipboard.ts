/**
 * 剪贴板三级降级链（FR-E4 / FR-E5 / FR-E6，Spike S-1 验证对象）
 *
 * ① navigator.clipboard.writeText
 * ② textarea + execCommand('copy')
 * ③ 自动全选 + 提示手动 Ctrl/Cmd+C
 */

export type CopyMethod = 'clipboard-api' | 'exec-command' | 'manual';

export interface CopyResult {
  ok: boolean;
  method: CopyMethod;
  message: string;
}

/**
 * 尝试把文本写入剪贴板，逐级降级。
 * 弹窗环境下 document 可能因失焦被关闭，因此 ② 必须同步完成、不 await。
 */
export async function copyText(text: string): Promise<CopyResult> {
  if (!text) {
    return { ok: false, method: 'manual', message: '没有可复制内容' };
  }

  // ① Clipboard API
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard-api', message: '已复制' };
    }
  } catch {
    // 继续降级
  }

  // ② execCommand 降级（同步执行，避免弹窗失焦被关闭）
  try {
    const ok = execCommandCopy(text);
    if (ok) {
      return { ok: true, method: 'exec-command', message: '已复制（降级方案）' };
    }
  } catch {
    // 继续降级
  }

  // ③ 手动复制引导
  return {
    ok: false,
    method: 'manual',
    message: '自动复制失败，已为你全选，请按 Ctrl/Cmd + C',
  };
}

function execCommandCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  // 保持在视口内但不可见，避免触发滚动与焦点跳动
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  const selection = document.getSelection();
  const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  document.body.removeChild(ta);

  // 恢复原有选区
  if (prevRange && selection) {
    selection.removeAllRanges();
    selection.addRange(prevRange);
  }
  return ok;
}

/** ③ 失败时：把目标元素内容全选，便于用户手动复制（FR-E6） */
export function selectAllIn(el: HTMLElement): void {
  el.setAttribute('contenteditable', 'true');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
