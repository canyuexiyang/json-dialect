import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { convert } from '../../src/core/index.js';

const json = (text: string, opts = {}) => convert(text, { force: 'json', target: 'json', strictOnly: true, ...opts });

describe('审查回归：语法与数据完整性', () => {
  it.each(['1e', '1-2', '1e+', '1.2.3', '+1', '.5', '01'])('严格 JSON 拒绝数字 %s', (n) => {
    expect(json(`{"n":${n}}`).status).toBe('error');
  });
  it.each(["{'a':1}", '{"a":(1,2)}', '{"a":1} #comment', '{1:2}', '{"a":"\\x41"}', '{"a":"x\ny"}'])('严格 JSON 拒绝 %s', (s) => {
    expect(json(s).status).toBe('error');
  });
  it('严格 Python 接受本语言的尾逗号和注释', () => {
    const r = convert("{'a':1, 'b':(2,),} #comment", { force:'python', strictOnly:true, target:'json' });
    expect(r.status).not.toBe('error');
    expect(JSON.parse(r.output)).toEqual({a:1,b:[2]});
    expect(r.fixes).toEqual([]);
  });
  it.each(['true', 'FALSE', 'null'])('严格 Python 拒绝非本语言字面量 %s', (v) => {
    expect(convert(`{'a':${v}}`, {force:'python',strictOnly:true}).status).toBe('error');
  });
  it('Python 转义与独立解释器的值一致', () => {
    const input = String.raw`{'path':'C:\project','emoji':'\U0001F600','octal':'\101','slash':'\/','continued':'a` + '\\' + '\n' + "b'}";
    const expected = JSON.parse(execFileSync('python3', ['-c','import ast,json,sys; print(json.dumps(ast.literal_eval(sys.stdin.read())))'], {input,encoding:'utf8'}));
    const r = convert(input, {force:'python',target:'json',strictOnly:true});
    expect(r.status).not.toBe('error');
    expect(JSON.parse(r.output)).toEqual(expected);
  });
  it('合法转义不报告自动修正', () => {
    const r = json(String.raw`{"a":"say \"hi\""}`);
    expect(r.status).toBe('ok');
    expect(r.fixes).toEqual([]);
  });
  it('宽松数字规范化后仍是合法 JSON，且保留大整数', () => {
    const r = convert('{n=+.5, big=123456789012345678901234567890}', {force:'map',target:'json'});
    expect(r.status).not.toBe('error');
    expect(JSON.parse(r.output).n).toBe(0.5);
    expect(r.output).toContain('123456789012345678901234567890');
  });
});

describe('审查回归：Map 与覆盖', () => {
  it.each(['json','python','java'] as const)('目标 %s 应用覆盖并恢复前导零', (target) => {
    const r = convert('{id=0012}', {force:'map',target,overrides:new Map([['/id','string']])});
    expect(r.outputLang).toBe(target);
    if (target==='python') expect(r.output).toContain("'0012'");
    else expect(JSON.parse(target==='java'?JSON.parse(r.output):r.output)).toEqual({id:'0012'});
  });
  it('特殊键与重复键的覆盖路径互不碰撞', () => {
    const initial = convert('{a/b=1, a={b=2}, a/b=3, a/b#1=4}', {force:'map',target:'json'});
    expect(new Set(initial.values.map(v=>v.path)).size).toBe(4);
    const r = convert('{a/b=1, a={b=2}, a/b=3, a/b#1=4}', {force:'map',target:'json',overrides:new Map([[initial.values[0].path,'string']])});
    expect(r.output).toContain('"a/b": "1"');
    expect(r.output).toContain('"b": 2');
    expect(r.output).toContain('"a/b": 3');
    expect(r.output).toContain('"a/b#1": 4');
  });
  it('非法类型覆盖报错，不能静默变成 0', () => {
    const r = convert('{a=hello}', {force:'map',target:'json',overrides:new Map([['/a','number']])});
    expect(r.status).toBe('error');
    expect(r.output).toBe('');
  });
  it('多行 Map 错误定位到真实行列', () => {
    const r=convert('{\n a=1,\n broken\n}', {force:'map'});
    expect(r.error).toMatchObject({line:3,col:1});
  });
  it.each(['{a=1} {b=2}','{a=1} garbage','{a=[1,2}}'])('Map 拒绝残留和错配结构 %s', (s) => {
    expect(convert(s,{force:'map'}).status).toBe('error');
  });
  it('合法 Map 文本不会继承其他语法的修复标记', () => {
    const r = convert('{a/b=1, name=张三}', {force:'map'});
    expect(r.status).toBe('ok');
    expect(r.fixes).toEqual([]);
  });
  it('Map 数组嵌套也限制最大深度', () => {
    expect(convert('['.repeat(220)+'x'+']'.repeat(220),{force:'map'}).status).toBe('error');
  });
});

describe('审查回归：完整处理预算', () => {
  it.each(['json','map'] as const)('%s 的过期预算返回 timeout', (force) => {
    expect(convert(force==='json'?'{"a":1}':'{a=1}',{force,timeoutMs:-1}).status).toBe('timeout');
  });
  it('3 万字段的平铺对象不再平方级收集路径', () => {
    const text='{'+Array.from({length:30000},(_,i)=>`"k${i}":${i}`).join(',')+'}';
    const start=performance.now();
    const r=convert(text,{force:'json',target:'json',timeoutMs:3000});
    expect(r.status).toBe('ok');
    expect(r.values).toHaveLength(30000);
    expect(performance.now()-start).toBeLessThan(3000);
  });
  it('词法扫描也受 deadline 约束', () => {
    let ticks=0;
    const spy=vi.spyOn(Date,'now').mockImplementation(()=>ticks++*10);
    try {expect(convert(JSON.stringify({a:'x'.repeat(100000)}),{force:'json',timeoutMs:5}).status).toBe('timeout');}
    finally {spy.mockRestore();}
  });
});

describe('严格 Python 同格式保留语义', () => {
  it('格式化保留非字符串键和元组（独立 Python 求值）', () => {
    const input="{1:(2,), None:(), 'group':(3), 'nested':[(4,5)]}";
    const r=convert(input,{force:'python',target:'same',strictOnly:true});
    expect(r.status).toBe('ok');
    const same=execFileSync('python3',['-c','import ast,json,sys; a,b=json.load(sys.stdin); print(ast.literal_eval(a)==ast.literal_eval(b))'],{input:JSON.stringify([input,r.output]),encoding:'utf8'}).trim();
    expect(same).toBe('True');
  });
  it('JSON 严格模式拒绝非 JSON 空白',()=>{
    expect(json('{"a":\v1}').status).toBe('error');
  });
});
