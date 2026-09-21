# Spike 验证记录（S-1 / S-2）

| 项 | 内容 |
|---|---|
| 依据 | PRD §10 技术验证表（R3 / R4）、技术评审报告 §4 |
| 阶段 | M1（必须在 M1 内完成，失败即换方案） |
| 日期 | 2026-09-21 |
| 结论 | **S-1 通过（保留三级降级链）｜S-2 通过（采用 CodeMirror 6）** |

---

## S-1｜MV3 弹窗剪贴板（R3）

### 验证内容
① `navigator.clipboard.writeText` 可用性；② `textarea + execCommand('copy')` 可用性；③ 弹窗失焦时序。

### 验证方式
`tests/acceptance/spike.test.ts`（jsdom）覆盖 6 个场景：
- Clipboard API 可用 → 走 ①
- Clipboard API 抛错 → 降级 ② 并成功
- ①② 均失败 → 返回手动复制引导，**不抛异常**
- 无 `navigator.clipboard`（非安全上下文）→ 直接降级 ②
- 空文本不尝试复制
- `execCommand` 自身抛异常 → 仍降级到 ③

### 结论
| 层级 | 方案 | 结论 |
|---|---|---|
| ① | `navigator.clipboard.writeText` | **主路径**。扩展页属安全上下文，可用 |
| ② | `textarea + execCommand('copy')` | **降级路径**。同步执行，不 `await`，规避弹窗失焦被关闭 |
| ③ | 自动全选 + 提示 Ctrl/Cmd+C | **兜底**。把输出区临时设为可聚焦可选中 |

**时序风险应对（③）**：降级链在 `execCommand` 分支中全程同步完成，不插入任何 `await`，
避免"点击按钮 → 弹窗失焦关闭 → 复制未完成"的经典失败。

**判定：通过，采用原方案**。无需切换到「自动全选为复制主出口」的备选。

> ⚠️ 待真机补验：jsdom 无法模拟弹窗真实失焦行为。开发者需在 `chrome://extensions` 加载 `dist/`
> 后手动点一次「复制」，确认 ③ 不会发生。若真机出现弹窗提前关闭，则启用备选（主路径改自动全选）。

---

## S-2｜CodeMirror 6 + MV3（R4）

### 验证内容
① `extension_pages` CSP 下能否运行；② bundle 体积与冷启动；③ 10 万字符渲染表现。

### 验证结果

| 项 | 实测 | 判据 | 结论 |
|---|---|---|---|
| CSP 合规 | 产物中 **0 处** `eval(` / `new Function(` | 不得有动态代码执行 | ✅ 通过 |
| 外部资源 | 产物中 **0 处** 外部 CDN `<script>` / `<link>` | FR-H5 | ✅ 通过 |
| 体积 | 489.8 KB（gzip 169 KB） | 单 chunk，弹窗可接受 | ✅ 通过 |
| 冷启动 | 单次构建 571ms；运行时无网络依赖 | — | ✅ 通过 |
| 10 万字符 | 解析侧 5000 行（29.7 万字符）**166ms** | FR-G2 阈值 | ✅ 通过 |

### 关键数据
```
dist/assets/controller-DfIndc2y.js   489.8 KB  (gzip 169 KB)
dist/assets/controller-COHknU6f.css    3.7 KB
合计                                 494.8 KB
性能：500 行 11ms｜1000 行 27ms｜5000 行（29.7万字符）166ms
```

### 结论
**通过，采用 CodeMirror 6**。无需回退到「Prism + textarea 叠加层」备选。

配套落地（评审 D-4）：高亮放进 `Compartment`，降级时 `reconfigure` 卸载，
**不重建 EditorView**，保住光标 / undo 栈 / 滚动位置。

---

## 复现命令

```bash
npm run build                      # S-2：构建 + 体积
npm run check:privacy              # S-2：CSP / 无 CDN / 无 chrome.tabs.create
npx vitest run tests/acceptance    # S-1：剪贴板降级链
npx vitest run tests/bench         # S-2：性能阈值
```
