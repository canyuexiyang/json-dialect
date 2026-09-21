import { describe, it, expect } from 'vitest';
import { convert } from '../../src/core/index.js';
import { lex } from '../../src/core/lexer.js';
import { detect } from '../../src/core/detect.js';
import { pickPythonQuote, encodePythonString, encodeJsonString, decodeStringBody } from '../../src/core/escape.js';
import { computeStats } from '../../src/core/index.js';
import { suggestFormats } from '../../src/core/suggestFormat.js';

describe('M0-1 lexer', () => {
  it('产出带行列位置的 Token 流', () => {
    const r = lex("{\n  'a': 1\n}");
    const first = r.tokens.find((t) => t.type === 'string')!;
    expect(first.line).toBe(2);
    expect(first.col).toBeGreaterThan(0);
  });

  it('字符串内部的 True/null/= 不产生独立 token', () => {
    const r = lex('{"a": "True=null"}');
    const idents = r.tokens.filter((t) => t.type === 'ident');
    expect(idents).toHaveLength(0);
  });

  it('# 注释被识别为 comment token', () => {
    const r = lex("{'a': 1}  # 备注");
    expect(r.tokens.some((t) => t.type === 'comment')).toBe(true);
  });
});

describe('M0-2/3/4 核心规则（§8.1 AC-01~06）', () => {
  it('AC-01 单引号 + True → 标准 JSON', () => {
    const r = convert("{'name': '张三', 'age': 18, 'vip': True}");
    expect(r.source).toBe('python');
    expect(r.output).toContain('"vip": true');
    expect(r.output).toContain('张三'); // FR-A7 中文不转义
  });

  it('AC-02 False / None → false / null', () => {
    const r = convert("{'a': False, 'b': None}");
    expect(r.output).toContain('"a": false');
    expect(r.output).toContain('"b": null');
  });

  it('AC-03 JSON → Python 三态', () => {
    const r = convert('{"a": null, "b": false, "c": true}');
    expect(r.output).toBe("{\n  'a': None,\n  'b': False,\n  'c': True\n}");
  });

  it('AC-04 大整数精度不丢失', () => {
    const r = convert("{'id': 12345678901234567890}");
    expect(r.output).toContain('12345678901234567890');
    expect(r.output).not.toContain('12345678901234567000');
  });

  it('AC-05 1.0 与 1e5 原样透传', () => {
    const r = convert("{'rate': 1.0, 'sci': 1e5}");
    expect(r.output).toContain('1.0');
    expect(r.output).toContain('1e5');
  });

  it('AC-06 键顺序保持', () => {
    const r = convert("{'b': 1, 'a': 2}");
    expect(r.output.indexOf('"b"')).toBeLessThan(r.output.indexOf('"a"'));
  });
});

describe('M0-5 引号与转义（§8.3 AC-13~16）', () => {
  it('AC-13 含单引号不含双引号 → 双引号', () => {
    const q = pickPythonQuote("it's ok");
    expect(q).toBe('"');
    expect(encodePythonString("it's ok")).toBe('"it\'s ok"');
    const r = convert('{"msg": "it\'s ok"}');
    expect(r.output).toContain('"it\'s ok"');
  });

  it('AC-14 含双引号不含单引号 → 保持单引号', () => {
    expect(pickPythonQuote('say "hi"')).toBe("'");
    expect(encodePythonString('say "hi"')).toBe("'say \"hi\"'");
  });

  it('AC-15 同时含两种引号 → 单引号 + 转义', () => {
    const s = 'it\'s "x"';
    const out = encodePythonString(s);
    expect(out.startsWith("'")).toBe(true);
    expect(out).toContain("\\'");
  });

  it('AC-16 换行正确转义', () => {
    const r = convert('{"msg": "a\\nb"}');
    expect(r.output).toContain('\\n');
  });

  it('JSON 侧控制字符用 \\u00XX', () => {
    expect(encodeJsonString('ab')).toBe('"a\\u0001b"');
  });
});

describe('转义工具', () => {
  it('decodeStringBody 反转义常见序列', () => {
    expect(decodeStringBody('a\\nb')).toBe('a\nb');
    expect(decodeStringBody('a\\tb')).toBe('a\tb');
    expect(decodeStringBody('a\\\\b')).toBe('a\\b');
    expect(decodeStringBody('a\\"b')).toBe('a"b');
  });
});

describe('M0-6 Map.toString()', () => {
  it('基础推断', () => {
    const r = convert('{name=张三, age=18, active=true}');
    expect(r.source).toBe('map');
    expect(r.output).toContain("'name': '张三'");
    expect(r.output).toContain("'age': 18");
    expect(r.output).toContain("'active': True");
  });

  it('AC-12 值内部的 = 不被误切分', () => {
    const r = convert('{url=a=b}');
    expect(r.output).toContain("'url': 'a=b'");
  });

  it('AC-42 嵌套对象', () => {
    const r = convert('{user={name=张三, age=18}}');
    expect(r.output).toContain("'user': {");
    expect(r.output).toContain("'name': '张三'");
  });

  it('AC-40 空容器', () => {
    const r = convert('{a=[], b={}}');
    expect(r.output).toContain("'a': []");
    expect(r.output).toContain("'b': {}");
  });

  it('AC-41 对象数组', () => {
    const r = convert('{list=[{b=1}, {c=2}]}', { compact: true });
    expect(r.output).toBe("{'list': [{'b': 1}, {'c': 2}]}");
  });

  it('AC-43 数组套数组', () => {
    const r = convert('{m=[[1, 2], [3, 4]]}', { compact: true });
    expect(r.output).toBe("{'m': [[1, 2], [3, 4]]}");
  });
});

describe('M0-8 detect 打分器', () => {
  it('Python 样本判定为 python', () => {
    expect(detect(lex("{'name': '张三', 'vip': True}").tokens, "{'name': '张三', 'vip': True}").format).toBe('python');
  });
  it('JSON 样本判定为 json', () => {
    expect(detect(lex('{"name": "张三", "vip": true}').tokens, '{"name": "张三", "vip": true}').format).toBe('json');
  });
  it('Map 样本判定为 map', () => {
    expect(detect(lex('{name=张三, age=18}').tokens, '{name=张三, age=18}').format).toBe('map');
  });
  it('纯数组无信号 → 默认 json', () => {
    expect(detect(lex('[1, 2, 3]').tokens, '[1, 2, 3]').format).toBe('json');
  });
  it('AC-51 C-2 反例：未被整段包裹不得误判为 Java 转义', () => {
    const src = '{"msg": "he said \\"hi\\""}';
    const d = detect(lex(src).tokens, src);
    expect(d.format).toBe('json');
    expect(d.scores.java).toBe(0);
  });
  it('整段包裹且含 \\" → 判定为 java', () => {
    const src = '"{\\"name\\": \\"x\\"}"';
    const d = detect(lex(src).tokens, src);
    expect(d.format).toBe('java');
  });
});

describe('M0-9 容错与报错', () => {
  it('AC-17/18 末尾逗号自动修复并记录', () => {
    const r = convert("{'a': 1, }");
    expect(r.status).not.toBe('error');
    expect(r.output).toContain('"a": 1');
  });

  it('AC-20 键名补引号', () => {
    const r = convert("{name: 'x'}");
    expect(r.fixes.some((f) => f.action.includes('引号'))).toBe(true);
    expect(r.output).toContain('"name": "x"');
  });

  it('AC-19 注释剥离', () => {
    const r = convert("{'a': 1}  # 备注");
    expect(r.status).not.toBe('error');
    expect(r.output).toContain('"a": 1');
  });

  it('空输入不报错', () => {
    const r = convert('');
    expect(r.status).toBe('empty');
    expect(r.error).toBeUndefined();
  });

  it('FR-C13 对象内缺 = 报「键值分隔符缺失」', () => {
    const r = convert('{a, b=1}', { force: 'map' });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('missing_colon');
  });

  it('数组内无 = 属正常，不报错', () => {
    const r = convert('{tags=[a, b]}', { force: 'map' });
    expect(r.status).not.toBe('error');
  });
});

describe('FR-A15 / FR-A16', () => {
  it('AC-45 NaN/Inf → null', () => {
    const r = convert("{'x': nan, 'y': inf}");
    expect(r.output).toContain('"x": null');
    expect(r.output).toContain('"y": null');
    expect(r.fixes.some((f) => f.action.includes('null'))).toBe(true);
  });

  it('AC-46 非字符串键转字符串', () => {
    const r = convert("{1: 'a'}");
    expect(r.output).toContain('"1": "a"');
  });
});

describe('AC-44 重复键保留并提示', () => {
  it('保留两个条目并记录重复', () => {
    const r = convert('{"a": 1, "a": 2}');
    expect(r.output).toContain("'a': 1");
    expect(r.output).toContain("'a': 2");
    expect(r.duplicates?.count).toBe(1);
  });
});

describe('FR-F4 统计口径（D-8）', () => {
  it('字符数按 Unicode 码点，emoji 计 1', () => {
    const s = "{'a': '🙂'}";
    expect(computeStats(s).chars).toBe([...s].length);
  });
  it('行数 = 换行符 + 1', () => {
    expect(computeStats('a\nb\nc').lines).toBe(3);
  });
});

describe('FR-B11 全格式回退', () => {
  it('判定为 python 但实际是 Map 时可回退成功', () => {
    const r = convert('{name=张三, age=18, x=1, y=2}');
    expect(r.status).not.toBe('error');
    expect(r.source).toBe('map');
  });
});

// ============ M2 补充：嵌套 Map / 容错边界 / 非字符串键 ============

describe('M2-3 嵌套 Map 解析（FR-C12）', () => {
  it('三层嵌套 + 对象数组 + 空数组混合', () => {
    const r = convert('{a={b={c=1, d=[1, 2]}, e=[{f=g}]}, h=[]}', { compact: true });
    expect(r.status).not.toBe('error');
    expect(r.output).toBe("{'a': {'b': {'c': 1, 'd': [1, 2]}, 'e': [{'f': 'g'}]}, 'h': []}");
  });

  it('中文键与中文值在嵌套结构中保持', () => {
    const r = convert('{user={name=张三, addr={city=北京}}}', { compact: true });
    expect(r.output).toBe("{'user': {'name': '张三', 'addr': {'city': '北京'}}}");
  });

  it('值中的空格在切分后被 trim', () => {
    const r = convert('{a=  hello world  , b=x y}', { compact: true });
    expect(r.output).toBe("{'a': 'hello world', 'b': 'x y'}");
  });

  it('深度上限保护：超限报错而非栈溢出', () => {
    const n = 400;
    const deep = '{a=' + '{b='.repeat(n) + '1' + '}'.repeat(n) + '}';
    const r = convert(deep, { force: 'map' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('嵌套过深');
  });

  it('FR-C13：数组内条目无 = 属正常，不得报错', () => {
    const r = convert('{tags=[a, b, c]}', { force: 'map', compact: true });
    expect(r.status).not.toBe('error');
    expect(r.output).toBe("{'tags': ['a', 'b', 'c']}");
  });

  it('FR-C13：嵌套对象内缺 = 报「键值分隔符缺失」', () => {
    const r = convert('{user={name, age=18}}', { force: 'map' });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('missing_colon');
  });
});

describe('M2-1 容错：修正记录来源与行列', () => {
  it('AC-19 注释剥离计入修正条并带行列', () => {
    const r = convert("{\n  'a': 1,  # 备注\n  'b': 2\n}");
    expect(r.fixes.length).toBeGreaterThan(0);
    const c = r.fixes.find((f) => f.action.includes('注释'));
    expect(c).toBeTruthy();
    expect(c!.line).toBe(2);
  });

  it('末尾逗号（对象与数组）均记修正', () => {
    const a = convert("{'a': 1, }");
    expect(a.fixes.some((f) => f.action.includes('逗号'))).toBe(true);
    const b = convert('[1, 2, ]');
    expect(b.fixes.some((f) => f.action.includes('逗号'))).toBe(true);
  });

  it('未闭合括号在末尾且结构唯一时自动补齐（FR-D3）', () => {
    const r = convert("{'a': 1");
    expect(r.status).not.toBe('error');
    expect(r.fixes.some((f) => f.action.includes('右括号'))).toBe(true);
  });

  it('引号未闭合被容错并记录', () => {
    const r = convert("{'a': 'abc}");
    expect(r.status).not.toBe('error');
    expect(r.fixes.some((f) => f.action.includes('引号'))).toBe(true);
  });

  it('无需修正时不产生任何修正记录（FR-D2）', () => {
    const r = convert('{"a": 1, "b": [1, 2]}');
    expect(r.fixes.length).toBe(0);
    expect(r.status).toBe('ok');
  });
});

describe('M2-5 NaN/非字符串键（FR-A15/A16）', () => {
  it('带符号的 -inf / +nan / Infinity 全部转 null', () => {
    const r = convert("{'x': -inf, 'y': +nan, 'z': Infinity}");
    const json = JSON.parse(r.output);
    expect(json.x).toBeNull();
    expect(json.y).toBeNull();
    expect(json.z).toBeNull();
    expect(r.fixes.filter((f) => f.action.includes('null')).length).toBe(3);
  });

  it('布尔/null 字面量作键 → 宽松模式转字符串键', () => {
    const r = convert("{True: 'a', None: 'b'}", { compact: true });
    expect(r.status).not.toBe('error');
    expect(r.output).toContain('"True": "a"');
    expect(r.output).toContain('"None": "b"');
  });

  it('元组键取字面量文本（FR-A16）', () => {
    const r = convert("{(1, 2): 'x'}", { compact: true });
    expect(r.output).toContain('"(1, 2)"');
    expect(r.fixes.some((f) => f.action.includes('字符串键'))).toBe(true);
  });
});

describe('FR-D10 失败时的格式建议', () => {
  it('纯乱码也给出可切换出口', () => {
    const list = suggestFormats('@@@', 'json', 2);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => s.format !== 'json')).toBe(true);
  });

  it('有信号时建议分数最高的格式', () => {
    const list = suggestFormats("{name='a', age=1, x=@@@}", 'json', 2);
    expect(list[0].format).toBeTruthy();
  });

  it('空输入不给建议', () => {
    expect(suggestFormats('', 'json', 2).length).toBe(0);
  });
});
