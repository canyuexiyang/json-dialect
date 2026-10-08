/**
 * 关闭侧边栏（v1.3.1）
 *
 * 背景：点「标签页」按钮会在浏览器里新开一个整屏标签页，但**侧边栏不会自己关** ——
 * 屏幕上同时存在两个扩展实例，且侧边栏那份还占着 320~360px。用户报的第二个问题。
 *
 * ⚠️ 为什么需要两条路径：
 *   ① `chrome.sidePanel.close()` —— 官方 API，但**Chrome 141+ 才有**。
 *      旧版上该方法根本不存在，直接调用会同步抛 TypeError。
 *   ② `window.close()` —— 侧边栏本身就是一个扩展页面，扩展页面可以自己关掉自己。
 *      这是 Chromium 官方邮件组推荐的做法（无 close() 时代的唯一出路），社区实测有效；
 *      最坏情况是静默无效，不会误伤浏览器窗口。
 *
 * 顺序：先官方 API（确定性最高），失败/不存在再 window.close()。
 * 全程 try 包裹 + 超时兜底 —— 关不掉只是「多留一个面板」，绝不能反过来把已打开的
 * 标签页链路搞挂（坑 9 同源：chrome.* 的 Promise 可能永不 settle）。
 */

import { withTimeout } from './sessionState.js';

/** 官方路径：Chrome 141+ */
async function closeViaApi(): Promise<boolean> {
  try {
    // 旧版 Chrome 根本没有 close()，判存在再调 —— 否则同步抛错会漏掉兜底
    const closeFn = chrome?.sidePanel?.close;
    if (typeof closeFn !== 'function') return false;

    // close() 必须给 windowId 或 tabId。本扩展是全局面板（非 tab 级），
    // 传 tabId 反而关不掉，故只取 windowId。
    const win = await withTimeout(chrome.windows?.getCurrent?.() ?? Promise.resolve(null), 1200, null);
    const windowId = win?.id;
    if (!windowId) return false;

    await withTimeout(chrome.sidePanel.close({ windowId }), 1200, undefined);
    return true;
  } catch {
    // 权限缺失 / 上下文失效 / 面板已关闭 → 交给兜底
    return false;
  }
}

/** 兜底路径：扩展页面自关。失败即静默无效，不抛。 */
function closeViaWindow(): void {
  try {
    // 前置判断：连 sidePanel 命名空间都不存在，说明根本不在扩展/侧边栏上下文
    // （jsdom 测试、被当成普通页面打开等）。此时调 window.close() 纯属副作用 ——
    // jsdom 下它会把整个 window 标记为 closed，污染同一文件里后续的用例。
    if (!chrome?.sidePanel) return;
    window.close();
  } catch {
    // 页面不允许脚本关闭时会被浏览器拦下，忽略即可
  }
}

/**
 * 尽力关闭侧边栏。
 * @returns 是否走了官方 API 成功关闭（false 表示只尝试了兜底，不保证关掉）
 */
export async function closeSidePanel(): Promise<boolean> {
  const ok = await closeViaApi();
  if (!ok) closeViaWindow();
  return ok;
}
