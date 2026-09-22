/**
 * 跨页会话态（FR-H7 / C-1）
 *
 * 输入文本等会话态只走 chrome.storage.session（纯内存，浏览器关闭即清空），
 * 读取后立即清除。绝不使用 URL query（长度限制）或 storage.local（违反 FR-H4）。
 */

export interface SessionState {
  input: string;
  source?: string;
  locked?: boolean;
  compact?: boolean;
  overrides?: Array<[string, string]>;
  /** O-9：tab / 目标 / 严格档 / 转义设置需一并继承，否则放大页回到默认 tab */
  tab?: string;
  target?: string;
  strict?: boolean;
  escapeStyle?: string;
  escapeDir?: string;
}

const KEY = 'json-dialect-session';

/** 写入会话态（弹窗 → 放大页） */
export async function writeSession(state: SessionState): Promise<void> {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.set({ [KEY]: state });
  } catch {
    // storage.session 不可用时静默失败，放大页退化为空白启动
  }
}

/**
 * Promise 超时兜底：超时返回 fallback，避免永不 settle 拖死调用方。
 *
 * chrome.storage 在扩展上下文异常（企业策略禁用 / 权限未就绪 / 上下文失效）时
 * 可能既不 resolve 也不 reject。任何 await 都必须有兜底，否则整条初始化链路
 * 会被拖死 —— 表现为「布局出来了但输入区点不动」。
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    Promise.resolve(p).then(
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

/** 读取并立即清除（FR-H7） */
export async function consumeSession(): Promise<SessionState | null> {
  try {
    if (!chrome?.storage?.session) return null;
    const got = await withTimeout(chrome.storage.session.get(KEY), 1500, null);
    const val = (got as Record<string, SessionState | undefined> | null)?.[KEY];
    if (val) {
      await withTimeout(chrome.storage.session.remove(KEY), 1000, undefined);
      return val;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 界面偏好持久化（FR-H4 / FR-E9 / D-6）
 * 只允许写入界面偏好，输入/输出内容零落盘。
 */
export interface Prefs {
  compact?: boolean;
  splitRatio?: number;
  /** FR-L3：tab 记忆。无历史偏好时回落到默认「格式化」 */
  tab?: string;
  /** FR-A17：转换 tab 的目标格式 */
  target?: string;
  /** FR-K3：格式化 tab 的容错档位，独立于转换 tab 的目标格式 */
  strict?: boolean;
  /** FR-I5：转义 tab 的方向（去除转义 / 增加转义），历史偏好覆盖默认值 */
  escapeDir?: string;
}

const PREF_KEY = 'json-dialect-prefs';

/**
 * 读取界面偏好。
 *
 * 注意：chrome.storage 在扩展上下文异常时可能既不 resolve 也不 reject
 * （企业策略禁用 storage、权限未就绪、上下文失效等）。调用方若直接 await
 * 会永久挂起，因此这里自带 1.5s 超时兜底，保证任何时候都能返回。
 */
export async function loadPrefs(): Promise<Prefs> {
  try {
    if (!chrome?.storage?.local) return {};
    const got = await withTimeout(chrome.storage.local.get(PREF_KEY), 1500, null);
    if (!got) return {};
    return (got[PREF_KEY] as Prefs) ?? {};
  } catch {
    return {};
  }
}

export async function savePrefs(p: Prefs): Promise<void> {
  try {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.set({ [PREF_KEY]: p });
  } catch {
    // ignore
  }
}
