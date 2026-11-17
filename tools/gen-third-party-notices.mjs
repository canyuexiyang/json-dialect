/**
 * 生成 / 校验第三方组件许可清单（THIRD-PARTY-NOTICES.md）。
 *
 * 只统计**生产依赖**：devDependencies（Vite / Vitest / jsdom / puppeteer 等）
 * 不随扩展产物分发，列入反而会误导使用者。依赖树以当前 node_modules 为准，
 * 版本由 package-lock.json 锁定，因此同一 lockfile 生成的内容可重复。
 *
 * 用法：
 *   node tools/gen-third-party-notices.mjs           # 写入 THIRD-PARTY-NOTICES.md
 *   node tools/gen-third-party-notices.mjs --check   # 只校验文件是否最新（门禁用）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'THIRD-PARTY-NOTICES.md');
const checkOnly = process.argv.includes('--check');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 用 npm 的 parseable 输出拿到「真实会被安装的生产依赖树」 */
function productionDirs() {
  let out = '';
  try {
    out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // extraneous / peer 警告会让 npm ls 以非 0 退出，stdout 仍是完整依赖树。
    out = String(error.stdout ?? '');
    if (!out.trim()) throw error;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function licenseFile(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((name) => /^(licen[cs]e|copying)(\..*)?$/i.test(name));
  return hit ? path.join(dir, hit) : null;
}

function copyrightLines(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(copyright|©|\(c\))/i.test(line));
  return [...new Set(lines)];
}

/** 去掉版权行与标题行后的许可正文，用于判断同一种许可证的正文是否一致 */
function licenseBody(text) {
  return text
    .split('\n')
    .filter((line) => !/^(copyright|©|\(c\))/i.test(line.trim()))
    .filter((line) => !/^(the )?mit license\.?$/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeRepo(value) {
  if (!value) return '';
  const raw = typeof value === 'string' ? value : value.url;
  if (!raw) return '';
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/');
}

function collect() {
  const rootPkg = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const lockPackages = lock.packages ?? {};
  const seen = new Set();
  const packages = [];

  for (const dir of productionDirs()) {
    if (path.resolve(dir) === root) continue;
    // 只认 lockfile 里标记为生产依赖的路径：本地残留的 extraneous 包
    // 不应混进对外许可声明。
    const rel = path.relative(root, dir).split(path.sep).join('/');
    const entry = lockPackages[rel];
    if (!entry || entry.dev === true) continue;
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    const pkg = readJson(pkgFile);
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const lf = licenseFile(dir);
    const licenseText = lf ? fs.readFileSync(lf, 'utf8').trim() : '';
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN',
      repo: normalizeRepo(pkg.repository) || pkg.homepage || '',
      copyright: copyrightLines(licenseText),
      licenseText,
    });
  }

  if (packages.length === 0) {
    throw new Error('未发现生产依赖；请先执行 npm install');
  }
  packages.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { rootPkg, packages };
}

function render({ rootPkg, packages }) {
  const rows = packages.map((pkg) => {
    const copyright = pkg.copyright.length ? pkg.copyright.join('<br>') : '（见许可正文）';
    const name = pkg.repo ? `[${pkg.name}](${pkg.repo})` : pkg.name;
    return `| ${name} | ${pkg.version} | ${pkg.license} | ${copyright} |`;
  });

  const groups = new Map();
  for (const pkg of packages) {
    const body = licenseBody(pkg.licenseText || `${pkg.license}（未随包提供 LICENSE 文件）`);
    const key = `${pkg.license}\u0000${body}`;
    if (!groups.has(key)) {
      groups.set(key, { license: pkg.license, body, names: [] });
    }
    groups.get(key).names.push(`${pkg.name} ${pkg.version}`);
  }

  const licenseSections = [];
  let index = 0;
  for (const group of groups.values()) {
    index += 1;
    licenseSections.push(
      `### ${group.license}${groups.size > 1 ? `（正文 ${index}）` : ''}`,
      '',
      `适用于：${group.names.join('、')}。`,
      '',
      '```text',
      group.body,
      '```',
      '',
    );
  }

  return `# 第三方组件许可声明

本项目（${rootPkg.name} ${rootPkg.version}）的构建产物包含下列第三方组件。
本文件由 \`npm run notices\` 依据当前 \`package-lock.json\` 与已安装的 **生产依赖** 生成，
请勿手工编辑；升级依赖后运行 \`npm run notices\` 重新生成。

> \`devDependencies\`（Vite / Vitest / jsdom / TypeScript 等）只用于开发与测试，
> 不随扩展产物分发，因此不列入。各组件的版权声明依据其随包 \`LICENSE\` 文件提取；
> 许可证正文见文末，版权行以上表为准。

## 组件清单

| 组件 | 版本 | 许可证 | 版权声明 |
|---|---|---|---|
${rows.join('\n')}

## 许可证正文

${licenseSections.join('\n')}`.replace(/\n{3,}/g, '\n\n');
}

const content = render(collect());
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (checkOnly) {
  if (current !== content) {
    console.error('THIRD-PARTY-NOTICES.md 已过期，请运行 `npm run notices` 重新生成。');
    process.exit(1);
  }
  console.log(`第三方许可清单校验通过（${content.split('\n').length} 行，与生产依赖一致）`);
} else if (current === content) {
  console.log('THIRD-PARTY-NOTICES.md 已是最新，无需改写');
} else {
  fs.writeFileSync(OUT, content);
  console.log(`已写入 THIRD-PARTY-NOTICES.md（${content.split('\n').length} 行）`);
}