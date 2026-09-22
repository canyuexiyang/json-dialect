/**
 * 用当前引擎为 samples/*.in.txt 生成期望输出，供 Python 交叉校验与黄金样本回归使用。
 * 运行：npx vite-node tools/emit_outputs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../src/core/index.ts';

const dir = path.resolve('samples');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

let ok = 0;
let fail = 0;
const report = [];

for (const item of manifest) {
  const text = fs.readFileSync(path.join(dir, item.file), 'utf8');
  // 日志类样本：需先剥离前缀才能解析（FR-D13），剥离动作会记入修正记录
  const r = convert(text, item.strippedPrefix ? { strippedPrefix: item.strippedPrefix } : {});
  const ext = r.outputLang === 'json' ? 'json' : 'py';
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
