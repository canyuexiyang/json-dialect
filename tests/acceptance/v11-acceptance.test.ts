/**
 * v1.1 验收标准（AC-53 ～ AC-73）
 *
 * 对应的缺陷与能力：
 *  - AC-53～57  静默错误修复（F1/F2/F3）—— v1.0 最严重缺陷
 *  - AC-58～61  日志前缀一键剥离（FR-D13/D14）
 *  - AC-62～67  目标格式解耦 4×3（F4 / FR-A17~A19 / US-17）
 *  - AC-68～70  tab 框架与格式化 tab 严格档
 *  - AC-71～73  转义 tab（FR-I1~I4，含 Base64 UTF-8）
 */

import { describe, it, expect } from 'vitest';
import { convert } from '../../src/core/index.js';
import { findLogPrefix } from '../../src/core/logPrefix.js';
import { escapeText, ESCAPE_DIR_LABEL } from '../../src/core/escapeText.js';
import { ALL_TARGETS } from '../../src/core/types.js';

describe('AC-53～57 静默错误必须变成明确报错', () => {
  it('AC-53 日志前缀 + JSON 不得静默丢弃', () => {
    const r = convert('2024-01-01 12:00:00 INFO {"a":1}');
    expect(r.status).toBe('error');
    expect(r.output).not.toBe('2024-01-01');
  });

  it('AC-54 JSON Lines 报「多个并列值」', () => {
    const r = convert('{"a":1}\n{"b":2}');
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('multiple_values');
  });

  it('AC-55 尾部垃圾给出起始行列', () => {
    const r = convert('{"a":1} garbage');
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('trailing_content');
    expect(r.error?.line).toBe(1);
    expect(r.error?.col).toBe(8); // `garbage` 起始列（0-based）：{0 "1 a2 "3 :4 1 5 }6 ␣7 g8
  });

  it('AC-56 修正记录不得谎报「删除末尾多余逗号」', () => {
    for (const t of ['{"a":1} garbage', '{"a":1}\n{"b":2}', '{"a":1},{"b":2}']) {
      const r = convert(t);
      expect(r.status).toBe('error');
      expect(r.fixes).toHaveLength(0);
    }
  });

  it('AC-57 带 BOM 的 JSON 不得误判为 Java 转义', () => {
    const r = convert('\uFEFF{"a":1}');
    // v1.0 实测：BOM 导致 detect 走 Java 分支，虽结果碰巧对但来源判错
    expect(r.source).toBe('json');
    expect(r.status).not.toBe('fallback');
  });

  it('真实逗号场景仍报「删除末尾多余逗号」（防 AC-56 误伤）', () => {
    const r = convert('{"a":1,}');
    expect(r.status).toBe('fixed');
    expect(r.fixes[0].action).toContain('删除末尾多余逗号');
  });
});

describe('AC-58～61 日志前缀一键剥离', () => {
  it('AC-58 报错时给出剥离入口', () => {
    const r = convert('2024-01-01 12:00:00 INFO {"a":1}');
    expect(r.status).toBe('error');
    expect(r.prefixHint).toBeDefined();
    expect(r.prefixHint?.prefix).toBe('2024-01-01 12:00:00 INFO ');
  });

  it('AC-59 剥离后重试输出正确，且剥离动作可见（FR-D14）', () => {
    const hint = findLogPrefix('2024-01-01 12:00:00 INFO {"a":1}')!;
    const r = convert('2024-01-01 12:00:00 INFO {"a":1}', {
      strippedPrefix: hint.prefix,
    });
    expect(r.status).not.toBe('error');
    expect(r.output).toContain("'a': 1");
    // 剥离了什么必须出现在修正记录里
    expect(r.fixes.some((f) => f.action.includes('剥离日志前缀'))).toBe(true);
  });

  it('AC-60 logger 名被一并剥离（正则方案会漏）', () => {
    const text = '2024-01-01 12:00:00 ERROR com.foo.Bar - {"a":1}';
    const hint = findLogPrefix(text)!;
    expect(hint.prefix).toContain('com.foo.Bar');
    const r = convert(text, { strippedPrefix: hint.prefix });
    expect(r.status).not.toBe('error');
    expect(r.output).toContain("'a': 1");
  });

  it('AC-61 无前缀输入不得误触发剥离', () => {
    for (const t of ['{"a":1}', '[1,2,3]']) {
      const r = convert(t);
      expect(r.status).not.toBe('error');
      expect(r.prefixHint).toBeUndefined();
    }
  });

  it('方括号包裹的时间戳也能剥离（纯正则方案会漏）', () => {
    const text = '[2024-01-01 12:00:00] INFO {"a":1}';
    const hint = findLogPrefix(text)!;
    const r = convert(text, { strippedPrefix: hint.prefix });
    expect(r.status).not.toBe('error');
  });
});

describe('AC-62～67 目标格式解耦（4×3）', () => {
  it('AC-62 目标 = JSON：同语言规范化，不改值', () => {
    const r = convert('{"a":1,"big":12345678901234567890}', { target: 'json' });
    expect(r.output).toContain('"a": 1');
    expect(r.output).toContain('12345678901234567890'); // FR-A11 精度不丢
  });

  it('AC-63 目标 = Python', () => {
    const r = convert('{"a":1}', { target: 'python' });
    expect(r.output).toContain("'a': 1");
  });

  it('AC-64 目标 = Java 转义（US-17）', () => {
    const r = convert('{"msg":"he said \\"hi\\""}', { target: 'java' });
    expect(r.outputLang).toBe('java');
    // 整段是一个可直接贴进 Java 代码的字符串常量：外层带引号，且能被 JSON 解析还原
    expect(r.output.startsWith('"')).toBe(true);
    const restored = JSON.parse(r.output) as string;
    expect(restored).toContain('"msg"');
    // 还原后的内容再解析一次，值必须无损（FR-A19 精神）
    expect(JSON.parse(restored)).toEqual({ msg: 'he said "hi"' });
  });

  it('AC-65 目标选项不得包含 Map.toString()', () => {
    expect(ALL_TARGETS).toEqual(['json', 'python', 'java']);
    expect(ALL_TARGETS).not.toContain('map');
  });

  it('AC-66 手动指定目标不影响来源判定', () => {
    const py = "{'a': 1}";
    for (const t of ['json', 'python', 'java'] as const) {
      const r = convert(py, { target: t });
      expect(r.source).toBe('python');
    }
  });

  it('4 来源 × 3 目标全部可用', () => {
    const inputs: Array<[string, string]> = [
      ['json', '{"a":1}'],
      ['python', "{'a':1}"],
      ['java', '"{\\"a\\": 1}"'],
      ['map', '{a=1}'],
    ];
    for (const [src, text] of inputs) {
      for (const t of ALL_TARGETS) {
        const r = convert(text, { target: t });
        expect(r.status).not.toBe('error');
        expect(r.outputLang).toBe(t);
      }
    }
  });
});

describe('AC-68～70 格式化 tab 严格档', () => {
  it('AC-69 严格档下末尾逗号直接报错，不自动修复', () => {
    const r = convert('{"a":1,}', { target: 'json', strictOnly: true });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('逗号');
  });

  it('AC-70 容错档下修复并列出修正记录', () => {
    const r = convert('{"a":1,}', { target: 'json' });
    expect(r.status).toBe('fixed');
    expect(r.fixes[0].action).toContain('删除末尾多余逗号');
  });

  it('严格档不误伤合法输入', () => {
    const r = convert('{"a": 1, "b": [1, 2]}', { target: 'json', strictOnly: true });
    expect(r.status).toBe('ok');
  });

  it('FR-K1 严格档挡住的是「自动修复」，不是来源识别', () => {
    // ① 来源识别照常工作：单引号是 Python 特征，判 python 并成功解析是**对的**
    const py = convert("{'a': 1}", { target: 'json', strictOnly: true });
    expect(py.source).toBe('python');
    expect(py.status).toBe('ok');

    // ② 同一格式内的语法残缺 → 严格档必须报错，不得悄悄修
    const broken = convert('{"a":1,}', { target: 'json', strictOnly: true });
    expect(broken.status).toBe('error');

    // ③ 残缺括号在严格档也不得补（宽松档会补）
    const unclosed = convert('{"a": 1', { target: 'json', strictOnly: true });
    expect(unclosed.status).toBe('error');
    expect(convert('{"a": 1', { target: 'json' }).status).toBe('fixed');
  });

  it('FR-A19 同语言规范化：目标 = 来源 不改数据', () => {
    for (const t of ['{"a":1,"b":[1,2]}', "{'a':1,'b':(1,2)}"]) {
      const once = convert(t, { target: 'same' });
      const twice = convert(once.output, { target: 'same' });
      expect(twice.output).toBe(once.output); // 幂等
    }
  });
});

describe('AC-71～73 转义 tab', () => {
  it('AC-71 中文 Base64 编码按 UTF-8', () => {
    const r = escapeText('中文', 'base64', 'encode');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('5Lit5paH'); // 原生 btoa('中文') 会抛异常
  });

  it('AC-72 Base64 往返一致', () => {
    const enc = escapeText('中文', 'base64', 'encode');
    const dec = escapeText(enc.output, 'base64', 'decode');
    expect(dec.output).toBe('中文');
  });

  it('AC-73 非法 Base64 报错，不返回空串或部分结果', () => {
    const r = escapeText('!!!', 'base64', 'decode');
    expect(r.ok).toBe(false);
    expect(r.output).toBe('');
    expect(r.error).toBeTruthy();
  });

  it('FR-I2 四种风格均双向可用', () => {
    const s = 'a"b\\c\n中文 x=1&y=2';
    for (const style of ['json', 'java', 'url', 'base64'] as const) {
      const enc = escapeText(s, style, 'encode');
      const dec = escapeText(enc.output, style, 'decode');
      expect(enc.ok).toBe(true);
      expect(dec.output).toBe(s);
    }
  });

  it('FR-I3 非法 URL 编码报错', () => {
    const r = escapeText('%E4%ZZ', 'url', 'decode');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  // ── FR-I5 方向语义 / FR-I6 外层引号 / FR-I7 往返 ──────────────────

  it('AC-74 方向语义：encode = 增加转义，decode = 去除转义', () => {
    expect(ESCAPE_DIR_LABEL.encode).toBe('增加转义');
    expect(ESCAPE_DIR_LABEL.decode).toBe('去除转义');
    // 增加转义必须真的加上反斜杠
    expect(escapeText('{"a":1}', 'json', 'encode').output).toBe('{\\"a\\":1}');
    // 去除转义必须真的去掉反斜杠
    expect(escapeText('{\\"a\\":1}', 'json', 'decode').output).toBe('{"a":1}');
  });

  it('AC-75 去除转义自动剥离外层引号（FR-I6）', () => {
    const r = escapeText('"{\\"a\\":1}"', 'json', 'decode');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('{"a":1}');
    expect(r.note).toContain('已自动去除外层引号');
  });

  it('AC-76 不得误伤含未转义引号的文本（FR-I6 安全判据）', () => {
    const t = 'a" + "b';
    const r = escapeText(t, 'json', 'decode');
    expect(r.output).toBe(t);
    expect(r.note).toBeUndefined(); // 没剥就不许声称剥了
  });

  it('AC-77 增加转义方向不得剥引号', () => {
    const r = escapeText('"abc"', 'json', 'encode');
    expect(r.output).toBe('\\"abc\\"');
    expect(r.note).toBeUndefined();
  });

  it('AC-78 四种风格增加→去除往返一致（含外层引号复制场景）', () => {
    const samples = ['{"a":1}', '{"msg":"he said \\"hi\\""}', '中文 ?&=', '中文'];
    for (const style of ['json', 'java', 'url', 'base64'] as const) {
      for (const s of samples) {
        const enc = escapeText(s, style, 'encode');
        expect(enc.ok).toBe(true);
        // 模拟"从代码里复制出来"：给编码结果套上外层引号
        const decPlain = escapeText(enc.output, style, 'decode');
        const decQuoted = escapeText('"' + enc.output + '"', style, 'decode');
        expect(decPlain.output).toBe(s);
        expect(decQuoted.output).toBe(s);
      }
    }
  });
});
