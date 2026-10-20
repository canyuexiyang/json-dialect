#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
交叉校验门禁（技术评审 D-5 / FR-A10 / AC-31a）

- 当前引擎输出 → 独立目标语言解析 → 与已保存黄金样本比较语义
- 不覆盖 samples/*.out.*，避免自生成期望值

退出码 0 = 全部通过；非 0 = 有失败（M0 出口判据之一）。
"""
from __future__ import annotations

import ast
import json
import os
import sys
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")


def semantic(value):
    """比较类型、顺序和值，避免 True == 1 掩盖类型变化。"""
    if isinstance(value, dict):
        return ("dict", [(semantic(key), semantic(item)) for key, item in value.items()])
    if isinstance(value, (list, tuple)):
        return (type(value).__name__, [semantic(item) for item in value])
    return (type(value).__name__, value)


def main() -> int:
    if not os.path.isdir(SAMPLES):
        print("samples/ 目录不存在，请先运行 tools/gen_samples.py")
        return 1

    failures: list[str] = []
    checked = 0

    generated = subprocess.run(
        ["node", os.path.join(ROOT, "node_modules/vite-node/vite-node.mjs"), "tools/current-outputs.mjs"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    for result in json.loads(generated.stdout):
        checked += 1
        name = result["name"]
        if result["status"] in ("error", "timeout", "empty"):
            failures.append("%s: 当前引擎转换失败 (%s)" % (name, result["status"]))
            continue
        try:
            parse = json.loads if result["language"] == "json" else ast.literal_eval
            actual = parse(result["output"])
            expected = parse(result["expected"])
            if semantic(actual) != semantic(expected):
                failures.append("%s: 当前输出与黄金样本的值不一致" % name)
        except Exception as exc:  # noqa: BLE001
            failures.append("%s: 目标语言解析失败 -> %s" % (name, exc))

    if checked == 0:
        print("没有找到任何 .out.py / .out.json，请先运行 tools/emit_outputs.mjs")
        return 1

    if failures:
        print("交叉校验失败 %d / %d：" % (len(failures), checked))
        for f in failures:
            print("  - " + f)
        return 1

    print("交叉校验通过：%d 个当前输出全部通过目标语言解析与黄金样本语义比对" % checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
