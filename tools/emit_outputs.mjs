/**
 * 用当前引擎为 samples/*.in.txt 生成期望输出，供 Python 交叉校验与黄金样本回归使用。
 * 运行：npx vite-node tools/emit_outputs.mjs
 *
 * v1.5 / D14：条目可带 `target`（'json'|'python'|'java'），生成对应后缀的黄金输出
 * （.out.json / .out.py / .out.java）—— Java 转义串从此有了外部可校验的目标矩阵样本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../src/core/index.ts';

const dir = path.resolve('samples');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

const EXT_FOR = { json: 'json', python: 'py', java: 'java' };

let ok = 0;
let fail = 0;
const report = [];

for (const item of manifest) {
  const text = fs.readFileSync(path.join(dir, item.file), 'utf8');
  // 日志类样本：需先剥离前缀才能解析（FR-D13），剥离动作会记入修正记录
  const opts = {};
  if (item.strippedPrefix) opts.strippedPrefix = item.strippedPrefix;
  if (item.target) opts.target = item.target;
  const r = convert(text, opts);
  const ext = EXT_FOR[r.outputLang];
  const outFile = item.file.replace('.in.txt', '.out.' + ext);
  fs.writeFileSync(path.join(dir, outFile), r.output, 'utf8');
  if (r.status === 'error' || r.status === 'empty') {
    fail++;
    report.push(`${item.name}: FAIL(${r.status}) ${r.error?.message ?? ''}`);
  } else {
    ok++;
    report.push(`${item.name}: ok  source=${r.source} lang=${r.outputLang} fixes=${r.fixes.length}`);
  }
}

console.log(report.join('\n'));
console.log(`\n通过 ${ok} / ${manifest.length}`);
fs.writeFileSync(path.join(dir, 'report.txt'), report.join('\n'), 'utf8');
process.exit(fail > 0 ? 1 : 0);
