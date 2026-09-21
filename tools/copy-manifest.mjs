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

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, raw, 'utf8');
console.log(`manifest.json → dist/（权限：${JSON.stringify(perms)}）`);
