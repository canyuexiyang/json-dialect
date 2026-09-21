import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { convert } from '../../src/core/index.js';

/**
 * 属性测试（R1 缓解措施 ③）
 *
 * 往返验证：随机生成结构 → 转 JSON → JSON.parse → 反转回 Python → 再解析
 * 断言结构等价。这条能覆盖人脑想不到的引号/转义组合。
 */

describe('属性测试 · 往返一致性', () => {
  it('JSON → Python → 解析回等价结构', () => {
    const arb = fc.anything({ maxDepth: 3, maxKeys: 6 }).filter(
      (v) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol',
    );

    fc.assert(
      fc.property(arb, (value) => {
        const jsonIn = JSON.stringify(value);
        const r1 = convert(jsonIn);
        expect(r1.status).not.toBe('error');

        // 输出必须是合法 Python 字面量（用本引擎反向解析验证）
        const r2 = convert(r1.output, { force: 'python' });
        expect(r2.status).not.toBe('error');

        // 再由 Python 字面量转回 JSON
        const r3 = convert(r2.output, { force: 'python' });
        expect(r3.status).not.toBe('error');

        // 结构等价：与原始 JSON 的深度/类型一致
        expect(JSON.parse(r3.output)).toEqual(JSON.parse(jsonIn));
      }),
      { numRuns: 300 },
    );
  });

  it('随机字符串 → Python 字面量 → 反转义后与原值一致', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        // 排除会让 JSON 序列化失败的控制字符
        if (/[\u0000-\u001F]/.test(s)) return;
        const input = JSON.stringify({ v: s });
        const r = convert(input);
        expect(r.status).not.toBe('error');
        // 反向解析回 Python 结构并比对字符串值
        const back = convert(r.output, { force: 'python' });
        expect(back.status).not.toBe('error');
        const roundTrip = convert(back.output, { force: 'python' });
        expect(JSON.parse(roundTrip.output).v).toBe(s);
      }),
      { numRuns: 400 },
    );
  });

  it('数字以原始 token 透传，不做数值归一化', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (n) => {
        const raw = n.toString();
        const r = convert('{"n": ' + raw + '}', { compact: true });
        expect(r.output).toContain(raw);
      }),
      { numRuns: 200 },
    );
  });
});
