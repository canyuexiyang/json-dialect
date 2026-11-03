#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
交叉校验门禁（技术评审 D-5 / FR-A10 / AC-31a）

- 当前引擎输出 → 独立目标语言解析 → 与已保存黄金样本比较语义
- 不覆盖 samples/*.out.*，避免自生成期望值

v1.5 / D14：Java 转义串作为输出目标进入校验 —— 输出是 JSON 字符串常量，
  用两遍 json.loads（外层常量 → 内层结构）拿到语义树再比对。
v1.5 / D13：转义链路（samples/escape/）进入校验 —— encode 结果必须能被
  Python 的 base64 / urllib.parse / json 按目标语义**反解回原文**，
  decode 结果必须与 Python 反解输入一致（目标语言可逆的外部证明）。

退出码 0 = 全部通过；非 0 = 有失败（M0 出口判据之一）。
"""
from __future__ import annotations

import ast
import base64
import json
import os
import sys
import subprocess
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")


def semantic(value):
    """比较类型、顺序和值，避免 True == 1 掩盖类型变化。"""
    if isinstance(value, dict):
        return ("dict", [(semantic(key), semantic(item)) for key, item in value.items()])
    if isinstance(value, (list, tuple)):
        return (type(value).__name__, [semantic(item) for item in value])
    return (type(value).__name__, value)


def parse_output(language, text):
    """按目标语言解析引擎输出。Java 转义串 = JSON 字符串常量 → 两遍解析。"""
    if language == "json":
        return json.loads(text)
    if language == "java":
        return json.loads(json.loads(text))  # 外层常量 → 内层 JSON 结构
    return ast.literal_eval(text)


def strip_quotes(text):
    t = text.strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in ('"', "'"):
        return t[1:-1]
    return t


def verify_escape_case(case, out):
    """转义链路：黄金比对 + Python 独立反解（目标语义可逆证明）。"""
    style, direction = case["style"], case["dir"]
    expected = case["expected"]
    if out != expected:
        return "与黄金样本不一致（引擎 %r ≠ 黄金 %r）" % (out[:40], expected[:40])
    raw_in = case["input"]
    wrapped = bool(case.get("wrapQuotes"))
    if direction == "encode":
        body = strip_quotes(out) if wrapped else out
        if style == "base64":
            ok = base64.b64encode(raw_in.encode("utf-8")).decode("ascii") == body
        elif style == "url":
            ok = urllib.parse.quote(raw_in, safe="") == body
        else:  # json / java（共用实现）
            ok = json.loads('"' + body + '"') == raw_in
        if not ok:
            return "encode 结果无法被 Python 按目标语义反解回原文"
    else:
        body = strip_quotes(raw_in)
        if style == "base64":
            ok = base64.b64decode(body).decode("utf-8") == out
        elif style == "url":
            ok = urllib.parse.unquote(body) == out
        else:
            ok = json.loads('"' + body + '"') == out
        if not ok:
            return "decode 结果与 Python 反解输入不一致"
    return None


def main() -> int:
    if not os.path.isdir(SAMPLES):
        print("samples/ 目录不存在，请先运行 tools/gen_samples.py")
        return 1

    failures: list[str] = []
    checked = 0
    escape_checked = 0

    generated = subprocess.run(
        ["node", os.path.join(ROOT, "node_modules/vite-node/vite-node.mjs"), "tools/current-outputs.mjs"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    for result in json.loads(generated.stdout):
        checked += 1
        name = result["name"]
        if result["kind"] == "escape":
            escape_checked += 1
            if result["status"] != "ok":
                failures.append("%s: 转义失败 (%s)" % (name, result["status"]))
                continue
            err = verify_escape_case(result, result["output"])
            if err:
                failures.append("%s: %s" % (name, err))
            continue

        if result["status"] in ("error", "timeout", "empty"):
            failures.append("%s: 当前引擎转换失败 (%s)" % (name, result["status"]))
            continue
        try:
            actual = parse_output(result["language"], result["output"])
            expected = parse_output(result["language"], result["expected"])
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

    print(
        "交叉校验通过：%d 个当前输出全部通过目标语言解析与黄金样本语义比对"
        "（含转义链路 %d 条）" % (checked, escape_checked)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
