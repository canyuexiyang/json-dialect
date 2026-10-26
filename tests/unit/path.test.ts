/**
 * v1.4 路径定位内核验收（AC-89～AC-94 / AC-102 / AC-103 内核侧）
 *
 * 第一条 describe 是**故意放的**：先钉死 Span 语义，再谈算法。
 * 本项目历史上最贵的一次返工就是「拿猜测当事实」（坑 9 / 14 / 15 全是这一类）。
 */

import { describe, it, expect } from 'vitest';
import { formatPath, locate, pathIrFor, supportsPath } from '../../src/core/path.js';
import { convert } from '../../src/core/index.js';
import type { JVal } from '../../src/core/ir.js';

const jsonIr = (text: string): JVal => {
  const ir = pathIrFor(text, 'json');
  if (!ir) throw new Error('解析失败: ' + text);
  return ir;
};

/** 在 needle 首次出现的位置定位 */
function hitAt(text: string, ir: JVal, needle: string, from = 0) {
  const at = text.indexOf(needle, from);
  expect(at, 'needle 未找到: ' + needle).toBeGreaterThanOrEqual(0);
  return locate(ir, text, at);
}

describe('Span 语义（先钉死事实）', () => {
  it('对象 span 覆盖完整字面量（含大括号）', () => {
    const text = '{"a":1}';
    expect(jsonIr(text).span).toMatchObject({ start: 0, end: 7 });
  });

  it('字符串 span 含引号', () => {
    const text = '{"a":1}';
    const ir = jsonIr(text);
    if (ir.k !== 'obj') throw new Error('应为对象');
    const key = ir.entries[0].key;
    expect(text.slice(key.span.start, key.span.end)).toBe('"a"');
  });
});

describe('AC-89 / AC-90 键与值', () => {
  const text = '{"a":1}';

  it('点键 → 该成员路径，标记为键', () => {
    const hit = hitAt(text, jsonIr(text), '"a"');
    expect(hit?.path).toBe('$.a');
    expect(hit?.target).toBe('key');
    expect(hit?.valueKind).toBe('number');
  });

  it('点值 → 同一条路径，标记为值', () => {
    const hit = hitAt(text, jsonIr(text), '1');
    expect(hit?.path).toBe('$.a');
    expect(hit?.target).toBe('value');
  });

  it('键与值路径必须完全一致（决策 D-4）', () => {
    const ir = jsonIr(text);
    expect(hitAt(text, ir, '"a"')?.path).toBe(hitAt(text, ir, '1')?.path);
  });
});

describe('AC-91 嵌套与数组下标', () => {
  it('三层嵌套 + 数组下标', () => {
    const text = '{"a":{"b":[{"c":1}]}}';
    expect(hitAt(text, jsonIr(text), '"c"')?.path).toBe('$.a.b[0].c');
  });

  it('数组元素与容器', () => {
    const text = '{"list":[10,20]}';
    const ir = jsonIr(text);
    expect(hitAt(text, ir, '20')?.path).toBe('$.list[1]');
    expect(hitAt(text, ir, '[')?.path).toBe('$.list');
    expect(hitAt(text, ir, '[')?.target).toBe('container');
  });
});

describe('AC-92 特殊键名退化为方括号', () => {
  it('含点号', () => {
    const text = '{"a.b":1}';
    expect(hitAt(text, jsonIr(text), '1')?.path).toBe("$['a.b']");
  });

  it('中文', () => {
    const text = '{"中文":1}';
    expect(hitAt(text, jsonIr(text), '1')?.path).toBe("$['中文']");
  });

  it('含单引号', () => {
    const text = '{"a\'b":1}';
    expect(hitAt(text, jsonIr(text), '1')?.path).toBe("$['a\\'b']");
  });

  it('含反斜杠', () => {
    const text = String.raw`{"a\\b":1}`;
    expect(hitAt(text, jsonIr(text), '1')?.path).toBe(String.raw`$['a\\b']`);
  });

  it('数字开头与空键', () => {
    expect(formatPath([{ kind: 'key', key: '1st' }])).toBe("$['1st']");
    expect(formatPath([{ kind: 'key', key: '' }])).toBe("$['']");
  });
});

describe('AC-93 顶层形态', () => {
  it('顶层数组', () => {
    const text = '[1,2]';
    expect(hitAt(text, jsonIr(text), '2')?.path).toBe('$[1]');
  });

  it('顶层标量', () => {
    const text = '123';
    expect(hitAt(text, jsonIr(text), '1')?.path).toBe('$');
  });

  it('空对象：点括号得到根容器', () => {
    const text = '{}';
    const hit = hitAt(text, jsonIr(text), '{');
    expect(hit?.path).toBe('$');
    expect(hit?.target).toBe('container');
    expect(hit?.valueKind).toBe('object');
  });

  it('点闭合大括号得到根容器', () => {
    const text = '{"a":1}';
    expect(hitAt(text, jsonIr(text), '}')?.path).toBe('$');
  });
});

describe('AC-94 落在分隔符 / 空白上保持上一次（返回 null）', () => {
  const text = '{"a":1,"b":2}';
  const ir = jsonIr(text);

  it('逗号', () => {
    expect(hitAt(text, ir, ',')).toBeNull();
  });

  it('冒号', () => {
    expect(hitAt(text, ir, ':')).toBeNull();
  });

  it('缩进与换行', () => {
    const pretty = '{\n  "a": 1\n}';
    const pir = jsonIr(pretty);
    expect(locate(pir, pretty, pretty.indexOf('\n'))).toBeNull();
    expect(locate(pir, pretty, pretty.indexOf('  '))).toBeNull();
  });

  it('文末（光标在最后一个字符之后）', () => {
    expect(locate(ir, text, text.length)).toBeNull();
  });

  it('越界偏移不抛异常', () => {
    expect(locate(ir, text, -1)).toBeNull();
    expect(locate(ir, text, 9999)).toBeNull();
  });
});

describe('字符串里的结构字符不算结构', () => {
  it('点字符串内的 { 命中该字符串', () => {
    const text = '{"a":"{"}';
    const hit = hitAt(text, jsonIr(text), '{', 6);
    expect(hit?.path).toBe('$.a');
    expect(hit?.valueKind).toBe('string');
  });

  it('点字符串内的逗号命中该字符串', () => {
    const text = '{"a":"x,y"}';
    const hit = hitAt(text, jsonIr(text), ',');
    expect(hit?.path).toBe('$.a');
  });
});

describe('Python 与 Map 来源（同一份 Span 约定）', () => {
  const py = "{'a': True, 'b': [None, 1]}";

  it('Python 布尔 / None / 数字', () => {
    const ir = pathIrFor(py, 'python');
    expect(locate(ir, py, py.indexOf('True'))?.path).toBe('$.a');
    expect(locate(ir, py, py.indexOf('True'))?.valueKind).toBe('boolean');
    expect(locate(ir, py, py.indexOf('None'))?.path).toBe('$.b[0]');
    expect(locate(ir, py, py.indexOf('1]'))?.path).toBe('$.b[1]');
  });

  it('非字符串键按字符串渲染', () => {
    const text = '{1: 2}';
    const ir = pathIrFor(text, 'python');
    expect(locate(ir, text, text.indexOf('2'))?.path).toBe("$['1']");
  });

  it('Map.toString() 来源可定位', () => {
    const text = '{a=1, list=[{b=2}]}';
    const r = convert(text, { force: 'map' });
    expect(locate(r.ir, text, text.indexOf('2'))?.path).toBe('$.list[0].b');
  });

  it('Map 的 = 视为分隔符', () => {
    const text = '{a=1}';
    const r = convert(text, { force: 'map' });
    expect(locate(r.ir, text, text.indexOf('='))).toBeNull();
  });
});

describe('formatPath 单元', () => {
  it('根', () => {
    expect(formatPath([])).toBe('$');
  });

  it('标识符与下标', () => {
    expect(
      formatPath([
        { kind: 'key', key: 'data' },
        { kind: 'key', key: 'list' },
        { kind: 'index', index: 3 },
        { kind: 'key', key: 'userName' },
      ]),
    ).toBe('$.data.list[3].userName');
  });

  it('$ 与下划线开头的键仍用点号', () => {
    expect(formatPath([{ kind: 'key', key: '$ref' }])).toBe('$.$ref');
    expect(formatPath([{ kind: 'key', key: '_x' }])).toBe('$._x');
  });

  it('含空格走方括号', () => {
    expect(formatPath([{ kind: 'key', key: 'a b' }])).toBe("$['a b']");
  });
});

describe('不可用输入', () => {
  it('无 IR 直接返回 null', () => {
    expect(locate(undefined, '{"a":1}', 1)).toBeNull();
  });

  it('只有 json / python 支持路径（java 坐标系不可映射，FR-P8）', () => {
    expect(supportsPath('json')).toBe(true);
    expect(supportsPath('python')).toBe(true);
    expect(supportsPath('java')).toBe(false);
  });

  it('非法文本解析失败返回 null 而不抛', () => {
    expect(pathIrFor('{"a":1,}', 'json')).toBeNull();
  });
});

describe('AC-102 性能：500k 文档单次定位', () => {
  it('中位耗时 < 16ms（一帧）', () => {
    const rows: string[] = [];
    for (let i = 0; i < 20000; i++) rows.push(`  "key${i}": {"a": ${i}, "b": "value-${i}"}`);
    const text = '{\n' + rows.join(',\n') + '\n}';
    expect(text.length).toBeGreaterThan(500000);
    const ir = jsonIr(text);

    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const offset = text.indexOf('value-15000') + i;
      const t0 = performance.now();
      locate(ir, text, offset);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    // eslint-disable-next-line no-console
    console.log(`  500k 定位中位 ${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(16);
  });
});
