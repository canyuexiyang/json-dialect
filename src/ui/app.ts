/**
 * 独立标签页入口（v1.3：大空间形态）
 *
 * 通过 chrome.storage.session 继承侧边栏状态，读取后立即清除。
 *
 * 注意：consumeSession() 可能因storage 不可用而长时间不 settle，
 * 因此套了超时兜底 —— 超时就按「无继承」空白启动，
 * 绝不让用户面对一个卡死的空壳页面。
 *
 * v1.5 / D23：chrome.storage.session 读后即清（FR-H7）与「刷新保留」天然冲突 ——
 * 消费后刷新页面，session 已空，一切归零。现在消费成功后把快照写进
 * sessionStorage（页面级内存，非持久化、不落盘，浏览器关闭即清），刷新时恢复。
 */

import { AppController } from './controller.js';
import { mountShell } from './shell.js';
import { consumeSession, withTimeout } from './sessionState.js';
import type { InheritedState } from './controller.js';

/** 会话读取超时兜底：宁可空白启动，也不卡死 */
const SESSION_TIMEOUT_MS = 2000;
/** 刷新恢复快照的 sessionStorage 键（非 chrome.storage，页面级内存） */
const REFRESH_KEY = 'json-dialect-refresh-snapshot';

async function main(): Promise<void> {
  const session = await withTimeout(consumeSession(location.hash.slice(1) || undefined), SESSION_TIMEOUT_MS, null); // 读后立即清除（FR-H7）

  let initialInput = session?.input ?? '';
  let inherited: InheritedState | undefined = session ? toInherited(session) : undefined;

  // v1.5 / D23：无新会话（典型：刷新）→ 从 sessionStorage 快照恢复
  if (!session) {
    try {
      const raw = sessionStorage.getItem(REFRESH_KEY);
      if (raw) {
        const snap = JSON.parse(raw) as { input?: string; inherited?: InheritedState };
        initialInput = snap.input ?? '';
        inherited = snap.inherited;
      }
    } catch {
      /* 快照损坏按空白启动 */
    }
  } else {
    try {
      sessionStorage.setItem(REFRESH_KEY, JSON.stringify({ input: session.input, inherited: toInherited(session) }));
    } catch {
      /* sessionStorage 不可用（隐私模式等）只影响刷新恢复，不影响本次启动 */
    }
  }

  // 同步段优先：先把编辑器建起来，继承值迟到不影响可用性
  const app = new AppController(mountShell('tab'), { surface: 'tab' });
  // ⚠️ initialInput 必须来自 session —— InheritedState 里不含输入文本（它走 initialInput）
  await app.init(initialInput, inherited);
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

void main();