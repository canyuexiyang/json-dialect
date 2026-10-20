/** 发布门禁读取当前引擎的产物；不改写黄金样本。 */
import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../src/core/index.ts';

const dir = path.resolve('samples');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const results = manifest.map((sample) => {
  const input = fs.readFileSync(path.join(dir, sample.file), 'utf8');
  const result = convert(input, sample.strippedPrefix ? { strippedPrefix: sample.strippedPrefix } : {});
  const extension = result.outputLang === 'json' ? 'json' : 'py';
  return {
    name: sample.name, status: result.status, language: result.outputLang,
    output: result.output,
    expected: fs.readFileSync(path.join(dir, sample.file.replace('.in.txt', `.out.${extension}`)), 'utf8'),
  };
});
process.stdout.write(JSON.stringify(results));
