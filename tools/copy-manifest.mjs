/**
 * 把 manifest.json 复制到构建产物目录。
 *
 * Vite 只处理 HTML 入口及其资源依赖，不会自动带上 manifest.json ——
 * 缺了它 dist/ 就无法被 Chrome 作为扩展加载。这一步必须在 build 之后执行。
 */

import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('manifest.json');
const dst = path.resolve('dist', 'manifest.json');

if (!fs.existsSync(src)) {
  console.error('缺少 manifest.json');
  process.exit(1);
}

const raw = fs.readFileSync(src, 'utf8');
// 顺手做一次权限白名单断言，避免产物里混进越权声明（AC-34）
const manifest = JSON.parse(raw);
const allowed = new Set(['storage']);
const perms = manifest.permissions ?? [];
const bad = perms.filter((p) => !allowed.has(p));
if (bad.length > 0) {
  console.error(`manifest 声明了非白名单权限：${bad.join(', ')}`);
  process.exit(1);
}
for (const key of ['host_permissions']) {
  if (manifest[key]) {
    console.error(`manifest 不应包含 ${key}（AC-34）`);
    process.exit(1);
  }
}

// 顺带拷贝 icons/（FR-J1）。Vite 同样不会带它们 —— 只拷 manifest 而漏掉图标，
// Chrome 加载时会在扩展管理页报「无法加载图标」，而任何测试都测不出来。
const iconSrc = path.resolve('icons');
const iconDst = path.resolve('dist', 'icons');
let iconCount = 0;
if (fs.existsSync(iconSrc)) {
  fs.mkdirSync(iconDst, { recursive: true });
  for (const f of fs.readdirSync(iconSrc)) {
    if (!f.endsWith('.png')) continue;
    fs.copyFileSync(path.join(iconSrc, f), path.join(iconDst, f));
    iconCount++;
  }
}
// 断言：manifest 声明的图标文件必须真的存在于产物里
for (const [, rel] of Object.entries(manifest.icons ?? {})) {
  const abs = path.resolve('dist', rel);
  if (!fs.existsSync(abs)) {
    console.error(`manifest 声明的图标缺失于产物：${rel}`);
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, raw, 'utf8');
console.log(`manifest.json → dist/（权限：${JSON.stringify(perms)}，图标 ${iconCount} 个）`);
