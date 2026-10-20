/**
 * 跨页会话态（FR-H7 / C-1）
 *
 * 输入文本等会话态只走 chrome.storage.session（纯内存，浏览器关闭即清空），
 * 读取后立即清除。绝不使用 URL query（长度限制）或 storage.local（违反 FR-H4）。
 */

export interface WorkspaceState {
  input: string;
  source?: string;
  locked?: boolean;
  overrides?: Array<[string, string]>;
  strippedPrefix?: string;
}

export interface SessionState {
  workspaces?: Record<string, WorkspaceState>;
  strippedPrefix?: string;
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
export async function writeSession(state: SessionState, id?: string): Promise<boolean> {
  try {
    if (!chrome?.storage?.session) return false;
    const key = id ? `${KEY}:${id}` : KEY;
    let abandoned = false;
    const pending = chrome.storage.session.set({ [key]: state }).then(async () => {
      if (abandoned) { await discardSession(id); return false; }
      return true;
    });
    const ok = await withTimeout(pending, 1500, false);
    abandoned = !ok;
    return ok;
  } catch {
    return false;
  }
}

/**
 * Promise 超时兜底：超时返回 fallback，避免永不 settle 拖死调用方。
 *
 * chrome.storage 在扩展上下文异常（企业策略禁用 / 权限未就绪 / 上下文失效）时
 * 可能既不 resolve 也不 reject。任何 await 都必须有兜底，否则整条初始化链路
 * 会被拖死 —— 表现为「布局出来了但输入区点不动」（坑 9）。
 *
 * v1.3：原先此文件与 app.ts / controller.ts 各有一份几乎相同的实现，
 * 抽到这里单点维护。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
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
export async function consumeSession(id?: string): Promise<SessionState | null> {
  try {
    if (!chrome?.storage?.session) return null;
    const key = id ? `${KEY}:${id}` : KEY;
    const got = await withTimeout(chrome.storage.session.get(key), 1500, null);
    const val = (got as Record<string, SessionState | undefined> | null)?.[key];
    if (val) {
      await withTimeout(chrome.storage.session.remove(key), 1000, undefined);
      return val;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 打开失败或迟到写入时清除未消费的会话，失败不会影响原页面。 */
export async function discardSession(id?: string): Promise<void> {
  try {
    const key = id ? `${KEY}:${id}` : KEY;
    await withTimeout(chrome.storage.session.remove(key), 1000, undefined);
  } catch {
    // 会话仍只存在于浏览器内存中。
  }
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
  /** v1.3.1：宽度引导条已被用户关闭（侧边栏宽度无 API，只能提示一次） */
  hintWidth?: boolean;
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
    await withTimeout(chrome.storage.local.set({ [PREF_KEY]: p }), 1500, undefined);
  } catch {
    // ignore
  }
}
