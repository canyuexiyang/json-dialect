// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../setup/cm6-jsdom.js';
import { language } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { AppController } from '../../src/ui/controller.js';
import { mountShell } from '../../src/ui/shell.js';
import { createEditor } from '../../src/ui/editor.js';
import { writeSession } from '../../src/ui/sessionState.js';

async function setup() {
  document.body.innerHTML='<main id="app"></main>';
  const dom=mountShell('panel'); const app=new AppController(dom,{surface:'panel'});
  await app.init('',{compact:false});return {dom,app};
}
function changeType(dom:ReturnType<typeof mountShell>, type:string) {
  const sel=dom.typePanel.querySelector('select')!;sel.value=type;sel.dispatchEvent(new Event('change'));
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});

describe('审查回归：用户操作与状态',()=>{
  it('空白与报错时都能切换容错',async()=>{
    const {app,dom}=await setup();expect(dom.btnFormat.disabled).toBe(false);
    app.setInput('{"a":1,}');expect(dom.btnFormat.disabled).toBe(false);
    dom.btnFormat.click();expect(JSON.parse(app.output)).toEqual({a:1});
  });
  it('自动识别同步自绘来源文案',async()=>{
    const {app,dom}=await setup();app.setInput("{'a':True}");
    expect(dom.fmtSelect.parentElement?.querySelector('.sel__value')?.textContent).toBe('Python 字面量');
  });
  it('类型覆盖保留目标，并支持清除后再次调整',async()=>{
    const {app,dom}=await setup();app.switchTab('convert');app.setTarget('json');app.setInput('{a=1}');changeType(dom,'string');
    expect(JSON.parse(app.output)).toEqual({a:'1'});expect(dom.btnDownload.textContent).toContain('.json');
    Array.from(dom.typePanel.querySelectorAll('button')).find(b=>b.textContent==='清除覆盖')!.click();
    expect(JSON.parse(app.output)).toEqual({a:1});expect(dom.typePanel.querySelector('select')).not.toBeNull();
  });
  it('删除路径与清空输入都丢弃覆盖',async()=>{
    const {app,dom}=await setup();app.switchTab('convert');app.setTarget('json');app.setInput('{a=1}');changeType(dom,'string');
    app.setInput('{b=2}');app.setInput('{a=3}');expect(JSON.parse(app.output)).toEqual({a:3});
    changeType(dom,'string');app.setInput('');app.setInput('{a=4}');expect(JSON.parse(app.output)).toEqual({a:4});
  });
  it('tab 的输入、锁定和覆盖相互独立且可恢复',async()=>{
    const {app,dom}=await setup();app.setInput('{"x":1}');
    app.switchTab('convert');expect(app.input).toBe('');app.setInput('{a=1}');changeType(dom,'string');
    app.switchTab('escape');expect(app.input).toBe('');app.setInput('hello');
    app.switchTab('format');expect(app.input).toBe('{"x":1}');
    app.switchTab('convert');expect(app.input).toBe('{a=1}');expect(app.output).toContain("'1'");
  });
  it('大文本立即使旧输出不可导出，旧防抖不能覆盖当前内容',async()=>{
    vi.useFakeTimers();const {app,dom}=await setup();app.setInput('{"a":1}');
    const internal=app as unknown as {in:ReturnType<typeof createEditor>};
    internal.in.setDoc('{"a":2}');internal.in.setDoc('x'.repeat(500001));
    expect(dom.btnCopy.disabled).toBe(true);expect(dom.btnDownload.disabled).toBe(true);expect(dom.staleBadge.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(400);expect(dom.btnCopy.disabled).toBe(true);
  });
  it('更换输入后日志前缀需重新确认',async()=>{
    const {app}=await setup();app.switchTab('convert');app.setInput('INFO {"a":1}');
    document.querySelector<HTMLButtonElement>('#prefixHintBox button')!.click();expect(app.output).toContain('1');
    app.setInput('INFO {"a":2}');expect(app.output).toBe('');expect(document.querySelector('#prefixHintBox')).not.toBeNull();
    app.setInput('');expect(document.querySelector('#prefixHintBox')).toBeNull();
  });
  it('分隔条小幅拖动不跳跃，键盘向下增大输入区',async()=>{
    const {dom}=await setup();Object.defineProperty(dom.splitter!.parentElement,'clientHeight',{value:1000});
    dom.splitter!.dispatchEvent(new MouseEvent('pointerdown',{clientY:500}));
    window.dispatchEvent(new MouseEvent('pointermove',{clientY:501}));window.dispatchEvent(new Event('pointerup'));
    expect(Number(dom.splitter!.getAttribute('aria-valuenow'))).toBeCloseTo(50.1,0);
    dom.splitter!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}));
    expect(Number(dom.splitter!.getAttribute('aria-valuenow'))).toBeGreaterThan(50.1);
  });
  it('自绘下拉可用键盘选择并关闭',async()=>{
    const {dom}=await setup();const trigger=dom.fmtSelect.parentElement!.querySelector('button')!;
    trigger.click();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    expect(dom.fmtSelect.value).toBe('python');expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
  it('错误标记不移动输入光标',()=>{
    const host=document.createElement('div');document.body.appendChild(host);const editor=createEditor(host,{doc:'abc\nxyz'});
    editor.view.dispatch({selection:{anchor:6}});editor.highlightLine(1);expect(editor.view.state.selection.main.anchor).toBe(6);editor.destroy();
  });
  it('关闭高亮真正卸载语言，且保留光标和编辑历史',()=>{
    const host=document.createElement('div');document.body.appendChild(host);const editor=createEditor(host,{doc:'{"a":1}',lang:'json'});
    editor.setHighlight(true);editor.view.dispatch({selection:{anchor:3}});editor.setHighlight(false);
    expect(editor.view.state.facet(language)).toBeNull();expect(editor.view.state.selection.main.anchor).toBe(3);editor.destroy();
  });
  it('复制失败不解除只读',async()=>{
    const {app,dom}=await setup();app.setInput('{"a":1}');dom.btnCopy.click();await Promise.resolve();await Promise.resolve();
    const internal=app as unknown as {out:ReturnType<typeof createEditor>};expect(internal.out.view.state.facet(EditorState.readOnly)).toBe(true);
  });
  it('session 写入永不 settle 也会结束',async()=>{
    vi.useFakeTimers();vi.stubGlobal('chrome',{storage:{session:{set:()=>new Promise(()=>{})}}});
    const promise=writeSession({input:'secret'});await vi.advanceTimersByTimeAsync(1600);expect(await promise).toBe(false);
  });
});

it('类型覆盖失败仍可直接纠正',async()=>{
  const {app,dom}=await setup();app.switchTab('convert');app.setTarget('json');app.setInput('{a=hello}');changeType(dom,'number');
  expect(app.output).toBe('');expect(dom.btnCopy.disabled).toBe(true);expect(dom.typePanel.hidden).toBe(false);
  changeType(dom,'infer');expect(JSON.parse(app.output)).toEqual({a:'hello'});
});
it('迟到偏好不会覆盖当前操作',async()=>{
  let resolve!:(value:unknown)=>void;
  vi.stubGlobal('chrome',{storage:{local:{get:()=>new Promise(r=>{resolve=r;}),set:async()=>{}}}});
  document.body.innerHTML='<main id="app"></main>';const dom=mountShell('panel');const app=new AppController(dom);
  await app.init();app.switchTab('escape');app.setInput('current');
  resolve({'json-dialect-prefs':{tab:'format',escapeDir:'decode'}});await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(app.currentTab).toBe('escape');expect(app.currentEscapeDir).toBe('encode');expect(app.input).toBe('current');
});
it('迁移保留非当前 tab 的工作区',async()=>{
  const {app,dom}=await setup();app.setInput('{"x":1}');app.switchTab('convert');app.setInput('{a=1}');
  let saved:Record<string,unknown>={};
  vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>p},storage:{session:{set:async(value:Record<string,unknown>)=>{saved=value;},remove:async()=>{}},local:{set:async()=>{}}}});
  vi.spyOn(window,'open').mockReturnValue(window);dom.enlarge!.click();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  const session=Object.values(saved)[0] as {workspaces:{format:{input:string}}};
  expect(session.workspaces.format.input).toBe('{"x":1}');
});
it('不同会话交接互不覆盖且读后清除',async()=>{
  const {consumeSession}=await import('../../src/ui/sessionState.js');
  const data:Record<string,unknown>={};vi.stubGlobal('chrome',{storage:{session:{set:async(value:Record<string,unknown>)=>{Object.assign(data,value);},get:async(key:string)=>({[key]:data[key]}),remove:async(key:string)=>{delete data[key];}}}});
  await Promise.all([writeSession({input:'first'},'one'),writeSession({input:'second'},'two')]);
  expect((await consumeSession('one'))?.input).toBe('first');expect((await consumeSession('two'))?.input).toBe('second');expect(Object.keys(data)).toHaveLength(0);
});
it('标签页打开失败保留侧边栏与输入',async()=>{
  const {app,dom}=await setup();app.setInput('{"a":1}');const close=vi.fn();
  vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>p},sidePanel:{close},storage:{session:{set:async()=>{},remove:async()=>{}}}});
  vi.spyOn(window,'open').mockReturnValue(null);dom.enlarge!.click();
  for(let i=0;i<12;i++) await Promise.resolve();
  expect(close).not.toHaveBeenCalled();expect(app.input).toBe('{"a":1}');expect(dom.statusMsg.textContent).toContain('未能打开');
});
