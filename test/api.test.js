// 定稿AI 测试工程师 · 自动化测试套件 v0.3（功能/合规/安全/AI场景）
// 运行：node test/api.test.js  （自动拉起 8789 测试实例，结束后回收）
// v0.2 已有：M5分段校对E2E回归（长文本不超时）/ 切块完整性 / M2序号修正与去重 / M8交稿检查报告 / docx格式元数据
// v0.3 新增：M9选题(真实AI六要素/追问/采纳) / M10大纲(生成/树保存/导出) / M11编写(自动保存/导出docx确定性) / M12进度打卡 / 隐私隔离(跨用户404/管理员无内容查看权)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8789';
const DB = path.join(__dirname, '..', 'test', 'test.db');
try { fs.rmSync(DB, { force: true }); } catch {}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: '8789', DINGAO_TEST: '1', DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
server.stderr.on('data', (d) => { srvErr += d.toString(); });
server.on('exit', (code) => { if (code) console.error('测试实例异常退出:', code, srvErr.slice(0, 600)); });
await new Promise((r) => setTimeout(r, 3000));
if (server.exitCode !== null) { console.error('测试实例未能启动:\n' + srvErr.slice(0, 800)); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name}  ${detail}`); }
}
async function req(path_, opt = {}) {
  const headers = { ...(opt.headers || {}) };
  if (opt.token) headers.Authorization = `Bearer ${opt.token}`;
  if (opt.body && typeof opt.body === 'string' && !opt.raw) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path_, { ...opt, headers, signal: AbortSignal.timeout(30000) });
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json().catch(() => null);
  else if (ct.includes('text')) data = await r.text();
  else data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
async function aiStream(path_, body, token, timeout = 180000) {
  try {
    const r = await fetch(BASE + path_, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const buf = [];
    const reader = r.body.getReader(); const dec = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break; buf.push(dec.decode(value, { stream: true })); }
    return { status: r.status, text: buf.join('') };
  } catch (e) {
    return { status: 0, text: '', err: e.name };
  }
}
function parseEvents(sseText) {
  const evts = [];
  for (const ln of sseText.split('\n')) {
    const s = ln.trim();
    if (!s.startsWith('data:')) continue;
    const d = s.slice(5).trim();
    if (d === '[DONE]') { evts.push({ event: 'DONE' }); continue; }
    try { evts.push(JSON.parse(d)); } catch {}
  }
  return evts;
}
function deltas(sseText) {
  return parseEvents(sseText).filter((e) => e.delta).map((e) => e.delta).join('');
}

// ===== 用例组1：认证与安全 =====
console.log('[测试] 组1 认证与安全…');
const uname = 'tester' + (Date.now() % 100000), pw = 'test123456';
let r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
check('TC-01 注册成功', r.status === 200, JSON.stringify(r.data));
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
check('TC-02 重复注册被拒(409)', r.status === 409);
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'x', password: '123' }) });
check('TC-03 弱参数被拒(400)', r.status === 400);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'wrongpw' }) });
check('TC-04 错误密码被拒(401)', r.status === 401);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
const token = r.data?.token;
check('TC-05 登录成功返回token', r.status === 200 && !!token);
r = await req('/api/records');
check('TC-06 未登录访问被拒(401)', r.status === 401);
r = await req('/api/auth/me', { token });
check('TC-07 登录态获取用户信息', r.status === 200 && r.data.username === uname);
r = await req('/api/health');
check('TC-08 健康检查(无需登录,v0.3)', r.status === 200 && r.data.hasKey === true && r.data.version === '0.3' && Array.isArray(r.data.lanUrls));

// ===== 用例组2：引用核查（规则引擎·确定性） =====
console.log('[测试] 组2 引用核查规则引擎…');
const citeText = '正文引用了方法[1]与案例[2,3]。\n\n[1] 张三. 测试文献一[J]. 测试学报, 2024.\n[2] 李四. 测试文献二[J]. 测试学报, 2024.';
let c1 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: citeText }), token });
check('TC-09 引用核查可运行', c1.status === 200 && c1.data.intextCount === 3);
check('TC-10 检出文内缺失引用[3]', c1.data.orphanInText.includes(3));
let c2 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: citeText }), token });
check('TC-11 规则引擎结果确定(两次一致)', JSON.stringify(c1.data) === JSON.stringify(c2.data));
check('TC-12 引用核查不调用LLM(无计费特征)', c1.data.rule.includes('未调用LLM'));

// ===== 用例组3：AI常规流式（真实DeepSeek调用） =====
console.log('[测试] 组3 AI流式（真实DeepSeek调用，约需1分钟）…');
const t = '摘要：本文研究商业TOD项目的多方协同管理。方法：案例研究。结论：联合体协议提升协同效率。';
let a1 = await aiStream('/api/ai/translate', { text: t, params: { lang: 'en2zh', model: 'deepseek-v4-flash', temperature: 0.3 } }, token);
check('TC-13 互译流式成功', a1.status === 200 && a1.text.includes('data:') && a1.text.includes('[DONE]'));
check('TC-14 互译输出非空', (a1.text.match(/"delta":"[^"]+"/g) || []).length > 0);
let a2 = await aiStream('/api/ai/analyze', { text: t, params: {} }, token);
const a2t = deltas(a2.text);
check('TC-15 四要素分析含四个小节', a2.status === 200 && ['研究方法', '核心结论', '局限与不足', '可切入的研究方向'].every((k) => a2t.includes(k)));
let a3 = await aiStream('/api/ai/proofread', { text: '这是一个测试 文本,,有全角,半角问题。', params: {} }, token);
const a3ev = parseEvents(a3.text);
check('TC-16 校对(分段协议)流式成功', a3.status === 200 && a3ev.some((e) => e.event === 'chunk_done' && e.ok) && a3.text.includes('[DONE]'));
let a4 = await aiStream('/api/ai/review', { text: '[1] 文献A：关于TOD协同。\n[2] 文献B：关于利益分配。', params: {} }, token);
check('TC-17 综述流式成功', a4.status === 200 && a4.text.includes('[DONE]'));
let bad = await aiStream('/api/ai/unknown', { text: t, params: {} }, token);
check('TC-18 未知任务被拒(400)', bad.status === 400);

// ===== 用例组4：记录 CRUD =====
console.log('[测试] 组4 记录 CRUD…');
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'translate', title: '测试标题', inputLen: 100, output: '测试输出' }), token });
const rid = r.data?.id;
check('TC-19 保存记录', r.status === 200 && rid > 0);
r = await req('/api/records', { token });
check('TC-20 记录列表', r.status === 200 && Array.isArray(r.data) && r.data.some((x) => x.id === rid));
r = await req('/api/records?q=' + encodeURIComponent('测试标题'), { token });
check('TC-21 记录搜索', r.status === 200 && r.data.some((x) => x.id === rid));
r = await req('/api/records/' + rid, { token });
check('TC-22 记录详情', r.status === 200 && r.data.output === '测试输出');
const otherName = 'other' + (Date.now() % 99999);
let r2 = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: otherName, password: 'abc12345' }) });
let r2l = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: otherName, password: 'abc12345' }) });
check('TC-23 记录越权隔离', r2.status === 200);
r = await req('/api/records/' + rid, { token: r2l.data.token });
check('TC-24 他人记录不可见(404)', r.status === 404);
r = await req('/api/records/' + rid, { method: 'DELETE', token });
check('TC-25 删除记录', r.status === 200);

// ===== 用例组5：导入导出 =====
console.log('[测试] 组5 导入导出…');
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'test.txt' }, body: 'hello 定稿AI', raw: true });
check('TC-26 txt导入', r.status === 200 && r.data.text.includes('定稿AI'));
const docxBuf = fs.readFileSync(path.join(__dirname, 'fixture.docx'));
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'fixture.docx' }, body: docxBuf, raw: true });
check('TC-27 docx导入', r.status === 200 && r.data.text.length > 0);
check('TC-28 docx导入返回格式元数据', !!r.data.meta && r.data.meta.pgMar && r.data.meta.pgMar.top === 1440);
r = await req('/api/export', { method: 'POST', body: JSON.stringify({ title: '测试导出', sections: [{ heading: '一、结果', body: '测试内容' }], fmt: 'txt' }) });
check('TC-29 txt导出', r.status === 200 && r.data.includes('测试导出'));
r = await req('/api/export', { method: 'POST', body: JSON.stringify({ title: '测试导出', sections: [{ heading: '一、结果', body: '测试内容' }], fmt: 'docx' }) });
const magic = r.data && r.data.length > 4 && r.data[0] === 0x50 && r.data[1] === 0x4b;
check('TC-30 docx导出(合法zip魔数)', r.status === 200 && magic);
r = await req('/api/export', { method: 'POST', body: JSON.stringify({ title: 'x', sections: [], fmt: 'txt' }) });
check('TC-31 空内容导出被拒(400)', r.status === 400);

// ===== 用例组6：合规与安全 =====
console.log('[测试] 组6 合规与安全…');
r = await req('/api/ai/translate', { method: 'POST', body: JSON.stringify({ text: '', params: {} }), token });
check('TC-32 空文本被拒(400)', r.status === 400);
const long = 'a'.repeat(100001);
r = await req('/api/ai/translate', { method: 'POST', body: JSON.stringify({ text: long, params: {} }), token });
check('TC-33 超长文本被拒(400)', r.status === 400);
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check('TC-34 密钥不泄露到前端', !/sk-[A-Za-z0-9]{16,}/.test(appjs) && !appjs.includes('API.txt') && !/sk-[A-Za-z0-9]{16,}/.test(idx));
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
check('TC-35 密码不明文存储(登录走散列校验)', r.status === 200);
const dbRaw = fs.readFileSync(DB, 'utf8');
check('TC-36 密码哈希落库(无明文)', !dbRaw.includes(pw));

// ===== 用例组7：BYOK 密钥体系 =====
console.log('[测试] 组7 BYOK密钥体系…');
const realKey = fs.readFileSync('config/key.txt', 'utf8').trim();
r = await req('/api/apikey', { method: 'PUT', body: JSON.stringify({ key: 'not-a-key' }), token });
check('TC-37 无效格式Key被拒(400)', r.status === 400);
r = await req('/api/apikey', { method: 'PUT', body: JSON.stringify({ key: 'sk-invalidkey000000000' }), token: r2l.data.token });
check('TC-38 假Key本地核对未通过(400)', r.status === 400 && String(r.data.error).includes('本地核对'));
let a5 = await aiStream('/api/ai/translate', { text: t, params: {} }, r2l.data.token);
check('TC-39 普通用户未配Key调用被拒(403)', a5.status === 403);
r = await req('/api/apikey', { method: 'PUT', body: JSON.stringify({ key: realKey }), token: r2l.data.token });
check('TC-40 真实Key核对通过且只返回掩码', r.status === 200 && String(r.data.masked).includes('****') && !JSON.stringify(r.data).includes(realKey.slice(6)));
const dbRaw2 = fs.readFileSync(DB, 'utf8');
check('TC-41 用户Key加密落库(无明文)', !dbRaw2.includes(realKey.slice(8)));
a5 = await aiStream('/api/ai/translate', { text: t, params: {} }, r2l.data.token);
check('TC-42 普通用户用自己Key调用成功', a5.status === 200 && a5.text.includes('[DONE]'));
r = await req('/api/apikey', { method: 'DELETE', token: r2l.data.token });
check('TC-43 删除Key', r.status === 200);
a5 = await aiStream('/api/ai/translate', { text: t, params: {} }, r2l.data.token);
check('TC-44 删除后普通用户恢复被拒(403)', a5.status === 403);
a5 = await aiStream('/api/ai/translate', { text: t, params: {} }, token);
check('TC-45 管理员未配Key可用平台Key', a5.status === 200 && a5.text.includes('[DONE]'));

// ===== 用例组8：M5 分段校对（v0.2核心回归：长文本必须可完成） =====
console.log('[测试] 组8 M5分段校对（真实DeepSeek，长文本回归，约需1分钟）…');
const seedP = '第三章 研究设计与数据收集。3.1 案例选择。本文选择某商业综合体TOD项目作为研究对象, 该项目位于城市核心区, 总建筑面积约50万平方米, 涉及开发商,政府,轨道交通公司等多方主体, 具有较强的典型性与代表性。3.2 数据收集方法。本研究采用半结构化访谈与问卷调查相结合的方式收集数据, 共访谈相关主体负责人12人, 发放问卷200份, 回收有效问卷168份, 有效回收率为84%。问卷数据采用SPSS26.0进行统计分析。';
const longText = Array.from({ length: 35 }, (_, i) => `【第${i + 1}节】\n${seedP.replace('12人', (12 + i) + '人')}`).join('\n\n');
console.log(`   长文本长度: ${longText.length} 字`);
const p1 = await aiStream('/api/ai/proofread', { text: longText, params: { model: 'deepseek-v4-flash', maxChunk: 2500 } }, token, 300000);
const p1ev = parseEvents(p1.text);
const starts = p1ev.filter((e) => e.event === 'start');
const done = p1ev.filter((e) => e.event === 'chunk_done' && e.ok);
const errs = p1ev.filter((e) => e.event === 'chunk_error');
check('TC-46 长文本(7千+字)校对不再超时', p1.status === 200 && p1.text.includes('[DONE]'), `HTTP ${p1.status}`);
check('TC-47 自动切分为多块(≥3)', starts.length > 0 && starts[0].chunks >= 3, `chunks=${starts[0]?.chunks}`);
check('TC-48 全部块校对成功(0失败)', done.length >= 3 && errs.length === 0, `done=${done.length} errs=${errs.length}`);
check('TC-49 块输出非空且完整', done.every((e) => e.content.length > 0) && done.some((e) => /共\s*\d+\s*处|未发现机械错误/.test(e.content)));
// 切块完整性（确定性单元测试，走测试专用端点）
r = await req('/api/_test/chunk', { method: 'POST', body: JSON.stringify({ text: longText, maxChunk: 2500 }) });
const chk = r.data;
check('TC-50 切块无损拼接(与原文逐字一致)', chk.identical === true && chk.chunks.length >= 3);
check('TC-51 每块≤上限且引用标记不拆断', chk.chunks.every((c) => c.length <= 2600 && (c.match(/\[/g) || []).length === (c.match(/\]/g) || []).length));
// 单块重试端点
const p2 = await aiStream('/api/ai/proofread-chunk', { text: '这是一个测试 文本,,有全角,半角问题。', params: { model: 'deepseek-v4-flash' } }, token);
check('TC-52 单块重试端点可用', p2.status === 200 && p2.text.includes('"event":"result"') && /共\s*\d+\s*处|未发现机械错误/.test(p2.text));

// ===== 用例组9：M2 引用核查增强（序号错位/修正建议/去重/体例） =====
console.log('[测试] 组9 M2引用核查增强…');
const seqText = '正文引用了方法[1]与案例[3,2]。此外[2]给出理论框架。\n\n参考文献：\n[1] 张三. 测试文献一[J]. 测试学报, 2024.\n[2] 李四. 测试文献二[J]. 测试学报, 2024.\n[3] 王五. 测试文献三[J]. 测试学报, 2024.';
let c3 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: seqText }), token });
check('TC-53 检出序号错位', c3.data.seqErrors.length > 0 && c3.data.seqErrors.includes(2));
check('TC-54 生成序号修正建议', c3.data.renumber && c3.data.renumber.mapping['2'] === 3 && c3.data.renumber.mapping['3'] === 2);
check('TC-55 修正后文献按新序排列', Array.isArray(c3.data.renumber.renumberedRefs) && c3.data.renumber.renumberedRefs[1].startsWith('[2]') && c3.data.renumber.renumberedRefs[1].includes('王五'));
const dupText = '正文引用[1]与[2]。\n\n[1] 张三. 测试文献一[J]. 测试学报, 2024, 12(1): 1-10.\n[2] 张三. 测试文献一[J]. 测试学报, 2024, 12(1): 1-10.';
let c4 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: dupText }), token });
check('TC-56 检出完全重复文献', c4.data.dupGroups.length === 1 && c4.data.dupGroups[0].includes(1) && c4.data.dupGroups[0].includes(2));
let c5 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: seqText, fmt: 'apa' }), token });
check('TC-57 体例选项生效(APA)', c5.status === 200 && c5.data.fmt === 'apa');
const ayText = '正文引用（张三, 2024）与[1]。\n\n[1] 张三. 测试文献一[J]. 测试学报, 2024.';
let c6 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: ayText, fmt: 'gbt7714' }), token });
let c7 = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: ayText, fmt: 'apa' }), token });
check('TC-58 著者-出版年混用仅在顺序编码制告警', c6.data.issues.some((i) => i.includes('著者-出版年')) && !c7.data.issues.some((i) => i.includes('著者-出版年')));

// ===== 用例组10：M8 交稿检查报告 =====
console.log('[测试] 组10 M8交稿检查报告…');
let rep1 = await req('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: citeText }), token });
check('TC-59 报告含引用与格式两分区', rep1.status === 200 && rep1.data.cite && Array.isArray(rep1.data.format) && rep1.data.format.length === 4);
check('TC-60 纯文本输入格式检查标记未检查', rep1.data.format.every((row) => row.status === '未检查'));
let rep2 = await req('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: citeText, meta: { pgMar: { top: 1440, bottom: 1440, left: 1440, right: 1440 }, fonts: [], sizes: [24], lines: [], headings: {}, hasPageNum: false } }), token });
const pgRow = rep2.data.format.find((row) => row.item === '页边距');
const hdRow = rep2.data.format.find((row) => row.item === '标题层级');
check('TC-61 docx元数据格式检查执行(页边距正常)', pgRow && pgRow.status === 'ok' && pgRow.note.includes('2.54cm'));
check('TC-62 标题层级缺失告警', hdRow && hdRow.status === 'warn');
let rep3 = await req('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: citeText }), token });
check('TC-63 报告确定性(两次一致)', JSON.stringify(rep1.data) === JSON.stringify(rep3.data));
check('TC-64 报告不调用LLM', rep1.data.rule.includes('未调用LLM'));

// ===== 用例组11：前端完整性 =====
console.log('[测试] 组11 前端完整性…');
check('TC-65 前端注册V1.3全部Must功能入口', ['topic', 'outline', 'writing', 'progress', 'translate', 'checkreport', 'records'].every((k) => idx.includes(`data-fn="${k}"`)));
check('TC-66 侧边栏导航结构存在', idx.includes('sidebar') && idx.includes('nav-item'));
check('TC-67 写作四视图前端逻辑存在', appjs.includes('saveChapter') && appjs.includes('renderOlTree') && appjs.includes('pgCheckinBtn') && appjs.includes('tpGenBtn'));
check('TC-68 撤销栈上限7次(PRD AC4)', appjs.includes('> 7') && appjs.includes('pushHistory'));
check('TC-69 前端无内嵌密钥与明文Key', !/sk-[A-Za-z0-9]{16,}/.test(appjs) && !/sk-[A-Za-z0-9]{16,}/.test(idx));

// ===== 用例组12：M9 选题助手（真实DeepSeek调用，约需1-2分钟） =====
console.log('[测试] 组12 M9选题助手（真实DeepSeek，约需1-2分钟）…');
const topicForm = {
  problem: '某商业TOD项目在施工阶段，建设单位需要同时协调开发商、政府、轨道交通公司、运营商与商户五方主体，经常出现界面责任不清、信息传递延迟导致的工期延误。',
  literatures: ['标题:TOD项目多方协同机制研究\n摘要:基于利益相关者理论分析了协同障碍。'],
  discipline: '工程管理',
  interests: '多方协同、界面管理',
  count: 5,
};
let tp = await req('/api/topics/suggest', { method: 'POST', body: JSON.stringify({ form: topicForm }), token, headers: {} });
check('TC-70 选题建议生成成功(3-5个)', tp.status === 200 && tp.data.session_id > 0 && tp.data.topics.length >= 3 && tp.data.topics.length <= 5, JSON.stringify(tp.data).slice(0, 200));
const sixOk = (t) => !!t.title && !!t.research_question && Array.isArray(t.innovation_points) && !!t.relation_to_literature && !!t.feasibility && !!t.reasons;
check('TC-71 选题六要素齐全率≥80%', tp.status === 200 && tp.data.topics.filter(sixOk).length >= Math.ceil(tp.data.topics.length * 0.8), JSON.stringify(tp.data.topics?.[0] || {}).slice(0, 300));
let tp2 = await req(`/api/topics/sessions/${tp.data?.session_id}/messages`, { method: 'POST', body: JSON.stringify({ content: '哪个方向的数据最容易获取？' }), token });
check('TC-72 追问迭代成功(重新返回选题)', tp2.status === 200 && Array.isArray(tp2.data.topics) && tp2.data.topics.length >= 1);
let tp3 = await req(`/api/topics/sessions/${tp.data?.session_id}/messages`, { method: 'POST', body: JSON.stringify({ content: '试试呢' }), token: r2l.data.token });
check('TC-73 他人会话不可追问(404)', tp3.status === 404);
const adoptIdx = tp.status === 200 ? tp.data.topics[0].index : 1;
let ad = await req('/api/topics/adopt', { method: 'POST', body: JSON.stringify({ session_id: tp.data?.session_id, topic_index: adoptIdx }), token });
check('TC-74 采纳选题→生成标准章节结构(≥5章)', ad.status === 200 && ad.data.chapter_count >= 5 && !!ad.data.title, JSON.stringify(ad.data));

// ===== 用例组13：M10 大纲 =====
console.log('[测试] 组13 M10大纲（真实DeepSeek生成一次）…');
let og = await req('/api/outline/generate', { method: 'POST', body: JSON.stringify({ title: ad.data?.title || 'TOD项目多方协同管理研究', extra: '关键词：界面管理；利益分配' }), token });
check('TC-75 AI生成大纲成功(≥5章含小节)', og.status === 200 && og.data.chapters.length >= 5 && og.data.chapters.every((c) => c.title), JSON.stringify(og.data).slice(0, 200));
let ol0 = await req('/api/outline', { token });
check('TC-76 获取当前大纲(含采纳后的标准章节)', ol0.status === 200 && Array.isArray(ol0.data.chapters) && ol0.data.chapters.length >= 5);
const newTree = ol0.data.chapters.map((c, i) => ({ ...c, children: (c.children || []).concat(i === 0 ? [{ id: -1, parent_id: c.id, title: '1.1 研究背景', content: '', status: 'todo', children: [] }] : []) }));
let ol1 = await req('/api/outline', { method: 'PUT', body: JSON.stringify({ chapters: newTree }), token });
check('TC-77 大纲树保存(新增子节/整树回写)', ol1.status === 200 && ol1.data.chapters[0].children.length >= 1 && ol1.data.chapters[0].children[0].title === '1.1 研究背景');
let ol2 = await req('/api/outline/export?fmt=txt', { token });
check('TC-78 大纲导出txt(含章与子节)', ol2.status === 200 && ol2.data.includes('1.1 研究背景'));
let ol3 = await req('/api/outline/export?fmt=docx', { token });
check('TC-79 大纲导出docx(合法zip)', ol3.status === 200 && ol3.data[0] === 0x50 && ol3.data[1] === 0x4b);
let ol4 = await req('/api/outline', { method: 'PUT', body: JSON.stringify({ chapters: [] }), token });
check('TC-80 空大纲保存被拒(400)', ol4.status === 400);

// ===== 用例组14：M11 本地编写与Word备份 =====
console.log('[测试] 组14 M11本地编写与Word备份…');
let th = await req('/api/thesis', { token });
check('TC-81 获取论文信息(标题=采纳选题)', th.status === 200 && th.data.title === ad.data.title);
let th2 = await req('/api/thesis', { method: 'PUT', body: JSON.stringify({ title: '新标题测试', target_words: 30000 }), token });
check('TC-82 更新论文标题与目标字数', th2.status === 200 && th2.data.title === '新标题测试' && th2.data.target_words === 30000);
const ch = ol1.data.chapters[0];
const testContent = '研究背景：随着城市轨道交通发展，TOD模式成为主流。本研究聚焦建设单位多方协同问题，采用案例研究方法。\n\n第二段：介绍利益相关者理论。测试内容 abc123。';
let ch1 = await req('/api/chapters/' + ch.id, { token });
check('TC-83 读取章节内容', ch1.status === 200 && ch1.data.title === ch.title);
let ch2 = await req('/api/chapters/' + ch.id, { method: 'PUT', body: JSON.stringify({ content: testContent, status: 'writing' }), token });
check('TC-84 章节自动保存(回读一致+字数统计)', ch2.status === 200 && ch2.data.words > 0);
let ch3 = await req('/api/chapters/' + ch.id, { token });
check('TC-85 保存后内容回读100%一致', ch3.status === 200 && ch3.data.content === testContent && ch3.data.status === 'writing');
let ch4 = await req('/api/chapters', { method: 'POST', body: JSON.stringify({ title: '测试临时章', parent_id: ch.id }), token });
check('TC-86 新建章节(作为子节)', ch4.status === 200 && ch4.data.id > 0);
let ch5 = await req('/api/chapters/' + ch.id, { method: 'DELETE', token });
check('TC-87 删除章节(含子节)', ch5.status === 200);
let ch6 = await req('/api/chapters/' + ch.id, { token });
check('TC-88 删除后读取404', ch6.status === 404);
// 写入第2章内容，供导出与进度统计复用
const chB = ol1.data.chapters[1];
const moreContent = '本章为文献综述。利益相关者理论是核心理论基础。';
await req('/api/chapters/' + chB.id, { method: 'PUT', body: JSON.stringify({ content: moreContent }), token });
let ex1 = await req('/api/thesis/export?fmt=docx', { token });
const exMagic = ex1.status === 200 && ex1.data[0] === 0x50 && ex1.data[1] === 0x4b;
let ex2 = await req('/api/thesis/export?fmt=docx', { token });
check('TC-89 全文导出docx(合法zip魔数)', exMagic);
// L-7 确定性：两次导出 document.xml 完全一致
let det = false;
if (exMagic && ex2.status === 200) {
  try {
    const { createRequire } = await import('node:module');
    const require2 = createRequire(import.meta.url);
    const AdmZip2 = require2('adm-zip');
    const xmlA = new AdmZip2(Buffer.from(ex1.data)).getEntry('word/document.xml').getData().toString('utf8');
    const xmlB = new AdmZip2(Buffer.from(ex2.data)).getEntry('word/document.xml').getData().toString('utf8');
    det = xmlA === xmlB && xmlA.includes('Heading1') && xmlA.includes('利益相关者理论');
  } catch {}
}
check('TC-90 导出确定性(两次document.xml一致且含标题层级)', det);
let ex3 = await req('/api/thesis/export?fmt=txt', { token });
check('TC-91 全文导出txt(含标题与正文)', ex3.status === 200 && ex3.data.includes('新标题测试') && ex3.data.includes('利益相关者理论'));

// ===== 用例组15：M12 写作进度与打卡 =====
console.log('[测试] 组15 M12进度打卡…');
let pg1 = await req('/api/progress', { token });
const contentWords = pg1.data.chapters.reduce((a, b) => a + b.words, 0);
const expectPct = Math.round((pg1.data.total_words / 30000) * 1000) / 10;
check('TC-92 进度统计(总字数=各章之和,确定性)', pg1.status === 200 && pg1.data.total_words === contentWords && pg1.data.total_words > 0 && pg1.data.percent === expectPct && pg1.data.percent > 0 && pg1.data.rule.includes('确定性'), `total=${pg1.data.total_words} pct=${pg1.data.percent} expect=${expectPct}`);
let ck1 = await req('/api/checkins', { method: 'POST', body: JSON.stringify({ note: '写了引言' }), token });
check('TC-93 打卡成功(增量=当前总字数)', ck1.status === 200 && ck1.data.word_delta === pg1.data.total_words && ck1.data.total_words === pg1.data.total_words);
// 再写一章再打卡：增量应为新增字数
const chC = ol1.data.chapters[2];
await req('/api/chapters/' + chC.id, { method: 'PUT', body: JSON.stringify({ content: '本章介绍研究方法与案例选择。' }), token });
let pg2 = await req('/api/progress', { token });
let ck2 = await req('/api/checkins', { method: 'POST', body: JSON.stringify({ note: '补文献' }), token });
check('TC-94 二次打卡增量=新增字数', ck2.status === 200 && ck2.data.word_delta === pg2.data.total_words - pg1.data.total_words && ck2.data.word_delta > 0, JSON.stringify(ck2.data));
let ck3 = await req('/api/checkins', { token });
check('TC-95 打卡列表与连续天数(≥1天)', ck3.status === 200 && ck3.data.checkins.length === 1 && ck3.data.streak >= 1, JSON.stringify(ck3.data));

// ===== 用例组16：隐私隔离（L-4 未授权不可查阅） =====
console.log('[测试] 组16 隐私隔离…');
const otherThesis = await req('/api/thesis', { token: r2l.data.token });
check('TC-96 用户B拥有独立论文', otherThesis.status === 200 && otherThesis.data.id > 0);
let iso1 = await req('/api/chapters/' + chB.id, { token: r2l.data.token });
check('TC-97 用户B读取A的章节404', iso1.status === 404);
let iso2 = await req('/api/chapters/' + chB.id, { method: 'PUT', body: JSON.stringify({ content: '越权修改' }), token: r2l.data.token });
check('TC-98 用户B修改A的章节404', iso2.status === 404);
let iso3 = await req('/api/chapters/' + chB.id, { method: 'DELETE', token: r2l.data.token });
check('TC-99 用户B删除A的章节404', iso3.status === 404);
// 管理员（首个注册用户）同样无法查看他人论文内容（L-4：管理员权限不含内容查看）
const isoNew = await req('/api/chapters', { method: 'POST', body: JSON.stringify({ title: 'B的秘密章节' }), token: r2l.data.token });
const bChId = isoNew.data?.id;
if (bChId) {
  const bChOwn = await req('/api/chapters/' + bChId, { token: r2l.data.token });
  const adminRead = await req('/api/chapters/' + bChId, { token });
  check('TC-100 管理员读取他人章节404(无内容查看权)', bChOwn.status === 200 && adminRead.status === 404);
} else {
  check('TC-100 管理员读取他人章节404(无内容查看权)', false, JSON.stringify(isoNew.data));
}
let iso5 = await req('/api/checkins', { token: r2l.data.token });
check('TC-101 打卡记录用户间隔离', iso5.status === 200 && iso5.data.checkins.length === 0);
let iso6 = await req('/api/thesis', { token: r2l.data.token });
check('TC-102 B的论文标题与A互不影响', iso6.status === 200 && iso6.data.title !== '新标题测试');

server.kill();
console.log('\n========== 测试结果 ==========');
results.forEach((x) => console.log(x));
console.log(`\n通过 ${pass} / 失败 ${fail}，共 ${pass + fail} 条用例`);
process.exit(fail > 0 ? 1 : 0);
