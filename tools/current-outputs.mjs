/**
 * 发布门禁读取当前引擎的产物；不改写黄金样本。
 *
 * v1.5 / D13：转义链路（samples/escape/）也一并输出 —— 4 风格 × 2 方向
 * 从此进入交叉校验门禁，不再只有单元测试自证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../src/core/index.ts';
import { escapeText } from '../src/core/escapeText.ts';

const dir = path.resolve('samples');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const EXT_FOR = { json: 'json', python: 'py', java: 'java' };

const results = manifest.map((sample) => {
  const input = fs.readFileSync(path.join(dir, sample.file), 'utf8');
  const opts = {};
  if (sample.strippedPrefix) opts.strippedPrefix = sample.strippedPrefix;
  if (sample.target) opts.target = sample.target;
  const result = convert(input, opts);
  const extension = EXT_FOR[result.outputLang];
  return {
    kind: 'convert',
    name: sample.name,
    status: result.status,
    language: result.outputLang,
    output: result.output,
    expected: fs.readFileSync(path.join(dir, sample.file.replace('.in.txt', `.out.${extension}`)), 'utf8'),
  };
});

// v1.5 / D13：转义黄金样本
const escapeDir = path.join(dir, 'escape');
const escapeManifest = path.join(escapeDir, 'manifest.json');
if (fs.existsSync(escapeManifest)) {
  const cases = JSON.parse(fs.readFileSync(escapeManifest, 'utf8'));
  for (const c of cases) {
    const r = escapeText(c.input, c.style, c.dir, { wrapQuotes: !!c.wrapQuotes });
    results.push({
      kind: 'escape',
      name: c.id,
      style: c.style,
      dir: c.dir,
      wrapQuotes: !!c.wrapQuotes,
      status: r.ok ? 'ok' : 'error',
      output: r.output,
      expected: c.expected,
      input: c.input,
    });
  }
}

process.stdout.write(JSON.stringify(results));
