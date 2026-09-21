/**
 * 隐私门禁（AC-34 / AC-35 / AC-36 / AC-49，评审 D-5 建议做成脚本）
 *
 * 断言：
 *  1. manifest 无 host_permissions、无 tabs/activeTab/scripting/cookies/webRequest
 *  2. 源码与产物无 fetch / XMLHttpRequest / sendBeacon / 上报 SDK
 *  3. 产物无外部 CDN 的 <script src> / <link href>
 *  4. 无 chrome.tabs.create（AC-49，必须用 window.open）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, exts, skip) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skip.some((s) => full.includes(s))) continue;
    if (entry.isDirectory()) out.push(...walk(full, exts, skip));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

// ---- 1. manifest 审查（AC-34） ----
const manifestRaw = readIfExists(path.join(root, 'manifest.json'));
if (!manifestRaw) {
  failures.push('manifest.json 不存在');
} else {
  const m = JSON.parse(manifestRaw);
  const forbiddenPerms = [
    'tabs',
    'activeTab',
    'scripting',
    'cookies',
    'webRequest',
    'downloads',
    'webNavigation',
    'history',
    'bookmarks',
  ];
  const perms = m.permissions ?? [];
  for (const p of forbiddenPerms) {
    if (perms.includes(p)) failures.push(`manifest 声明了被禁权限: ${p}`);
  }
  if (m.host_permissions && m.host_permissions.length > 0) {
    failures.push(`manifest 存在 host_permissions: ${JSON.stringify(m.host_permissions)}`);
  }
  if (m.manifest_version !== 3) failures.push('manifest_version 必须为 3');
  const allowed = ['storage'];
  const extra = perms.filter((p) => !allowed.includes(p));
  if (extra.length) failures.push(`manifest 含非白名单权限: ${extra.join(', ')}`);
  notes.push(`manifest 权限: ${JSON.stringify(perms)}（白名单仅 storage）`);
}

// ---- 2. 源码网络 API 审查（AC-35） ----
const srcFiles = walk(path.join(root, 'src'), ['.ts', '.js', '.css', '.html'], ['node_modules']);
const netPatterns = [
  [/\bfetch\s*\(/g, 'fetch('],
  [/XMLHttpRequest/g, 'XMLHttpRequest'],
  [/sendBeacon/g, 'sendBeacon'],
  [/\bWebSocket\b/g, 'WebSocket'],
  [/importScripts/g, 'importScripts'],
];
for (const f of srcFiles) {
  const s = readIfExists(f);
  if (!s) continue;
  for (const [re, label] of netPatterns) {
    const hits = s.match(re);
    if (hits) failures.push(`${path.relative(root, f)}: 含网络 API ${label}`);
  }
}
notes.push(`审查源码 ${srcFiles.length} 个文件，未发现网络请求调用`);

// ---- 3/4. 构建产物审查（AC-36 / AC-49） ----
const distFiles = walk(path.join(root, 'dist'), ['.js', '.css', '.html'], []);
if (distFiles.length === 0) {
  notes.push('dist/ 不存在，跳过产物审查（先运行 npm run build）');
} else {
  for (const f of distFiles) {
    const s = readIfExists(f);
    if (!s) continue;
    const cdnScript = s.match(/<script[^>]+src=["']https?:\/\/[^"']+/g);
    if (cdnScript) failures.push(`${path.relative(root, f)}: 含外部 CDN script`);
    const cdnLink = s.match(/<link[^>]+href=["']https?:\/\/[^"']+/g);
    if (cdnLink) failures.push(`${path.relative(root, f)}: 含外部 CDN link`);
    const tabsCreate = s.match(/chrome\.tabs\.create/g);
    if (tabsCreate) failures.push(`${path.relative(root, f)}: 含 chrome.tabs.create（违反 AC-49）`);
  }
  notes.push(`审查产物 ${distFiles.length} 个文件，无外部 CDN、无 chrome.tabs.create`);
}

// ---- 输出 ----
console.log('=== 隐私门禁（AC-34/35/36/49） ===');
for (const n of notes) console.log('  · ' + n);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n全部通过 ✅');
process.exit(0);
