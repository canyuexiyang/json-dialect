/**
 * Spike S-1 验证：剪贴板三级降级链
 *
 * 在 jsdom 中模拟三种环境，验证降级逻辑正确逐级回落且最终必然给出结论。
 * 真机弹窗环境结论记录在 docs/03-研发/spike-记录.md。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyText } from '../../src/ui/clipboard.js';

describe('Spike S-1 · 剪贴板三级降级链', () => {
  let execCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execCommandMock = vi.fn();
    (document as unknown as { execCommand: unknown }).execCommand = execCommandMock;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('① navigator.clipboard.writeText 可用 → 走 Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const r = await copyText('hello');
    expect(r.ok).toBe(true);
    expect(r.method).toBe('clipboard-api');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('② Clipboard API 抛错 → 降级 execCommand 并成功', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    execCommandMock.mockReturnValue(true);
    const r = await copyText('hello');
    expect(r.ok).toBe(true);
    expect(r.method).toBe('exec-command');
    expect(execCommandMock).toHaveBeenCalledWith('copy');
  });

  it('③ 两者均失败 → 返回手动复制引导，不抛异常', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    execCommandMock.mockReturnValue(false);
    const r = await copyText('hello');
    expect(r.ok).toBe(false);
    expect(r.method).toBe('manual');
    expect(r.message).toContain('Ctrl/Cmd + C');
  });

  it('无 navigator.clipboard（非安全上下文）→ 直接降级 execCommand', async () => {
    vi.stubGlobal('navigator', {});
    execCommandMock.mockReturnValue(true);
    const r = await copyText('hello');
    expect(r.ok).toBe(true);
    expect(r.method).toBe('exec-command');
  });

  it('空文本不尝试复制', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const r = await copyText('');
    expect(r.ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('execCommand 抛异常时仍不崩溃，继续降级', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('x')) },
    });
    execCommandMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const r = await copyText('hello');
    expect(r.method).toBe('manual');
  });
});
