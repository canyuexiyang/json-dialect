# JSON Dialect

一个**纯本地**的 Chrome 扩展（MV3），用于 **Python 字面量 ↔ 标准 JSON ↔ Java 转义字符串 ↔ `Map.toString()`** 四向互转。

设计取向是「**格式翻译器**」而不是「JSON 校验器」——目标是把眼前这段文本变成能被目标语言直接吃掉的形态，**容错优先，能救就救**。

> **零网络 · 零埋点 · 零落盘。** 全部转换在浏览器本地完成，
> manifest 仅声明 `["storage", "sidePanel"]` 两项权限，**无任何 host 权限**。
>
> **当前版本 v1.3.0**（2026-10-08）—— 承载形态改为**侧边栏 + 独立标签页**。

---

## 快速开始

### 作为用户（加载已构建产物）

1. 从 [Releases](https://github.com/canyuexiyang/json-dialect/releases) 下载最新的 `json-dialect-dist-vX.Y.Z.zip` 并解压
2. Chrome 打开 `chrome://extensions/`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择**能直接看到 `manifest.json` 的那一层目录**
4. **点击扩展图标，侧边栏会从右侧展开**

> 目录选错一层 Chrome 会拒绝加载，这是最常见的安装失败原因。

**找不到侧边栏入口？** v1.3 删掉了原来的弹窗，图标点击现在是「展开侧边栏」。
若点击无反应，用 Chrome 的侧边栏下拉菜单（工具栏右侧的侧边栏按钮）手动选择
「JSON Dialect」。

### 作为开发者

```bash
npm install

npm run verify:all      # 全量门禁（推荐，见下）
npm run build           # 构建 → dist/
```

**`npm run verify:all`** 是唯一的发布门禁，串起四项：

| 门禁项 | 内容 | 当前结果 |
|---|---|---|
| `typecheck` | `tsc --noEmit`，严格模式 | 0 错误 |
| `test` | Vitest 全量（12 个文件） | **232 通过 / 0 失败** |
| `build` | Vite 构建 + manifest 拷入产物（含侧边栏/worker 存在性断言） | 通过 |
| `verify:python` | 54 个样本用目标语言解释器交叉校验 | 54/54 全部可解析 |
| `check:privacy` | 隐私与权限静态审查 | 通过 |

单跑某一类：`npm run test:unit` / `test:prop` / `test:ac` / `bench`。

> `build` 于 v1.3 纳入 `verify:all`。此前产物审查可以被绕过 ——
> `check:privacy` 检查的是**上一次构建留下的陈旧 `dist/`**。

---

## 它能做什么

### 三个 tab

| tab | 用途 | 档位 |
|---|---|---|
| **格式化** | 同语言进出：粘进来什么语言，出去还是什么语言 | 严格 / 容错（默认严格）、美化 / 压缩 |
| **转义** | 纯文本通道（**不经过 IR**）：JSON / Java / URL / Base64 四种风格 | **去除转义 / 增加转义** 二选一 |
| **转换** | 跨语言互转：4 种来源 × 3 种目标（Map 不作目标） | 容错优先 |

### 格式互转示例

| 方向 | 输入示例 | 输出示例 |
|---|---|---|
| Python → JSON | `{'name': '张三', 'vip': True}` | `{"name": "张三", "vip": true}` |
| JSON → Python | `{"a": null, "b": false}` | `{'a': None, 'b': False}` |
| Java 转义 → Python | `"{\"k\":\"v\"}"` | `{'k': 'v'}` |
| `Map.toString()` → Python | `{a=1, b=[x, y]}` | `{'a': 1, 'b': ['x', 'y']}` |

### 界面（v1.2.0 重设计，v1.3 响应式适配）

视觉方向是**工业仪表面板** —— 把插件当一台精密仪器来画，而不是又一个消费级卡片界面：
2px 硬圆角、机加工细线、输入「抬起台面」vs 输出「凹进读数窗」刻意不对等、
技术角标、等宽数码读数、铭牌式字标。

```
┌──────────────────────────────────────────────────┐
│▌JSON DIALECT  格式化  转义  转换          [标签页]│ ← 铭牌 + tab
├──────────────────────────────────────────────────┤
│▌● Python 字面量 [锁定] [来源 ▾] → [目标 ▾]       │ ← 判定条
├──────────────────────────────────────────────────┤
│▌输入                              行 3 · 字符 42│ ← 抬起台面
├══════════════════════════════════════════════════┤ ← 可拖动
│▌输出                              行 5 · 字符 60│ ← 凹进读数窗
├──────────────────────────────────────────────────┤
│▌● 粘贴内容即可自动转换  [转换][档位][缩进][复制] │ ← LED + 动作
└──────────────────────────────────────────────────┘
```

**左缘 3px 通道导轨随 tab 变色**（格式化=铜绿 / 转义=氧化琥珀 / 转换=钢蓝）——
不用读文字就知道自己在哪条通道上。

字体为 Archivo + IBM Plex Mono，**本地内嵌 woff2**（约 55KB）。
本项目承诺零网络，因此**禁止 CDN `@font-face`**；中文无对应字形，退回 PingFang SC。

**v1.3 响应式**：`.app` 去掉了写死的 720×600，改为 `width:100%`，
并新增 `.app--panel` 窄屏档（隐藏副标、缩小 tab 与按钮内边距）。
顶部条 / 判定条 / 工具栏三处均允许换行 ——
已在 320 / 360 / 500px 三档实测无横向滚动、无控件被裁。
`[hidden]{display:none!important}` 兜底见坑 13。

> **关于侧边栏宽度（真机实测确认，不是 bug）**：Chrome 侧边栏的宽度**没有 API**。
> `chrome.sidePanel` 的 `PanelOptions` 只有 `enabled` / `path` / `tabId`，
> 没有 `width`；宽度由浏览器 UI 层控制，默认约 360px、最小硬底约 320px，
> **只能用户手动拖动边缘调整**，扩展既不能设置宽度，也不能让它随窗口按比例自适应。
> 所以「默认占据窗口 1/3」做不到 —— 首次打开侧边栏会提示这一点，
> 需要更大空间就点右上角「标签页」：**侧边栏会自动关闭**，不会同时存在两个实例。

### 转义 tab（v1.1.1 重设计）

```
┌─────────────────────────────────────────────┐
│  格式化   转义   转换                        │  ← tab 条
├─────────────────────────────────────────────┤
│ [JSON 字符串 ▾]  [去除转义│增加转义]         │  ← 风格 + 方向（常驻可见）
├─────────────────────────────────────────────┤
│  输入 / 输出                                 │
├─────────────────────────────────────────────┤
│ 已自动去除外层引号    [反向：去除转义][复制] │  ← 状态 + 操作
└─────────────────────────────────────────────┘
```

- 方向是**一等操作**，显式二选一，默认「增加转义」，选择会记住
- 底部按钮写「反向：xxx」，明确说出点完会变成哪个方向
- **外层引号自动剥离**：从代码里复制的 `"{\"a\":1}"` → 去除转义 → `{"a":1}`（并提示已剥壳）
  —— 安全判据是扫描确认中间同种引号都被转义，所以 `a" + "b` 不会被误剥

### 其他关键行为

- **精度不丢失**：大整数、`1.0`、`1e5` 原样输出，全程不经过 `Number()`（避免 `12345678901234567890` 被压成 `...567000`）
- **容错修复可见**：单引号补全、尾随逗号、`True/False/None`、注释剥离、未闭合括号……每次修复都在「修正记录」里逐条列出**行列位置与改动前后**
- **报错定位**：解析失败时精确到行列，并在编辑器行号槽标记错误行
- **尾部残留 / 多值一律报错**：`{"a":1} garbage` 或 JSON Lines 不再被静默吞掉谎报「已修复」
- **日志前缀一键剥离**：`2024-01-01 12:00:00 INFO {"a":1}` 会识别为日志并提供「剥离前缀重试」
- **重复键检测**：输出前提示重复键及出现次数
- **标签页形态**：侧边栏空间不足时点「标签页」用整屏宽度；跨页会话用 `storage.session` 传递，读后即清。
  点完**侧边栏会自动关闭**（`chrome.sidePanel.close({windowId})`，Chrome 141+；旧版回退 `window.close()`），
  避免屏幕上同时挂着两个扩展实例
- **类型微调**：转换后对个别值可指定类型（如 `1` 视为字符串 `"1"`）

---

## 架构

```
输入文本
  └─ lexer(text) ──────────► Token[]   （一次扫描，带 {line, col, raw, marks}）
       ├─ detect(Token[]) ──► 首选来源格式（手动锁定则跳过）
       └─ for fmt of [首选, ...回退顺序]:
              parse(strict=true)  成功 → 状态「已解析」
              parse(strict=false) 成功 → 状态「已修复」（修正记录来自 token.marks）
           全部失败 → 精确行列错误
                        │
                        ▼
                    IR（JVal）
                        │
              ┌─────────┼─────────┐
        toJson(IR)  toPython(IR)  toJavaEsc(IR)
                        │
                        ▼
                    输出文本

转义 tab 走旁路：text ──escapeText()──► text（纯字符串，不进 IR）
```

三层解析**塌缩为一次 tokenize + strict/lenient 开关**——不做多轮文本重写（那会引入修复顺序依赖与行列漂移）。四个 parser 共享同一份 Token 流，所以全格式回退几乎零成本。

### 目录结构

```
src/core/                 纯函数内核（禁止 import 任何浏览器 API / chrome.*）
  ├─ lexer.ts             一次扫描 → Token[]
  ├─ detect.ts            来源格式打分器（信号封顶 + 结构前提）
  ├─ ir.ts                JVal 中间表示（判别联合）
  ├─ parse/               json / python / mapText / javaEsc 四个 parser + engine
  ├─ serialize/           toJson / toPython / toJavaEsc
  ├─ escapeText.ts        转义 tab 内核（json/java/url/base64 × 方向）
  ├─ logPrefix.ts         日志前缀识别（复用 lexer Token 流）
  ├─ fixLog.ts            修正记录（源自 token.marks）
  ├─ errors.ts            带行列的错误类型 + 超时控制
  └─ index.ts             convert() 统一入口
src/ui/                   界面层
  ├─ shell.ts             **单一 DOM 模板**（panel / tab 两形态共用，v1.3）
  ├─ panel.ts             侧边栏入口（v1.3 主入口）
  ├─ app.ts               独立标签页入口（继承 session）
  ├─ background.ts        MV3 service worker（仅注册面板行为）
  └─ editor / controller / clipboard / download …
tests/                    unit · prop · golden · acceptance · bench + setup
tools/                    copy-manifest.mjs · check-privacy.mjs · emit_outputs.mjs · 样本生成/校验脚本
samples/                  54 组输入样本 + 对应 .out.* 期望输出 + manifest.json 索引
docs/                     全过程文档（见下）
```

### 不可违背的约束

| 约束 | 说明 |
|---|---|
| 纯函数内核 | `src/core/` 不得引用浏览器 API 或 `chrome.*` |
| 输出来源 | 复制 / 下载**必须取程序产物**，不取 DOM 文本 |
| 权限最小化 | 仅 `storage` + `sidePanel`（均非host 权限）；标签页用 `window.open`，**禁用 `chrome.tabs.create`** |
| 承载形态 | 侧边栏（`side_panel.default_path`）为唯一主入口；`default_popup` 必须删除，否则优先级更高会顶掉面板行为 |
| 面板作用域 | 面板以 **window** 为单位（`windowId`），传 `tabId` 会让面板只属于那一个 tab，切 tab 即失效 |
| 存储分工 | 界面偏好 → `storage.local`；跨页会话 → `storage.session`（读后即清） |
| 字符计数 | 按 Unicode 码点 `[...text].length`，不用 `.length` |
| 高亮开关 | 用 CodeMirror 6 `Compartment` 动态卸载，**不重建编辑器**（保光标与 undo 栈） |
| 初始化顺序 | 编辑器创建**必须先于任何 `await`**；所有 `chrome.*` Promise 一律套超时兜底 |
| 偏好优先级 | 默认值先落同步段，异步读到的历史偏好**覆盖**它（顺序反了默认值会被架空） |

「初始化顺序」与「偏好优先级」两条是真机 P0 缺陷换来的：企业托管 Chrome 下 `chrome.storage` 的 Promise 可能既不 resolve 也不 reject，若 `await` 排在 `createEditor()` 前，界面骨架照常渲染但输入区完全点不动。详见 `docs/05-缺陷/`。

---

## 隐私与安全

本项目把「不联网」当作可验证的硬约束，而不是一句口号：

- manifest 权限白名单**只有 `storage` 与 `sidePanel`**，无 `host_permissions`，无 `tabs` / `activeTab` / `scripting` / `cookies` / `webRequest`
  - `sidePanel` 是**非host 权限**。Chrome 官方明示侧边栏无需 host 权限即可展示 UI，
    它不授予任何读取页面数据的能力
- **「侧边栏文档存活」≠「内容落盘」** —— 这是 v1.3 最容易被误解的一点：
  输入内容随侧边栏文档长期存活，是因为文档没被销毁，
  **不是**被写进了存储。FR-H4「输入零落盘」承诺不变：
  `storage.local` 只写界面偏好（tab 记忆 / 缩进档位 / 分隔比例），
  `storage.session` 只用于「侧边栏 → 标签页」的一次性交接且读后即清
- `npm run check:privacy` 静态审查源码与产物：无 `fetch` / `XMLHttpRequest` / `sendBeacon`、无外部 CDN 引用、无 `chrome.tabs.create`
- 构建时关闭 Vite 的 modulepreload polyfill（其内部含 `fetch`），确保产物里不存在任何网络代码路径

**AC-37（真机零网络请求）已于 v1.2.0 实测结清**：真机加载产物后观测到外部请求 0 个、
`fetch` / `XMLHttpRequest` 调用 0 次（字体走本地 woff2，不触网）。

---

## 文档索引

全过程文档已按需求全流程阶段归档在 `docs/`（详见 `docs/README.md`）：

| 目录 | 内容 |
|---|---|
| `docs/01-需求/` | `需求规格.md`（要什么）、`PRD.md` **v1.5**（做成什么样算对，§8 含 AC-01~88，唯一正本） |
| `docs/02-评审/` | `技术评审报告.md` v1.0（代码怎么写：架构、IR、目录分层、任务拆分） |
| `docs/03-研发/` | `研发任务清单.md`、`spike-记录.md`、`v1.1-研发实施记录.md`、`v1.2-UI设计规范.md`、**`v1.3.0-研发实施记录.md`**、**`v1.3.0-交付总览.md`**、**`v1.3.0-归档发布说明.md`**（现行版本）；`v1.2.0-交付总览.md`、`v1.1.1-交付总览.md`、`v1.1-交付总览.md`、`v1.1.1-归档发布说明.md`、`v1.2.0-归档发布说明.md`（版本存档） |
| `docs/04-验收/` | `PRD-8-验收标准.md`（v1.0 基线 AC-01~52）、`验收结论报告.md` |
| `docs/05-缺陷/` | `缺陷7-UI初始化被storage阻塞.md`（真机 P0） |
| `docs/06-迭代/` | `v1.1-迭代提案.md`、`v1.1-需求变更清单.md` v4、`PRD-v1.3-变更条目.md` 与 `PRD-v1.5-变更条目.md`（均已合并存档）、`v1.3-承载形态调研与优化建议.md` 与 `v1.3-研发方案与改动清单.md`（已实施存档） |

---

## 版本与当前状态

| 版本 | 日期 | 要点 | 门禁 |
|---|---|---|---|
| v1.0.0 | 2026-09-21 | M0~M3 四个里程碑、28 个子任务全部完成 | 141 测试 / 40 样本，AC 51/52 |
| v1.1.0 | 2026-09-22 | 三 tab 重构、目标格式解耦（4×3）、Java 转义输出、日志前缀、尾部残留报错 | 187 测试 / 54 样本 |
| v1.1.1 | 2026-09-22 | 转义方向可见化 + 外层引号自动剥离；格式化/转换 tab 零改动 | 197 测试 / 54 样本 |
| v1.2.0 | 2026-09-23 | UI 全量重构（工业仪表面板）+ 自绘下拉 + 字体本地内嵌；业务逻辑零改动 | 197 测试 / 54 样本 |
| **v1.3.0** | **2026-10-08** | **承载形态重构：popup →侧边栏 + 独立标签页**；布局响应化（320px 可用）；新增 service worker；单模板替代两份重复 HTML；死代码剔除；splitter 加固；发布前按真机反馈修「侧边栏不关」并加宽度引导条 | **232 测试 / 54 样本**（commit `695bb65` / tag `v1.3.0`） |

**v1.1.1 真机 Chrome 冒烟 9 项全过**：方向控件可见、默认增加转义、切换即时生效、
`{\"a\":1}` → `{"a":1}`、带外层引号一次解干净且提示、Base64 `中文`⟷`5Lit5paH` 往返、
底部反向按钮、格式化 tab 未受影响。

**v1.2.0 真机验收**：零外部请求 / 零 `fetch`/XHR（AC-37 结清）、字体加载正常、
720×600 无溢出、三 tab 通道换色正确、深浅色令牌落地正确、
下拉（点开 / 选中 / change 冒泡 / 点外部收起 / Esc 收起 / 不溢出）全部正常、
解压产物可加载运行。

**v1.3.0 真机验收**（脚本 `tools/v13-verify.mjs`，截图见 `docs/03-研发/`）：
320 / 360 / 500px × 三 tab 共 9 组**零横向滚动、零控件裁切**，
「复制」「下载」「标签页」全部完整可见可点；
标签页形态正确继承输入内容 + tab 状态 + 来源判定，且不带「标签页」按钮；
点「标签页」后**侧边栏自动关闭**（端到端断言收到 `close({windowId})`），不会留下两个实例；
宽度引导条在 320px 下正常换行无裁切；
AC-37 复验**外部请求 0 个**。

### 已知遗留（均为人工事项，无法自动化）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **跨标签页存活（AC-82）** | **本次需求的根本目标**。切到 B 标签页再切回 A，确认输入内容与 tab 状态完好 |
| 2 | 扩展更新后 worker 是否仍生效 | MV3 worker 约 30s 回收；重载扩展后确认 `setPanelBehavior` 仍生效。**若点图标没反应**，查 `chrome://extensions` 的「检查视图：service worker」 |
| 3 | 侧边栏三档宽度的观感与中文混排 | 人工目测 |
| 4 | Spike S-2 真机 CSP 确认 | CodeMirror 6 在 MV3 CSP 下的实机表现；jsdom 不执行 CSP，属纯盲区 |

> ✅ **AC-81（点图标展开侧边栏）已真机确认**：v1.3.0 产物实测可展开。

> AC-37（真机零网络）已随 v1.2.0 结清并在 v1.3.0 **复验通过**（引入 sidePanel 与 service worker 后仍为零外部请求）。
>
> **删popup 的副作用**：主发现路径从「点图标即用」变成「点图标展开侧边栏」。
> 对不了解侧边栏的用户发现成本上升，README 与商店描述已强化入口说明。

---

## 踩过的坑（改动前建议先读）

1. `GutterMarker` / `gutter` / `Decoration` 在 `@codemirror/view`，**不在** `codemirror` 元包。
2. jsdom 缺 `Range.getClientRects`，CodeMirror 6 会抛异常 → `tests/setup/cm6-jsdom.ts` 已补。
3. 错误行高亮别用 `querySelector('.cm-line')[n-1]`（重排会错位），要用 `StateField` + `Decoration`。
4. `Write` 类工具会吃掉 `\"`、`\u0000` 这类字面转义 → 含控制字符的 TS 源码改用 python heredoc 写入。
5. Map 语法里**空白是有效内容**，parser 必须扫描原文，不能用 token 拼接还原。
6. **Vite 不会把根目录的 `manifest.json` 和 `icons/` 拷进 dist** —— 产物会直接无法加载。`tools/copy-manifest.mjs` 已补上（含产物内图标存在性断言），**任何门禁都测不出这个，只能手验**。
7. `die()` 返回 `never` 但 TS 不推断 → 需 `return die(...)` 或加 `need()` 类型守卫收窄。
8. `await` 任何 `chrome.*` Promise 都可能永不 settle → 必须套超时，且**不得挡在编辑器创建之前**。
9. **Base64 必须走 UTF-8**：原生 `btoa('中文')` 抛 `InvalidCharacterError`（只吃 Latin-1），须 `TextEncoder → btoa` / `atob → TextDecoder`。
10. **剥外层引号不能只比首尾字符** —— 必须扫描确认中间同种引号都被 `\` 转义，否则 `a" + "b` 会被误判。
11. ESM 不认 `NODE_PATH`：探针脚本要放在 `node_modules` 所在目录里跑，否则 `ERR_MODULE_NOT_FOUND`。
12. 测试里断言列号要数准：`{"a":1} garbage` 中 `g` 在第 **8** 列（`}`6、空格7、`g`8）。
13. **组件的显式 `display` 会盖掉 `[hidden]` 的默认 `display:none`** —— `.seg` / `.sel` 设了 `display:inline-flex`，被 `hidden` 后**依然占位**，判定条上留一截空白缺口。修法是全局补 `[hidden]{display:none!important}`，并让包装容器跟随原生控件同步显隐。**197 个测试全绿也测不出，只能真机量高度。**
14. **自绘下拉必须保留真实 `<select>` 在 DOM 里** —— 既有测试与控制器都依赖原生 `change`。做法：原生 select 用 `clip: rect(0 0 0 0)` 视觉隐藏（不能用 `display:none`，`options` 仍要可读），自绘菜单选中后写回 `value` 再派发原生 `change`；装饰全程 try 包住，失败静默降级。
15. **零网络约束下不能引 CDN 字体** —— 把 woff2 下载到 `src/ui/fonts/`，Vite 会打包进 `dist/assets/` 并把 `url()` 改写成 `/assets/xxx.woff2`（扩展根绝对路径，在 `chrome-extension://` 下正确解析）。`fonttools` 检查可变轴需先 `pip install brotli`。
16. **真机验证比肉眼可靠** —— 写脚本断言 `getComputedStyle`（令牌是否真的落地）与 `getBoundingClientRect`（是否溢出/占位），比看截图更能发现真问题。坑 13 就是这么抓出来的。
17. **puppeteer 访问 `chrome-extension://` 会被 `ERR_BLOCKED_BY_CLIENT`** —— 改起本地静态服务器托管 dist 走 `http://127.0.0.1:<port>`，再注入 `window.chrome` 即可复现 UI 层问题。后台 server 要用 `run_in_background`，否则父 shell 退出即死。
18. **`evaluateOnNewDocument` 会把函数序列化后注入，闭包变量全部丢失** —— 外部变量必须先用一段字面量脚本写进 `window`。
19. **模拟 `chrome.storage` 必须遵守真实 API 形状** —— `get(key)` 返回 `{ [key]: value }` 而不是 `value`。
    另外 `storage.session` 必须**跨JS 上下文共享**（`window.open` 出的新页是独立上下文），
    否则「侧边栏 → 标签页」的继承永远测不出来，且症状只是「静默不继承」，极难定位。用 `localStorage` 模拟即可。
20. **jsdom 会把 `style.flex = '0.95'` 归一化成 `'0.95 1 0%'`** —— 断言时不能直接 `Number()`（得 NaN），要取第一段。
21. **写这类断言时别让关键词出现在注释里** —— 「controller 不再含 isPage」这类断言若用全文匹配，
    会因为解释性注释里提到了 `isPage` 而永远失败。**一旦失败就没人敢信的断言等于没有断言**。
    做法：`readCode()` 剥掉注释行再匹配。

---

## 许可

MIT
