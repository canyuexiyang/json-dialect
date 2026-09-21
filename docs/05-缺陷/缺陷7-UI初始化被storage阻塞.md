# 缺陷 7：UI 初始化被 storage 阻塞（真机 P0）

| 项 | 内容 |
|---|---|
| 发现时间 | 2026-09-21 |
| 发现方式 | 人工验收 `rqYp56` 时用户反馈 |
| 严重级别 | **P0 —— 扩展完全不可用** |
| 状态 | 已修复 + 回归测试锁定 |

---

## 一、现象

扩展加载后，判定条、输入区、输出区、底部按钮**一应俱全，看起来完全正常**，
但**输入区点不动、粘贴不进**，验收第一步就卡住。

## 二、根因

`AppController.init()` 中 `await loadPrefs()` 排在 `createEditor()` **之前**：

```ts
// 修复前 —— 问题代码
async init() {
  const prefs = await loadPrefs();   // ← 永不返回时，下面全部不执行
  this.compact = prefs.compact ?? false;
  this.in = createEditor(...);        // ← 编辑器永远创建不出来
  this.out = createEditor(...);
}
```

在企业托管 Chrome 环境下（用户截图左上角显示「Chrome 已由贵单位管理」），
`chrome.storage` 的 Promise 可能**既不 resolve 也不 reject**，
于是 `await` 永不返回，编辑器永远创建不出来。

**为什么极具误导性**：页面骨架是纯 HTML，不依赖 JS 就能渲染出完整布局。
用户（和排查者）看到的是「界面加载正常」，很难联想到是 JS 初始化卡死。

## 三、为什么自动化测不出来

jsdom 里 `chrome.storage` 根本不存在，`loadPrefs()` 走的是：

```ts
if (!chrome?.storage?.local) return {};   // 同步返回，await 立刻完成
```

这条路径在 jsdom 里**永远瞬时完成**，问题路径根本不会被执行。
属于典型的「真机盲区」，与 AC-37、Spike S-2 同类。

## 四、复现方法（可复用）

用 puppeteer 注入一个**永不 settle 的 chrome.storage**：

```js
await page.evaluateOnNewDocument(() => {
  const never = () => new Promise(() => {});
  window.chrome = {
    runtime: { getURL: (p) => `chrome-extension://fake/${p}` },
    storage: {
      local:   { get: never, set: never },
      session: { get: never, set: never, remove: never },
    },
  };
});
```

**对照组结果**（与用户截图逐像素吻合）：

| 指标 | 修复前（storage 挂起） | 修复后 |
|---|---|---|
| `.cm-editor` 数量 | **0** | 2 |
| `contenteditable` | — | true |
| 状态栏文案 | **空字符串** | 粘贴内容即可自动转换 |
| 输入/粘贴 | **完全无响应** | 正常转换 |

## 五、修复方案

### 1. `src/ui/controller.ts` —— init() 拆成严格两段

```ts
async init(initialInput = '', inherited?) {
  // ① 同步段：建编辑器、绑事件、渲染首屏 —— 任何 await 都不得出现在这之前
  this.in  = createEditor(this.dom.editorIn,  {...});
  this.out = createEditor(this.dom.editorOut, {...});
  this.bindEvents();
  if (initialInput) this.run(initialInput); else this.renderEmpty();

  // ② 异步段：偏好迟到不影响可用性，带 1.5s 超时
  if (inherited?.compact === undefined) void this.applyPrefsWhenReady();
}
```

### 2. `src/ui/sessionState.ts` —— 所有 storage 调用套超时

新增 `withTimeout()`，`loadPrefs` / `consumeSession` 均带兜底：

| 函数 | 超时 |
|---|---|
| `loadPrefs()` | 1500 ms |
| `consumeSession()` get | 1500 ms |
| `consumeSession()` remove | 1000 ms |

### 3. `src/ui/app.ts` —— 会话读取套 2s 超时

放大页同样曾受影响：`consumeSession()` 也是先 await 再建编辑器。
现在超时即按「无继承」空白启动，宁可空白也不卡死。

## 六、回归防线

新增 `tests/acceptance/ui-init-hang.test.ts`（3 例）：

1. storage 永不返回时，编辑器仍必须完成挂载
2. storage 永不返回时，转换功能依然可用
3. storage 永不返回时，首屏状态提示已就位

**已做反向验证**：把代码改回 buggy 写法 → 3 例**全红**；
恢复修复 → **全绿**。证明测试确实锁住了该 bug，不是空跑。

## 七、通用教训

> **任何 `chrome.*` Promise 都必须假设它可能永不 settle。**
> UI 初始化路径上的 `await` 一律要有超时兜底；
> 编辑器/主交互的创建必须排在**同步段**，不能依赖任何异步结果。

---

## 附：门禁与产物

- `npm run verify:all`：**141 passed**（8 文件，原 138 + 新增 3）
- typecheck 0 错误 / verify:python 40/40 / check:privacy 通过
- 已重新 `npm run build` 并重打 `json-dialect-dist-v1.0.0.zip`（8 文件，517014 B）
