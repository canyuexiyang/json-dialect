/**
 * Chrome 扩展 API 的最小类型声明。
 *
 * 只声明本扩展实际用到的 `chrome.storage` 与 `chrome.runtime.getURL`，
 * 避免为几个 API 引入完整的 @types/chrome（体积大且版本漂移）。
 *
 * 约束：本扩展仅声明 storage 权限，故这里**不**声明 tabs / downloads 等 API ——
 * 类型层面也不给越权调用留口子（AC-49）。
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

interface ChromeRuntime {
  getURL(path: string): string;
}

declare const chrome: {
  storage: ChromeStorage;
  runtime: ChromeRuntime;
};
