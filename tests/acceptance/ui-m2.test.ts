/**
 * M2 UI 层验收：修正提示条 / 错误行高亮 / 过期角标 / 切换建议
 *
 * 与 acceptance.test.ts 的区别：那份断言的是 core 层（纯函数），
 * 这份在 jsdom 里真实挂载 AppController，断言 DOM 行为 ——
 * 「修正条显示 N 处」只有真的渲染出来才算通过。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup/cm6-jsdom.js';
import { AppController, type DomRefs } from '../../src/ui/controller.js';

function mount(): DomRefs {
  document.body.innerHTML = `
    <div class="app">
      <span id="fmtLabel"></span>
      <span id="lockBadge" hidden></span>
      <select id="fmtSelect">
        <option value="json">标准 JSON</option>
        <option value="python">Python 字面量</option>
        <option value="java">Java 转义字符串</option>
        <option value="map">Map.toString()</option>
      </select>
      <button id="resetAuto" hidden></button>
      <div id="editorIn"></div>
      <div id="editorOut"></div>
      <span id="statsIn"></span>
      <span id="statsOut"></span>
      <span id="staleBadge" hidden></span>
      <div id="fixbar" hidden></div>
      <div id="typePanel" hidden></div>
      <footer><span id="statusMsg"></span></footer>
      <button id="btnConvert"></button>
      <button id="btnFormat"></button>
      <button id="btnCompact"></button>
      <button id="btnCopy"></button>
      <button id="btnDownload"></button>
    </div>`;
  const q = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as unknown as T;
  return {
    fmtLabel: q('fmtLabel'),
    lockBadge: q('lockBadge'),
    fmtSelect: q<HTMLSelectElement>('fmtSelect'),
    resetAuto: q<HTMLButtonElement>('resetAuto'),
    editorIn: q('editorIn'),
    editorOut: q('editorOut'),
    statsIn: q('statsIn'),
    statsOut: q('statsOut'),
    staleBadge: q('staleBadge'),
    fixbar: q('fixbar'),
    typePanel: q('typePanel'),
    statusMsg: q('statusMsg'),
    btnConvert: q<HTMLButtonElement>('btnConvert'),
    btnFormat: q<HTMLButtonElement>('btnFormat'),
    btnCompact: q<HTMLButtonElement>('btnCompact'),
    btnCopy: q<HTMLButtonElement>('btnCopy'),
    btnDownload: q<HTMLButtonElement>('btnDownload'),
  };
}

let ctrl: AppController;
let dom: DomRefs;

beforeEach(async () => {
  dom = mount();
  // matchMedia 在 jsdom 中缺失，控制器依赖它判断深浅色
  window.matchMedia =
    window.matchMedia ??
    ((q: string) =>
      ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  ctrl = new AppController(dom);
  await ctrl.init();
  // v1.1：默认 tab 改为「格式化」（严格档，不自动修正）。
  // 本文件测的是「转换 tab 的容错修正语义」，故显式切过去。
  ctrl.switchTab('convert');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('M2-1 修正提示条（FR-D4/D5）', () => {
  it('AC-17 修正后显示「已自动修正 1 处」', () => {
    ctrl.run("{'a': 1, }");
    expect(dom.fixbar.hidden).toBe(false);
    expect(dom.fixbar.textContent).toContain('已自动修正 1 处');
  });

  it('AC-18 展开明细列出「第 N 行第 M 列 + 动作」', () => {
    ctrl.run("{'a': 1, }");
    const detail = dom.fixbar.querySelector('.fixbar__detail')?.textContent ?? '';
    expect(detail).toMatch(/第 1 行第 \d+ 列/);
    expect(detail).toContain('删除末尾多余逗号');
  });

  it('AC-19 注释剥离计入修正条', () => {
    ctrl.run("{'a': 1}  # 备注");
    expect(dom.fixbar.hidden).toBe(false);
    expect(dom.fixbar.textContent).toContain('剥离行注释');
  });

  it('AC-44 重复键提示语义后果', () => {
    ctrl.run('{"a": 1, "a": 2}');
    expect(dom.fixbar.hidden).toBe(false);
    expect(dom.fixbar.textContent).toContain('重复键');
    expect(dom.fixbar.textContent).toContain('后者将覆盖前者');
  });

  it('修正 > 5 处时加视觉强调类', () => {
    ctrl.run("{a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, }");
    expect(dom.fixbar.classList.contains('fixbar--warn')).toBe(true);
  });

  it('无修正时不显示提示条', () => {
    ctrl.run('{"a": 1}');
    expect(dom.fixbar.hidden).toBe(true);
  });

  it('点击提示条可展开明细，再点收起', () => {
    ctrl.run("{'a': 1, }");
    expect(dom.fixbar.classList.contains('fixbar--open')).toBe(false);
    dom.fixbar.click();
    expect(dom.fixbar.classList.contains('fixbar--open')).toBe(true);
    dom.fixbar.click();
    expect(dom.fixbar.classList.contains('fixbar--open')).toBe(false);
  });
});

describe('M2-2 错误行高亮 + 行列定位（FR-D6）', () => {
  it('解析失败时高亮错误行（CodeMirror 装饰生效）', () => {
    ctrl.run('{\n  "a": 1,\n  "b": @@@\n}');
    // 装饰由 StateField 驱动，渲染后 .cm-line 上出现 cm-errorLine
    const marked = dom.editorIn.querySelectorAll('.cm-errorLine');
    expect(marked.length).toBe(1);
  });

  it('AC-24 状态栏给出行列定位与原因分类', () => {
    ctrl.run('@@@');
    expect(dom.statusMsg.textContent).toMatch(/第 \d+ 行第 \d+ 列/);
    expect(dom.statusMsg.classList.contains('statusmsg--error')).toBe(true);
  });

  it('AC-22 失败态保留旧输出 + 置灰 + 角标 + 禁用复制下载', () => {
    ctrl.run("{'a': 1}"); // 先成功一次
    expect(dom.btnCopy.disabled).toBe(false);
    ctrl.run('{\n  "a": 1,\n  "b": @@@\n}'); // 再失败
    expect(dom.staleBadge.hidden).toBe(false);
    expect(dom.editorOut.classList.contains('is-stale')).toBe(true);
    expect(dom.btnCopy.disabled).toBe(true);
    expect(dom.btnDownload.disabled).toBe(true);
    expect(dom.btnConvert.disabled).toBe(false); // 转换始终可用
    expect(ctrl.output).toBe(''); // 失败时 IR 输出为空，不得拿旧输出冒充
  });

  it('AC-23 修复输入后恢复：角标移除、按钮解禁、高亮清除', () => {
    ctrl.run("{'a': 1}");
    ctrl.run('{\n  "a": 1,\n  "b": @@@\n}');
    expect(dom.staleBadge.hidden).toBe(false);
    ctrl.run('{\n  "a": 1,\n  "b": 2\n}'); // 用户补齐
    expect(dom.staleBadge.hidden).toBe(true);
    expect(dom.editorOut.classList.contains('is-stale')).toBe(false);
    expect(dom.btnCopy.disabled).toBe(false);
    expect(dom.editorIn.querySelectorAll('.cm-errorLine').length).toBe(0);
  });
});

describe('FR-D10 失败时建议切换来源格式', () => {
  it('未锁定时给出一键切换按钮', () => {
    ctrl.run('{name=张三, age=18, x=@@@}');
    const box = document.getElementById('suggestBox');
    // 该用例可能已由回退链救回；若进入失败态则必须有建议
    if (box) {
      expect(box.querySelectorAll('.suggest__btn').length).toBeGreaterThan(0);
    } else {
      expect(dom.statusMsg.classList.contains('statusmsg--error')).toBe(false);
    }
  });

  it('点击建议按钮 → 锁定该格式并重新转换', () => {
    ctrl.run('@@@');
    const box = document.getElementById('suggestBox');
    expect(box).toBeTruthy();
    const btn = box!.querySelector('.suggest__btn') as HTMLButtonElement;
    btn.click();
    expect(dom.lockBadge.hidden).toBe(false); // 手动锁定标记出现
    expect(dom.resetAuto.hidden).toBe(false);
  });

  it('已手动锁定时不再给切换建议', () => {
    dom.fmtSelect.value = 'json';
    dom.fmtSelect.dispatchEvent(new Event('change'));
    ctrl.run('@@@');
    expect(document.getElementById('suggestBox')).toBeNull();
  });
});

describe('M2 统计与判定条', () => {
  it('AC-52 emoji 字符数按码点统计', () => {
    const s = "{'a': '🙂'}";
    ctrl.run(s);
    expect(dom.statsIn.textContent).toMatch(/字符 \d+/);
    // {'a': '🙂'} 去掉引号共 10 个码点：{ ' a ' : ' 🙂 ' }
    expect(dom.statsIn.textContent).toBe(`行 1 · 字符 ${[...s].length}`);
  });

  it('AC-48 回退成功时状态栏标注实际格式', () => {
    ctrl.run('{name=张三, age=18, x=1, y=2}');
    expect(dom.fmtLabel.textContent).toBe('Map.toString()');
  });

  it('手动锁定后显示「手动锁定」标记与「重置为自动」', () => {
    dom.fmtSelect.value = 'python';
    dom.fmtSelect.dispatchEvent(new Event('change'));
    expect(dom.lockBadge.hidden).toBe(false);
    expect(dom.resetAuto.hidden).toBe(false);
    dom.resetAuto.click();
    expect(dom.lockBadge.hidden).toBe(true);
    expect(dom.resetAuto.hidden).toBe(true);
  });
});
