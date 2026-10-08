/**
 * service worker（v1.3 新增）
 *
 * 职责单一：**只注册侧边栏的点击展开行为**，不承载任何业务逻辑。
 *
 * 为什么必须有它：
 *   v1.3 删掉了 `action.default_popup`。按 Chrome 规范，没有 default_popup 时
 *   点击工具栏图标会触发 `action.onClicked`；若连监听器都没有，则**点了完全没反应**。
 *   本扩展此前是纯页面扩展、无 service worker，所以必须新增一个。
 *
 * 为什么用 setPanelBehavior 而不是 action.onClicked + sidePanel.open()：
 *   前者一行搞定（官方示例即如此），后者多一个监听器 = 多一份 MV3 回收风险。
 *
 * ⚠️ 两个必须写对的点（写错症状都是「点了没反应」，极难自查）：
 *   1. 属性名是 `openPanelOnActionClick`。写成 openPanelOnActionIconClick 会同步抛
 *      TypeError，**静默中断整个 worker**。
 *   2. 面板必须以 window 为作用域。若改用 open()，务必传 `{ windowId }` 而非
 *      `{ tabId }` —— tabId 会让面板只属于那一个 tab，切 tab 即失效，
 *      症状与 v1.2 的 popup 一模一样。
 *
 * ⚠️ 监听器必须**模块顶层同步注册**。MV3 worker 约 30s 即被回收，
 * 放进回调或 await 之后会漏事件（项目已有同类教训：坑 9 初始化被 await 拖死）。
 */

function registerPanelBehavior(): void {
  if (typeof chrome === 'undefined' || !chrome.sidePanel) return;
  // 属性名逐字核对：openPanelOnActionClick
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // 上下文失效（如扩展更新中）时静默失败，下次 onInstalled/onStartup 会补上
  });
}

chrome.runtime.onInstalled.addListener(registerPanelBehavior);
chrome.runtime.onStartup.addListener(registerPanelBehavior);

// 兜底：worker 被浏览器随时唤醒（不只 install/startup）时补注册一次。
// setPanelBehavior 幂等，重复调用无副作用。
registerPanelBehavior();