# JSON Dialect

一个**纯本地**的 Chrome 扩展（MV3），用于 **Python 字面量 ↔ 标准 JSON ↔ Java 转义字符串 ↔ `Map.toString()`** 四向互转。

设计取向是「**格式翻译器**」而不是「JSON 校验器」——目标是把眼前这段文本变成能被目标语言直接吃掉的形态，**容错优先，能救就救**。

> **零网络 · 零埋点 · 零落盘。** 全部转换在浏览器本地完成，manifest 仅声明 `["storage"]` 一项权限。

---

## 快速开始

### 作为用户（加载已构建产物）

1. 下载 `json-dialect-dist-v1.0.0.zip` 并解压
2. Chrome 打开 `chrome://extensions/`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择**能直接看到 `manifest.json` 的那一层目录**
4. 点击扩展图标即可使用

> 目录选错一层 Chrome 会拒绝加载，这是最常见的安装失败原因。

### 作为开发者

```bash
npm install

npm run verify:all      # 全量门禁（推荐，见下）
npm run build           # 构建 → dist/
npm run dev             # 若已配置 vite dev（当前未内置）
```

**`npm run verify:all`** 是唯一的发布门禁，串起四项：

| 门禁项 | 内容 | 当前结果 |
|---|---|---|
| `typecheck` | `tsc --noEmit`，严格模式 | 0 错误 |
| `test` | Vitest 全量（8 个文件） | **141 通过 / 0 失败** |
| `verify:python` | 40 个样本用目标语言解释器交叉校验 | 40/40 全部可解析 |
| `check:privacy` | 隐私与权限静态审查 | 通过 |

单跑某一类：`npm run test:unit` / `test:golden` / `test:prop` / `test:ac` / `bench`。

---

## 它能做什么

粘贴一段文本，自动判定来源格式并转成目标语言形态。判定不准可在界面上**手动锁定**来源格式。

| 方向 | 输入示例 | 输出示例 |
|---|---|---|
| Python → JSON | `{'name': '张三', 'vip': True}` | `{"name": "张三", "vip": true}` |
| JSON → Python | `{"a": null, "b": false}` | `{'a': None, 'b': False}` |
| Java 转义 → Python | `"{\"k\":\"v\"}"` | `{'k': 'v'}` |
| `Map.toString()` → Python | `{a=1, b=[x, y]}` | `{'a': 1, 'b': ['x', 'y']}` |

关键行为：

- **精度不丢失**：大整数、`1.0`、`1e5` 原样输出，全程不经过 `Number()`（避免 `12345678901234567890` 被压成 `...567000`）
- **容错修复可见**：单引号补全、尾随逗号、`True/False/None`、注释剥离、未闭合括号……每次修复都在「修正记录」里逐条列出**行列位置与改动前后**
- **报错定位**：解析失败时精确到行列，并在编辑器行号槽标记错误行
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
              ┌─────────┴─────────┐
        toJson(IR)           toPython(IR)
                        │
                        ▼
                    输出文本
```

三层解析**塌缩为一次 tokenize + strict/lenient 开关**——不做多轮文本重写（那会引入修复顺序依赖与行列漂移）。四个 parser 共享同一份 Token 流，所以全格式回退几乎零成本。

### 目录结构

```
src/core/                 纯函数内核（禁止 import 任何浏览器 API / chrome.*）
  ├─ lexer.ts             一次扫描 → Token[]
  ├─ detect.ts            来源格式打分器（信号封顶 + 结构前提）
  ├─ ir.ts                JVal 中间表示（判别联合）
  ├─ parse/               json / python / mapText / javaEsc 四个 parser + engine
  ├─ serialize/           toJson / toPython
  ├─ fixLog.ts            修正记录（源自 token.marks）
  ├─ errors.ts            带行列的错误类型 + 超时控制
  ├─ suggestFormat.ts     格式建议
  └─ index.ts             convert() 统一入口
src/ui/                   界面层（app / popup / editor / controller / clipboard / download …）
tests/                    unit · prop · golden · acceptance · bench + setup
tools/                    copy-manifest.mjs · check-privacy.mjs · emit_outputs.mjs · 样本生成/校验脚本
samples/                  41 组输入样本 + 对应 .out.* 期望输出 + manifest.json 索引
docs/                     全过程文档（见下）
```

### 不可违背的约束

| 约束 | 说明 |
|---|---|
| 纯函数内核 | `src/core/` 不得引用浏览器 API 或 `chrome.*` |
| 输出来源 | 复制 / 下载**必须取 IR 序列化结果**，不取 DOM 文本 |
| 权限最小化 | 仅 `storage`；放大用 `window.open`，**禁用 `chrome.tabs.create`** |
| 存储分工 | 界面偏好 → `storage.local`；跨页会话 → `storage.session`（读后即清） |
| 字符计数 | 按 Unicode 码点 `[...text].length`，不用 `.length` |
| 高亮开关 | 用 CodeMirror 6 `Compartment` 动态卸载，**不重建编辑器**（保光标与 undo 栈） |
| 初始化顺序 | 编辑器创建**必须先于任何 `await`**；所有 `chrome.*` Promise 一律套超时兜底 |

最后一条是真机 P0 缺陷换来的：企业托管 Chrome 下 `chrome.storage` 的 Promise 可能既不 resolve 也不 reject，若 `await` 排在 `createEditor()` 前，界面骨架照常渲染但输入区完全点不动。详见 `docs/05-缺陷/`。

---

## 隐私与安全

本项目把「不联网」当作可验证的硬约束，而不是一句口号：

- manifest 权限白名单**只有 `storage`**，无 `host_permissions`，无 `tabs` / `activeTab` / `scripting` / `cookies` / `webRequest`
- `npm run check:privacy` 静态审查源码与产物：无 `fetch` / `XMLHttpRequest` / `sendBeacon`、无外部 CDN 引用、无 `chrome.tabs.create`
- 构建时关闭 Vite 的 modulepreload polyfill（其内部含 `fetch`），确保产物里不存在任何网络代码路径

⚠️ 静态扫描无法替代运行时观测：**AC-37（真机零网络请求）仍待人工用 DevTools Network 面板确认**。

---

## 文档索引

全过程文档已按阶段归档在 `docs/`：

| 目录 | 内容 |
|---|---|
| `docs/01-需求/` | `需求规格.md`（要什么）、`PRD.md` v1.2（做成什么样算对，含 §8 共 52 条验收标准） |
| `docs/02-评审/` | `技术评审报告.md` v1.0（代码怎么写：架构、IR、目录分层、任务拆分） |
| `docs/03-研发/` | `研发任务清单.md`（4 里程碑 / 28 子任务）、`spike-记录.md`（S-1 剪贴板、S-2 CodeMirror 6） |
| `docs/04-验收/` | `PRD-8-验收标准.md`（AC-01~52 验收依据）、`验收结论报告.md`（逐条结论） |
| `docs/05-缺陷/` | `缺陷7-UI初始化被storage阻塞.md`（真机 P0） |

---

## 当前状态

**v1.0.0 —— M0~M3 四个里程碑、28 个子任务全部完成。**

| 里程碑 | 范围 | 状态 |
|---|---|---|
| M0 | 解析器内核 | ✅ 样本 40/40，交叉校验退出码 0 |
| M1 | 最小可用弹窗 | ✅ S-1 / S-2 spike 通过 |
| M2 | 容错与报错 | ✅ 含嵌套 Map 用例 |
| M3 | 体验打磨 | ✅ |

验收：**52 条 AC 中 51 条自动化通过**，1 条（AC-37）需真机人工确认。

### 已知遗留（均为人工事项，无法自动化）

| # | 事项 | 说明 |
|---|---|---|
| 1 | AC-37 真机零网络请求验证 | 静态扫描已过，须 DevTools Network 面板实机走一遍。**须用缺陷 7 修复后的新产物重验** |
| 2 | Spike S-2 真机确认 | CodeMirror 6 在 MV3 CSP 下的实机表现；jsdom 不执行 CSP，属纯盲区 |
| 3 | 扩展图标 | manifest 中 `icons` 为空对象，加载后显示 Chrome 默认图标（可选补齐） |

---

## 踩过的坑（改动前建议先读）

1. `GutterMarker` / `gutter` / `Decoration` 在 `@codemirror/view`，**不在** `codemirror` 元包。
2. jsdom 缺 `Range.getClientRects`，CodeMirror 6 会抛异常 → `tests/setup/cm6-jsdom.ts` 已补。
3. 错误行高亮别用 `querySelector('.cm-line')[n-1]`（重排会错位），要用 `StateField` + `Decoration`。
4. `Write` 类工具会吃掉 `\"`、`\u0000` 这类字面转义 → 含控制字符的 TS 源码改用 python heredoc 写入。
5. Map 语法里**空白是有效内容**，parser 必须扫描原文，不能用 token 拼接还原。
6. **Vite 不会把根目录的 `manifest.json` 拷进 dist** —— 产物会直接无法加载。`tools/copy-manifest.mjs` 已补上，**任何门禁都测不出这个，只能手验**。
7. `die()` 返回 `never` 但 TS 不推断 → 需 `return die(...)` 或加 `need()` 类型守卫收窄。
8. `await` 任何 `chrome.*` Promise 都可能永不 settle → 必须套超时，且**不得挡在编辑器创建之前**。

---

## 许可

MIT
