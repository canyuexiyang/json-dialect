/**
 * 侧边栏入口（v1.3 主入口）
 *
 * 与 v1.2 的 popup 相比，本文件刻意**不含任何 await**：
 * 侧边栏要的就是「文档长期存活、状态一直在」，若初始化链路被 storage 挂住，
 * 用户看到的就是一个点不动的空壳（坑 9）。
 * 偏好读取由 controller 的异步段自行兜底，与本入口无关。
 */

import { AppController } from './controller.js';
import { mountShell } from './shell.js';

async function main(): Promise<void> {
  // 同步段：建 DOM + 建编辑器 + 绑事件，一气呢成
  const app = new AppController(mountShell('panel'), { surface: 'panel' });
  await app.init();
}

void main();