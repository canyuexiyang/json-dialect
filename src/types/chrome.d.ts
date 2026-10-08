/**
 * Chrome 扩展 API 的最小类型声明。
 *
 * 只声明本扩展实际用到的 `chrome.storage` / `chrome.runtime` / `chrome.sidePanel`，
 * 避免为几个 API 引入完整的 @types/chrome（体积大且版本漂移）。
 *
 * 约束（AC-34 / AC-49）：
 *  - v1.3 起 manifest 声明 `["storage", "sidePanel"]`。`sidePanel` 是**非 host 权限**
 *    （Chrome 官方明示：侧边栏无需 host 权限即可展示 UI），不申请任何能触达页面数据的权限。
 *  - 这里**不**声明 tabs / downloads 等 API —— 类型层面也不给越权调用留口子。
 */

interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface ChromeStorage {
  /** 纯内存会话存储，浏览器关闭即清空（FR-H7 跨页状态走这里） */
  session: ChromeStorageArea;
  /** 持久化存储，仅用于界面偏好（FR-H4） */
  local: ChromeStorageArea;
}

/** MV3 事件（仅需addListener / removeListener） */
interface ChromeEvent<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

interface ChromeRuntime {
  getURL(path: string): string;
  /** 扩展安装/更新完成 */
  onInstalled: ChromeEvent<(details: { reason: string }) => void>;
  /** 浏览器启动 */
  onStartup: ChromeEvent<() => void>;
}

interface ChromeSidePanelBehavior {
  /**
   * ⚠️ 属性名拼错（如写成 openPanelOnActionIconClick）会同步抛 TypeError
   * 并**静默中断整个 worker**，症状是「点了图标没反应」。勿改。
   */
  openPanelOnActionClick: boolean;
}

interface ChromeSidePanel {
  setPanelBehavior(behavior: ChromeSidePanelBehavior): Promise<void>;
  getPanelBehavior(): Promise<ChromeSidePanelBehavior>;
  /**
   * 打开面板。**必须传 windowId（窗口级，跨 tab 存活）**；
   * 传 tabId 会让面板只属于那一个 tab，切 tab 即失效 —— 症状与 v1.2 popup 一模一样。
   * 本扩展走 setPanelBehavior，不主动调 open()，签名仅留在类型层以防后续误用。
   */
  open(options: { windowId?: number; tabId?: number }): Promise<void>;
  /**
   * 关闭面板（Chrome 141+）。本扩展用的是**全局面板**，故只声明 windowId ——
   * 类型层面就不给「按 tabId 关」留口子（那是 tab 级面板的语义，用了会关不掉）。
   * 旧版 Chrome 上该方法不存在，调用方必须先判存在再调。
   */
  close(options: { windowId: number }): Promise<void>;
}

/**
 * `chrome.windows` 的**基础方法不需要任何 manifest 权限**
 * （只有读取 `Window.tabs` 才需要 `tabs` 权限）。
 * 这里只取窗口 id，因此不违反「仅 storage + sidePanel」的权限承诺。
 */
interface ChromeWindows {
  getCurrent(): Promise<{ id?: number }>;
}

declare const chrome: {
  storage: ChromeStorage;
  runtime: ChromeRuntime;
  sidePanel: ChromeSidePanel;
  windows: ChromeWindows;
};
