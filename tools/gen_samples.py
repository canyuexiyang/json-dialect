#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 samples/ 30 条真实样本（PRD §9.1 北极星「一次搞定率」回归集）

体检提示：当前黄金样本集是 67 convert + 16 escape = 83 条，manifest 含
format / target / strippedPrefix 等本脚本不写的字段。直接运行本脚本会把
samples/manifest.json 打回 30 条并覆盖同名 .in.txt，因此默认拒绝执行；
只有明确 `--force` 才允许覆盖（用于从零重建历史回归集）。
"""
import io
import os
import sys
import json

SAMPLES = [
    ("py_simple", "python", "{'name': '张三', 'age': 18, 'vip': True}"),
    ("py_bool_none", "python", "{'a': False, 'b': None, 'c': True}"),
    ("json_tri", "json", '{"a": null, "b": false, "c": true}'),
    ("py_bigint", "python", "{'id': 12345678901234567890}"),
    ("py_float", "python", "{'rate': 1.0, 'sci': 1e5}"),
    ("py_order", "python", "{'z': 1, 'a': 2, 'm': 3}"),
    ("json_quote1", "json", '{"msg": "it\'s ok"}'),
    ("py_quote2", "python", "{'msg': 'say \"hi\"'}"),
    ("json_quote3", "json", '{"msg": "it\'s \\"x\\""}'),
    ("json_newline", "json", '{"msg": "a\\nb"}'),
    ("map_basic", "map", "{name=张三, age=18, active=true}"),
    ("java_esc", "java", '"{\\"name\\": \\"张三\\", \\"age\\": 18}"'),
    ("json_cjk", "json", '{"name": "张三"}'),
    ("map_eq_in_val", "map", "{url=a=b}"),
    ("json_escaped", "json", '{"msg": "he said \\"hi\\""}'),
    ("arr_plain", "json", "[1, 2, 3]"),
    ("py_trailing", "python", "{'a': 1, }"),
    ("py_bare_key", "python", "{name: 'x'}"),
    ("py_comment", "python", "{'a': 1, 'b': 2}  # 备注"),
    ("map_nested", "map", "{user={name=张三, age=18}}"),
    ("map_arr_obj", "map", "{list=[{b=1}, {c=2}]}"),
    ("map_empty", "map", "{a=[], b={}}"),
    ("map_arr_arr", "map", "{m=[[1, 2], [3, 4]]}"),
    ("json_dupkey", "json", '{"a": 1, "a": 2}'),
    ("py_nan", "python", "{'x': nan, 'y': inf}"),
    ("py_numkey", "python", "{1: 'a'}"),
    ("py_tuple", "python", "{'t': (1, 2, 3)}"),
    ("json_deep", "json", '{"a": {"b": {"c": [1, 2, {"d": "x"}]}}}'),
    ("py_mixed", "python", "{'list': [1, 'two', 3.0, True, None]}"),
    ("json_emoji", "json", '{"a": "\U0001f642", "b": "中文"}'),
]


def main():
    force = "--force" in sys.argv[1:]
    if os.path.exists("samples/manifest.json") and not force:
        raise SystemExit(
            "拒绝覆盖现有 samples/manifest.json（当前 83 条黄金样本）。"
            "如确需从零重建 30 条历史样本，请显式运行：python3 tools/gen_samples.py --force"
        )
    os.makedirs("samples", exist_ok=True)
    manifest = []
    for name, fmt, text in SAMPLES:
        with io.open("samples/%s.in.txt" % name, "w", encoding="utf-8") as f:
            f.write(text)
        manifest.append({"name": name, "format": fmt, "file": "%s.in.txt" % name})
    with io.open("samples/manifest.json", "w", encoding="utf-8") as f:
        f.write(json.dumps(manifest, ensure_ascii=False, indent=2))
    print("wrote %d samples" % len(SAMPLES))


if __name__ == "__main__":
    main()
