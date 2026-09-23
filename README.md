# JSON Dialect

一个**纯本地**的 Chrome 扩展（MV3），用于 **Python 字面量 ↔ 标准 JSON ↔ Java 转义字符串 ↔ `Map.toString()`** 四向互转。

设计取向是「**格式翻译器**」而不是「JSON 校验器」——目标是把眼前这段文本变成能被目标语言直接吃掉的形态，**容错优先，能救就救**。

> **零网络 · 零埋点 · 零落盘。** 全部转换在浏览器本地完成，manifest 仅声明 `["storage"]` 一项权限。
>
> **当前版本 v1.2.0**（2026-09-23）。

---

## 快速开始

### 作为用户（加载已构建产物）

1. 从 [Releases](https://github.com/canyuexiyang/json-dialect/releases) 下载最新的 `json-dialect-dist-vX.Y.Z.zip` 并解压
2. Chrome 打开 `chrome://extensions/`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择**能直接看到 `manifest.json` 的那一层目录**
4. 点击扩展图标即可使用

> 目录选错一层 Chrome 会拒绝加载，这是最常见的安装失败原因。

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
| `test` | Vitest 全量（10 个文件） | **197 通过 / 0 失败** |
| `verify:python` | 54 个样本用目标语言解释器交叉校验 | 54/54 全部可解析 |
| `check:privacy` | 隐私与权限静态审查 | 通过 |

单跑某一类：`npm run test:unit` / `test:golden` / `test:prop` / `test:ac` / `bench`。

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

### 界面（v1.2.0 重设计）

视觉方向是**工业仪表面板** —— 把插件当一台精密仪器来画，而不是又一个消费级卡片界面：
2px 硬圆角、机加工细线、输入「抬起台面」vs 输出「凹进读数窗」刻意不对等、
技术角标、等宽数码读数、铭牌式字标。

```
┌──────────────────────────────────────────────────┐
│▌JSON DIALECT  格式化  转义  转换            [放大]│ ← 铭牌 + tab
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
- **放大页面**：弹窗空间不足时可放大；跨页会话用 `storage.session` 传递，读后即清
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
src/ui/                   界面层（app / popup / editor / controller / clipboard / download …）
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
| 权限最小化 | 仅 `storage`；放大用 `window.open`，**禁用 `chrome.tabs.create`** |
| 存储分工 | 界面偏好 → `storage.local`；跨页会话 → `storage.session`（读后即清） |
| 字符计数 | 按 Unicode 码点 `[...text].length`，不用 `.length` |
| 高亮开关 | 用 CodeMirror 6 `Compartment` 动态卸载，**不重建编辑器**（保光标与 undo 栈） |
| 初始化顺序 | 编辑器创建**必须先于任何 `await`**；所有 `chrome.*` Promise 一律套超时兜底 |
| 偏好优先级 | 默认值先落同步段，异步读到的历史偏好**覆盖**它（顺序反了默认值会被架空） |

最后两条是真机 P0 缺陷换来的：企业托管 Chrome 下 `chrome.storage` 的 Promise 可能既不 resolve 也不 reject，若 `await` 排在 `createEditor()` 前，界面骨架照常渲染但输入区完全点不动。详见 `docs/05-缺陷/`。

---

## 隐私与安全

本项目把「不联网」当作可验证的硬约束，而不是一句口号：

- manifest 权限白名单**只有 `storage`**，无 `host_permissions`，无 `tabs` / `activeTab` / `scripting` / `cookies` / `webRequest`
- `npm run check:privacy` 静态审查源码与产物：无 `fetch` / `XMLHttpRequest` / `sendBeacon`、无外部 CDN 引用、无 `chrome.tabs.create`
- 构建时关闭 Vite 的 modulepreload polyfill（其内部含 `fetch`），确保产物里不存在任何网络代码路径

**AC-37（真机零网络请求）已于 v1.2.0 实测结清**：真机加载产物后观测到外部请求 0 个、
`fetch` / `XMLHttpRequest` 调用 0 次（字体走本地 woff2，不触网）。

---

## 文档索引

全过程文档已按需求全流程阶段归档在 `docs/`（详见 `docs/README.md`）：

| 目录 | 内容 |
|---|---|
| `docs/01-需求/` | `需求规格.md`（要什么）、`PRD.md` **v1.4**（做成什么样算对，§8 含 AC-01~80） |
| `docs/02-评审/` | `技术评审报告.md` v1.0（代码怎么写：架构、IR、目录分层、任务拆分） |
| `docs/03-研发/` | `研发任务清单.md`、`spike-记录.md`、`v1.1-研发实施记录.md`、`v1.1.1-交付总览.md`、**`v1.2-UI设计规范.md`**、**`v1.2.0-交付总览.md`**（现行版本）、`v1.1.1-归档发布说明.md`、`v1.1-交付总览.md` |
| `docs/04-验收/` | `PRD-8-验收标准.md`（v1.0 基线 AC-01~52）、`验收结论报告.md` |
| `docs/05-缺陷/` | `缺陷7-UI初始化被storage阻塞.md`（真机 P0） |
| `docs/06-迭代/` | `v1.1-迭代提案.md`、`v1.1-需求变更清单.md` v4、`PRD-v1.3-变更条目.md`（已合并存档） |

---

## 版本与当前状态

| 版本 | 日期 | 要点 | 门禁 |
|---|---|---|---|
| v1.0.0 | 2026-09-21 | M0~M3 四个里程碑、28 个子任务全部完成 | 141 测试 / 40 样本，AC 51/52 |
| v1.1.0 | 2026-09-22 | 三 tab 重构、目标格式解耦（4×3）、Java 转义输出、日志前缀、尾部残留报错 | 187 测试 / 54 样本 |
| v1.1.1 | 2026-09-22 | 转义方向可见化 + 外层引号自动剥离；格式化/转换 tab 零改动 | 197 测试 / 54 样本 |
| **v1.2.0** | **2026-09-23** | **UI 全量重构（工业仪表面板）+ 自绘下拉 + 字体本地内嵌**；业务逻辑零改动 | **197 测试 / 54 样本** |

**v1.1.1 真机 Chrome 冒烟 9 项全过**：方向控件可见、默认增加转义、切换即时生效、
`{\"a\":1}` → `{"a":1}`、带外层引号一次解干净且提示、Base64 `中文`⟷`5Lit5paH` 往返、
底部反向按钮、格式化 tab 未受影响。

**v1.2.0 真机验收**：零外部请求 / 零 `fetch`/XHR（AC-37 结清）、字体加载正常、
720×600 无溢出、三 tab 通道换色正确、深浅色令牌落地正确、
下拉（点开 / 选中 / change 冒泡 / 点外部收起 / Esc 收起 / 不溢出）全部正常、
解压产物可加载运行。

### 已知遗留（均为人工事项，无法自动化）

| # | 事项 | 说明 |
|---|---|---|
| 1 | v1.2.0 产物人工验收 | 重点看 720×600 真实弹窗下的观感与中文混排 |
| 2 | Spike S-2 真机 CSP 确认 | CodeMirror 6 在 MV3 CSP 下的实机表现；jsdom 不执行 CSP，属纯盲区 |
| 3 | v1.2.0 GitHub Release 发布 | 附件 `json-dialect-dist-v1.2.0.zip` 待上传 |

> AC-37（真机零网络）与 720×600 布局溢出已随 v1.2.0 实测结清，不再列为遗留。

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

---

## 许可

MIT
