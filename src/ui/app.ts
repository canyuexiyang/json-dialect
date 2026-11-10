/**
 * 独立标签页入口（v1.3：大空间形态）
 *
 * 通过 chrome.storage.session 继承侧边栏状态，读取后立即清除。
 *
 * v1.5 / D23：chrome.storage.session 读后即清（FR-H7）与「刷新保留」天然冲突 ——
 * 消费后刷新页面，session 已空，一切归零。现在消费成功后把快照写进
 * sessionStorage（页面级内存，非持久化、不落盘，浏览器关闭即清），刷新时恢复。
 *
 * v1.5.1 / N11【P0】：**编辑器创建必须先于任何 await**。
 * 原实现把 `await consumeSession()` 排在 `mountShell()` 之前，一旦 storage.session
 * 的 Promise 不 settle（托管 Chrome / 上下文失效），首屏白等 2s —— 这正是历史 P0
 * 事故「布局正常但点不动」在入口层的重演，controller 里的防线管不到入口。
 * 现在严格分两段：
 *   ① 同步段：读页面级快照（纯同步）→ 建 DOM → 建编辑器 → 渲染首屏
 *   ② 异步段：消费跨页交接，迟到只补「继承值」，绝不影响界面可用性
 */

import { AppController } from './controller.js';
import { mountShell } from './shell.js';
import { consumeSession, withTimeout } from './sessionState.js';
import type { InheritedState } from './controller.js';

/** 会话读取超时兜底：宁可空白启动，也不卡死 */
const SESSION_TIMEOUT_MS = 2000;
/** 刷新恢复快照的 sessionStorage 键（非 chrome.storage，页面级内存） */
const REFRESH_KEY = 'json-dialect-refresh-snapshot';

interface Snapshot {
  input?: string;
  inherited?: InheritedState;
}

/** 同步读取刷新快照；损坏按无快照处理 */
function readSnapshot(): Snapshot | null {
  try {
    const raw = sessionStorage.getItem(REFRESH_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

function writeSnapshot(input: string, inherited: InheritedState): void {
  try {
    sessionStorage.setItem(REFRESH_KEY, JSON.stringify({ input, inherited }));
  } catch {
    /* sessionStorage 不可用（隐私模式等）只影响刷新恢复，不影响本次启动 */
  }
}

function main(): void {
  // ── ① 同步段：绝不 await，编辑器在这一段内就必须挂载完成 ──────────────────
  const snapshot = readSnapshot();
  const app = new AppController(mountShell('tab'), { surface: 'tab' });
  void app.init(snapshot?.input ?? '', snapshot?.inherited).catch(() => {
    /* init 内部已全量兜底；这里只兜住极端异常，避免 unhandled rejection */
  });

  // ── ② 异步段：交接态迟到只影响继承值，界面此刻已经可用 ────────────────────
  // 读后立即清除（FR-H7）；超时按「无交接」处理，保留刷新快照或空白首屏。
  void (async () => {
    const session = await withTimeout(
      consumeSession(location.hash.slice(1) || undefined),
      SESSION_TIMEOUT_MS,
      null,
    );
    if (!session) return;
    const inherited = toInherited(session);
    writeSnapshot(session.input, inherited);
    app.inheritFromSession(session.input, inherited);
  })();
}

/** SessionState（storage 侧，值均为 string）→ InheritedState（控制器侧，收窄类型） */
function toInherited(session: NonNullable<Awaited<ReturnType<typeof consumeSession>>>): InheritedState {
  return {
    workspaces: session.workspaces,
    strippedPrefix: session.strippedPrefix,
    source: session.source,
    locked: session.locked,
    compact: session.compact,
    overrides: session.overrides,
    tab: session.tab,
    target: session.target,
    strict: session.strict,
    escapeStyle: session.escapeStyle,
    escapeDir: session.escapeDir,
    wrapQuotes: session.wrapQuotes,
  };
}

main();
