/**
 * 侧边栏入口（v1.3 主入口）
 *
 * 与 v1.2 的 popup 相比，这里的 await 只出现在**编辑器创建之后**：
 * 侧边栏要的就是「文档长期存活、状态一直在」，若 storage 在编辑器挂载前
 * 挂住，用户看到的就是一个点不动的空壳（坑 9）。
 * 真正的同步段在 controller.init() 里（建 DOM / 编辑器 / 绑事件），
 * 偏好读取由它的异步段自行兜底，本入口只负责调用。
 */

import { AppController } from './controller.js';
import { mountShell } from './shell.js';

async function main(): Promise<void> {
  // init 的同步段负责建 DOM + 建编辑器 + 绑事件，一气呵成；await 只等它的异步尾段
  const app = new AppController(mountShell('panel'), { surface: 'panel' });
  await app.init();
}

void main();