#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
交叉校验门禁（技术评审 D-5 / FR-A10 / AC-31a）

- samples/*.out.py  → 必须能被 ast.literal_eval 求值
- samples/*.out.json → 必须能被 json.loads 解析

退出码 0 = 全部通过；非 0 = 有失败（M0 出口判据之一）。
"""
from __future__ import annotations

import ast
import glob
import json
import os
import sys
import io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")


def main() -> int:
    if not os.path.isdir(SAMPLES):
        print("samples/ 目录不存在，请先运行 tools/gen_samples.py")
        return 1

    failures: list[str] = []
    checked = 0

    for path in sorted(glob.glob(os.path.join(SAMPLES, "*.out.py"))):
        name = os.path.basename(path)
        text = io.open(path, encoding="utf-8").read()
        checked += 1
        try:
            ast.literal_eval(text)
        except Exception as exc:  # noqa: BLE001
            failures.append("%s: ast.literal_eval 失败 -> %s" % (name, exc))

    for path in sorted(glob.glob(os.path.join(SAMPLES, "*.out.json"))):
        name = os.path.basename(path)
        text = io.open(path, encoding="utf-8").read()
        checked += 1
        try:
            json.loads(text)
        except Exception as exc:  # noqa: BLE001
            failures.append("%s: json.loads 失败 -> %s" % (name, exc))

    if checked == 0:
        print("没有找到任何 .out.py / .out.json，请先运行 tools/emit_outputs.mjs")
        return 1

    if failures:
        print("交叉校验失败 %d / %d：" % (len(failures), checked))
        for f in failures:
            print("  - " + f)
        return 1

    print("交叉校验通过：%d 个输出文件全部可被目标语言解析" % checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
