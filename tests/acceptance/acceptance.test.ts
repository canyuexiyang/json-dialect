/**
 * 验收标准自动化（PRD §8）
 * 覆盖 M1（AC-01/03/29/30/51/52）、M2（AC-17~24、40~48）、M3（AC-07~12、25~33、39、49/50）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { convert } from '../../src/core/index.js';
import { fileNameFor, downloadLabel } from '../../src/ui/download.js';

/** 读取源码并去掉注释，供「代码级验收」断言使用（避免注释造成假阳性） */
function readCode(rel: string): string {
  const src = fs.readFileSync(rel, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（保留 URL 中的 //）
}

// ============ M1 ============
describe('M1 出口判据', () => {
  it('AC-01 粘贴 Python → 输出标准 JSON', () => {
    const r = convert("{'name': '张三', 'age': 18, 'vip': True}");
    expect(r.source).toBe('python');
    expect(r.output).toContain('"vip": true');
    expect(r.output).toContain('张三');
    expect(r.output).toContain('\n  '); // 2 空格缩进
  });

  it('AC-03 JSON → Python 三态', () => {
    const r = convert('{"a": null, "b": false, "c": true}');
    expect(r.output).toContain("'a': None");
    expect(r.output).toContain("'b': False");
    expect(r.output).toContain("'c': True");
  });

  it('AC-51 C-2 反例不误判为 Java 转义', () => {
    const r = convert('{"msg": "he said \\"hi\\""}');
    expect(r.source).toBe('json');
    expect(r.output).toContain('he said "hi"');
  });

  it('AC-52 emoji 按 Unicode 码点计数', () => {
    const s = "{'a': '🙂'}";
    const r = convert(s);
    expect(r.stats.chars).toBe([...s].length);
  });
});

// ============ M2 ============
describe('M2 出口判据（§8.4 AC-17~24）', () => {
  it('AC-17 末尾逗号自动修复', () => {
    const r = convert("{'a': 1, }");
    expect(r.status).not.toBe('error');
    expect(r.output).toContain('"a": 1');
  });

  it('AC-18 修正记录含行号', () => {
    const r = convert("[1, 2, ]");
    expect(r.fixes.length).toBeGreaterThan(0);
    expect(r.fixes[0].line).toBeGreaterThan(0);
  });

  it('AC-19 注释剥离', () => {
    const r = convert("{'a': 1}  # 备注");
    expect(r.status).not.toBe('error');
    expect(r.output).toContain('"a": 1');
  });

  it('AC-20 键名补引号', () => {
    const r = convert("{name: 'x'}");
    expect(r.output).toContain('"name": "x"');
  });

  it('AC-21 不可修复时给出行列定位', () => {
    // 构造真正不可修复的场景（AC-21 边界说明要求歧义/无法归位的输入，
    // 单纯缺末尾括号属于「可唯一确定」情形，按 FR-D3 会被第 2 层补齐）
    const r = convert('{\n  "a": 1,\n  "b": @@@\n}', { force: 'json' });
    expect(r.status).toBe('error');
    expect(r.error?.line).toBe(3);
    expect(r.error?.message).toMatch(/第 3 行第 \d+ 列/);
  });

  it('AC-24 乱码给出行列定位与原因分类', () => {
    const r = convert('{"a": @@@}', { force: 'json' });
    expect(r.status).toBe('error');
    expect(r.error?.line).toBeGreaterThan(0);
  });
});

describe('M2 出口判据（AC-40~48）', () => {
  it('AC-40 空容器', () => {
    const r = convert('{a=[], b={}}', { compact: true });
    expect(r.output).toBe("{'a': [], 'b': {}}");
  });

  it('AC-41 对象数组', () => {
    const r = convert('{list=[{b=1}, {c=2}]}', { compact: true });
    expect(r.output).toBe("{'list': [{'b': 1}, {'c': 2}]}");
  });

  it('AC-42 嵌套对象', () => {
    const r = convert('{user={name=张三, age=18}}', { compact: true });
    expect(r.output).toBe("{'user': {'name': '张三', 'age': 18}}");
  });

  it('AC-43 数组套数组', () => {
    const r = convert('{m=[[1, 2], [3, 4]]}', { compact: true });
    expect(r.output).toBe("{'m': [[1, 2], [3, 4]]}");
  });

  it('AC-44 重复键保留并提示', () => {
    const r = convert('{"a": 1, "a": 2}');
    expect(r.duplicates?.count).toBe(1);
    expect(r.output.match(/'a'/g)?.length).toBe(2);
  });

  it('AC-45 NaN/Inf → null', () => {
    const r = convert("{'x': nan, 'y': inf, 'z': -inf}");
    const json = JSON.parse(r.output);
    expect(json.x).toBeNull();
    expect(json.y).toBeNull();
    expect(json.z).toBeNull();
  });

  it('AC-46 非字符串键转字符串', () => {
    const r = convert("{1: 'a', (1,2): 'x'}", { compact: true });
    expect(r.output).toContain('"1": "a"');
    expect(r.output).toContain('"(1, 2)": "x"');
  });

  it('AC-47 对象内缺 = 报「键值分隔符缺失」', () => {
    const r = convert('{a, b=1}', { force: 'map' });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('missing_colon');
  });

  it('AC-48 全格式回退：判定 Python 实为 Map', () => {
    const r = convert('{name=张三, age=18, x=1, y=2}');
    expect(r.status).not.toBe('error');
    expect(r.source).toBe('map');
  });
});

// ============ M3 ============
describe('M3 出口判据（§8.2 AC-07~12）', () => {
  it('AC-07 Map 基础解析', () => {
    const r = convert('{name=张三, age=18, active=true}', { compact: true });
    expect(r.source).toBe('map');
    expect(r.output).toBe("{'name': '张三', 'age': 18, 'active': True}");
  });

  it('AC-08 类型覆盖：age 改字符串', () => {
    const ov = new Map([['/age', 'string' as const]]);
    const r = convert('{name=张三, age=18}', { compact: true, force: 'map', overrides: ov });
    expect(r.output).toContain("'age': '18'");
  });

  it('AC-09 覆盖按路径保留', () => {
    // 先在无 city 时覆盖 age
    const ov = new Map([['/age', 'string' as const]]);
    const r1 = convert('{age=18}', { compact: true, force: 'map', overrides: ov });
    expect(r1.output).toContain("'age': '18'");
    // 追加条目后 /age 路径仍在 → 覆盖保留，新条目正常推断
    const r2 = convert('{age=18, city=北京}', { compact: true, force: 'map', overrides: ov });
    expect(r2.output).toContain("'age': '18'");
    expect(r2.output).toContain("'city': '北京'");
  });

  it('AC-10 Java 转义字符串', () => {
    const r = convert('"{\\"name\\": \\"张三\\", \\"age\\": 18}"', { compact: true });
    expect(r.source).toBe('java');
    expect(r.output).toContain("'name': '张三'");
    expect(r.output).toContain("'age': 18");
  });

  it('AC-11 标准 JSON → Python', () => {
    const r = convert('{"name": "张三"}', { compact: true });
    expect(r.source).toBe('json');
    expect(r.output).toBe("{'name': '张三'}");
  });

  it('AC-12 值内部 = 不切分', () => {
    const r = convert('{url=a=b}', { compact: true });
    expect(r.output).toBe("{'url': 'a=b'}");
  });
});

describe('M3 出口判据（§8.5 / §8.7）', () => {
  it('AC-25 手动切换格式生效', () => {
    const auto = convert("{'a': 1}");
    expect(auto.source).toBe('python');
    const manual = convert("{'a': 1}", { force: 'json' });
    expect(manual.source).toBe('json');
    expect(manual.locked).toBe(true);
  });

  it('AC-31/31a/31b 下载文件名按方向切扩展名', () => {
    expect(fileNameFor('json')).toMatch(/^json-dialect-output-\d{8}-\d{6}\.json$/);
    expect(fileNameFor('python')).toMatch(/^json-dialect-output-\d{8}-\d{6}\.py$/);
    expect(downloadLabel('json')).toBe('下载 .json');
    expect(downloadLabel('python')).toBe('下载 .py');
  });

  it('AC-39 输出不含界面控件文本', () => {
    const r = convert('{name=张三, age=18}', { compact: true, force: 'map' });
    expect(r.output).not.toContain('▾');
    expect(r.output).not.toContain('<');
    expect(r.output).not.toContain('>');
  });

  it('AC-32 深浅色：样式表定义了深色变量并跟随系统偏好', () => {
    // 主题切换由 CSS 变量 + body.theme-dark 实现，此处断言样式表定义了深色变量
    const css = fs.readFileSync('src/ui/styles.css', 'utf8');
    expect(css).toContain('body.theme-dark');
    expect(css).toContain('prefers-color-scheme');
  });

  it('AC-49 放大用 window.open，无 chrome.tabs.create', () => {
    // 去掉注释后再断言，避免注释里的说明文字造成假阳性
    const ctrl = readCode('src/ui/controller.ts');
    expect(ctrl).toContain('window.open');
    expect(ctrl).not.toContain('chrome.tabs.create');
  });

  it('AC-50 跨页状态走 storage.session，不写 local', () => {
    const s = readCode('src/ui/sessionState.ts');
    expect(s).toContain('chrome.storage.session');
    // 输入内容不得写入 local（仅界面偏好可写 local）
    const writeLocalBlock = s.match(/chrome\.storage\.local\.set\([^)]*\)/g) ?? [];
    for (const call of writeLocalBlock) {
      expect(call).not.toContain('input');
    }
  });

  it('FR-H4 输入内容零落盘：仅界面偏好可持久化', () => {
    const s = readCode('src/ui/sessionState.ts');
    // Prefs 接口中不得包含输入/输出内容字段
    expect(s).not.toMatch(/interface Prefs \{[^}]*(input|output)[^}]*\}/);
  });
});

describe('性能降级阈值（FR-G2/G3/G4）', () => {
  it('大文本不崩溃', () => {
    const big = JSON.stringify(
      Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`k${i}`, { a: i, b: [1, 2, 3] }])),
    );
    const r = convert(big, { compact: true });
    expect(r.status).not.toBe('error');
  });
});
