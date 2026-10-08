/**
 * 独立标签页入口（v1.3：大空间形态）
 *
 * 通过 chrome.storage.session 继承侧边栏状态，读取后立即清除。
 *
 * 注意：consumeSession() 可能因storage 不可用而长时间不 settle，
 * 因此套了超时兜底 —— 超时就按「无继承」空白启动，
 * 绝不让用户面对一个卡死的空壳页面。
 */

import { AppController } from './controller.js';
import { mountShell } from './shell.js';
import { consumeSession, withTimeout } from './sessionState.js';
import type { InheritedState } from './controller.js';

/** 会话读取超时兜底：宁可空白启动，也不卡死 */
const SESSION_TIMEOUT_MS = 2000;

async function main(): Promise<void> {
  const session = await withTimeout(consumeSession(), SESSION_TIMEOUT_MS, null); // 读后立即清除（FR-H7）

  // 同步段优先：先把编辑器建起来，继承值迟到不影响可用性
  const app = new AppController(mountShell('tab'), { surface: 'tab' });
  // ⚠️ initialInput 必须来自 session —— InheritedState 里不含输入文本（它走 initialInput）
  await app.init(session?.input ?? '', session ? toInherited(session) : undefined);
}

/** SessionState（storage 侧，值均为 string）→ InheritedState（控制器侧，收窄类型） */
function toInherited(session: NonNullable<Awaited<ReturnType<typeof consumeSession>>>): InheritedState {
  return {
    source: session.source,
    locked: session.locked,
    compact: session.compact,
    overrides: session.overrides,
    tab: session.tab,
    target: session.target,
    strict: session.strict,
    escapeStyle: session.escapeStyle,
    escapeDir: session.escapeDir,
  };
}

void main();