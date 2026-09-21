/**
 * 性能基准（FR-G5 / AC-26 / AC-27）
 * 500 行转换 < 500ms（P95）；5000 行降级模式 < 2s。
 */
import { describe, it, expect } from 'vitest';
import { convert } from '../../src/core/index.js';

function genLines(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(`  "key${i}": {"a": ${i}, "b": "value${i}", "c": [1, 2, 3]}`);
  }
  return '{\n' + rows.join(',\n') + '\n}';
}

function measure(text: string, runs: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    convert(text, { compact: true });
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b);
}

describe('性能基准', () => {
  it('AC-26：500 行中等嵌套转换 P95 < 500ms', () => {
    const text = genLines(500);
    const times = measure(text, 15);
    const p95 = times[Math.floor(times.length * 0.95)] ?? times[times.length - 1];
    // eslint-disable-next-line no-console
    console.log(`  500 行：中位 ${times[Math.floor(times.length / 2)].toFixed(0)}ms，P95 ${p95.toFixed(0)}ms，字符 ${[...text].length}`);
    expect(p95).toBeLessThan(500);
  });

  it('AC-27：5000 行（降级模式）转换 < 2s', () => {
    const text = genLines(5000);
    const times = measure(text, 5);
    const max = times[times.length - 1];
    // eslint-disable-next-line no-console
    console.log(`  5000 行：最慢 ${max.toFixed(0)}ms，字符 ${[...text].length}`);
    expect(max).toBeLessThan(2000);
  });

  it('FR-G2：10 万字符输入不崩溃', () => {
    const text = genLines(2500);
    const r = convert(text, { compact: true });
    expect(r.status).not.toBe('error');
  });
});
