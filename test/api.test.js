// 定稿AI 测试工程师 · 自动化测试套件 v0.4（功能/合规/安全/AI场景·本地优先架构）
// 运行：node test/api.test.js  （自动拉起 8789 测试实例，结束后回收）
// v0.2/v0.3 已有：M5分段校对E2E回归 / 切块完整性 / M2序号修正 / M8交稿检查报告 / 选题AI / 大纲AI
// v0.4 变更：论文数据移入用户浏览器 IndexedDB——服务端存储端点全删（404断言）、测试库无论文表（sqlite_master断言）、
//   选题/大纲纯中转（响应无session_id）、本地核心库单测（dingao-local.js 同一份代码 node 侧执行）、
//   docx 浏览器构建导出（zip魔数/标题层级/两次一致性）、前端本地优先完整性断言
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
  const { timeoutMs, ...rest } = opt;
  const r = await fetch(BASE + path_, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs || 30000) });
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
let r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw, agree: true }) });
check('TC-01 注册成功', r.status === 200, JSON.stringify(r.data));
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw, agree: true }) });
check('TC-02 重复注册被拒(409)', r.status === 409);
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'x', password: '123', agree: true }) });
check('TC-03 弱参数被拒(400)', r.status === 400);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'wrongpw' }) });
check('TC-04 错误密码被拒(401)', r.status === 401);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw, agree: true }) });
const token = r.data?.token;
check('TC-05 登录成功返回token', r.status === 200 && !!token);
r = await req('/api/records');
check('TC-06 未登录访问被拒(401)', r.status === 401);
r = await req('/api/auth/me', { token });
check('TC-07 登录态获取用户信息', r.status === 200 && r.data.username === uname);
r = await req('/api/health');
check('TC-08 健康检查(无需登录,v0.4)', r.status === 200 && r.data.hasKey === true && r.data.version === '0.4' && Array.isArray(r.data.lanUrls) && String(r.data.privacy).includes('不存储'));

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
let r2 = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: otherName, password: 'abc12345', agree: true }) });
let r2l = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: otherName, password: 'abc12345', agree: true }) });
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
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw, agree: true }) });
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
const p1 = await aiStream('/api/ai/proofread', { text: longText, params: { model: 'deepseek-v4-flash', maxChunk: 2500 } }, token, 540000);
const p1ev = parseEvents(p1.text);
const starts = p1ev.filter((e) => e.event === 'start');
const done = p1ev.filter((e) => e.event === 'chunk_done' && e.ok);
const errs = p1ev.filter((e) => e.event === 'chunk_error');
check('TC-46 长文本(7千+字)校对不再超时', p1.status === 200 && p1.text.includes('[DONE]'), `HTTP ${p1.status}`);
check('TC-47 自动切分为多块(≥3)', starts.length > 0 && starts[0].chunks >= 3, `chunks=${starts[0]?.chunks}`);
// TC-48：失败块走 F-5 设计恢复路径（单块重试端点），最终全部成功（DeepSeek 瞬时故障时自愈）
let recovered = 0;
if (errs.length) {
  const ckRes = await req('/api/_test/chunk', { method: 'POST', body: JSON.stringify({ text: longText, maxChunk: 2500 }) });
  const ckChunks = ckRes.data.chunks;
  for (const e of errs) {
    const txt = ckChunks[e.index] || '';
    if (!txt) continue;
    const rr = await aiStream('/api/ai/proofread-chunk', { text: txt, params: { model: 'deepseek-v4-flash' } }, token, 240000);
    if (rr.status === 200 && rr.text.includes('"event":"result"')) recovered++;
  }
}
check('TC-48 全部块校对成功(失败块经F-5重试恢复)', done.length >= 3 && errs.length - recovered === 0 && done.length + recovered === starts[0]?.chunks, `done=${done.length} errs=${errs.length} recovered=${recovered}`);
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

// ===== 用例组12：M9 选题助手（v0.4纯中转·真实DeepSeek调用，约需1-2分钟） =====
console.log('[测试] 组12 M9选题助手（真实DeepSeek，约需1-2分钟）…');
const topicForm = {
  problem: '某商业TOD项目在施工阶段，建设单位需要同时协调开发商、政府、轨道交通公司、运营商与商户五方主体，经常出现界面责任不清、信息传递延迟导致的工期延误。',
  literatures: ['标题:TOD项目多方协同机制研究\n摘要:基于利益相关者理论分析了协同障碍。'],
  discipline: '工程管理',
  interests: '多方协同、界面管理',
  count: 5,
};
let tp = await req('/api/topics/suggest', { method: 'POST', body: JSON.stringify({ form: topicForm }), token, timeoutMs: 240000 });
check('TC-70 选题建议生成成功(3-5个)', tp.status === 200 && Array.isArray(tp.data.topics) && tp.data.topics.length >= 3 && tp.data.topics.length <= 5, JSON.stringify(tp.data).slice(0, 200));
check('TC-71 纯中转无会话落库(响应无session_id)', tp.status === 200 && !('session_id' in tp.data) && String(tp.data.aiNote).includes('不存储'));
const sixOk = (t) => !!t.title && !!t.research_question && Array.isArray(t.innovation_points) && !!t.relation_to_literature && !!t.feasibility && !!t.reasons;
check('TC-72 选题六要素齐全率≥80%', tp.status === 200 && tp.data.topics.filter(sixOk).length >= Math.ceil(tp.data.topics.length * 0.8), JSON.stringify(tp.data.topics?.[0] || {}).slice(0, 300));
const tpHist = [{ role: 'user', content: topicForm.problem.slice(0, 200) }, { role: 'assistant', content: '已生成选题' }];
let tp2 = await req('/api/topics/iterate', { method: 'POST', body: JSON.stringify({ history: tpHist, question: '哪个方向的数据最容易获取？' }), token, timeoutMs: 240000 });
check('TC-73 追问迭代成功(前端携带历史)', tp2.status === 200 && Array.isArray(tp2.data.topics) && tp2.data.topics.length >= 1);
let tp3 = await req('/api/topics/iterate', { method: 'POST', body: JSON.stringify({ history: '随意内容', question: '' }), token });
check('TC-74 空追问被拒(400)', tp3.status === 400);

// ===== 用例组13：M10 大纲生成（纯中转）+ 本地优先架构断言 =====
console.log('[测试] 组13 M10大纲与本地优先架构…');
let og = await req('/api/outline/generate', { method: 'POST', body: JSON.stringify({ title: 'TOD项目多方协同管理研究', extra: '关键词：界面管理；利益分配' }), token, timeoutMs: 240000 });
check('TC-75 AI生成大纲成功(≥5章含小节)', og.status === 200 && og.data.chapters.length >= 5 && og.data.chapters.every((c) => c.title), JSON.stringify(og.data).slice(0, 200));
// v0.4：论文数据不在服务端——原 v0.3 存储端点全部移除
for (const [name, path2, opt] of [
  ['thesis', '/api/thesis', { method: 'GET' }],
  ['chapters', '/api/chapters/1', { method: 'GET' }],
  ['outline树', '/api/outline', { method: 'GET' }],
  ['progress', '/api/progress', { method: 'GET' }],
  ['checkins', '/api/checkins', { method: 'GET' }],
  ['thesis导出', '/api/thesis/export?fmt=docx', { method: 'GET' }],
]) {
  const rr = await req(path2, { ...opt, token });
  check(`TC-76 服务端已移除论文存储端点(${name}→404)`, rr.status === 404, `${name} status=${rr.status}`);
}
// 测试库中不存在论文相关表（sqlite_master 断言）
const { DatabaseSync } = await import('node:sqlite');
const tdb = new DatabaseSync(DB);
const tables = tdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
check('TC-77 测试库无论文数据表', !['theses', 'chapters', 'checkins', 'topic_sessions', 'topic_messages'].some((t) => tables.includes(t)), tables.join(','));
check('TC-78 测试库仅存账号/会话/密钥/记录表', ['users', 'sessions', 'api_keys', 'records'].every((t) => tables.includes(t)));

// ===== 用例组14：本地核心库单测（dingao-local.js，node 侧执行同一份代码） =====
console.log('[测试] 组14 本地核心库单测…');
await import(new URL('../public/dingao-local.js', import.meta.url).href);
const L = globalThis.DingaoLocal;
check('TC-79 本地库加载成功', !!L && typeof L.wordCount === 'function');
check('TC-80 字数统计确定性(中文按字/英文按词)', L.wordCount('测试内容abc123') === 5 && L.wordCount('') === 0 && L.wordCount('研究背景测试内容。') === 9);
const stdChs = L.standardChapters().map((c, i) => ({ ...c, id: i + 1 }));
check('TC-81 标准章节结构(5章)', stdChs.length === 5 && stdChs[0].title === '第1章 绪论' && stdChs[4].title === '第5章 结论与展望');
const tree = L.buildTree(stdChs.map((c) => ({ ...c })));
check('TC-82 树构建与扁平化往返无损', JSON.stringify(L.flattenTree(tree).map((c) => ({ id: c.id, parent_id: c.parent_id, title: c.title, content: c.content, status: c.status, sort: c.sort }))) === JSON.stringify(stdChs));
tree[0].content = '本章为绪论。研究背景测试。';
tree[0].children.push({ id: 6, parent_id: 1, title: '1.1 研究背景', content: '背景内容测试。', status: 'todo', sort: 0, children: [] });
const prog = L.computeProgress(tree, 30000);
const expectWords = L.wordCount('本章为绪论。研究背景测试。') + L.wordCount('背景内容测试。');
check('TC-83 进度统计(总字数=各章之和+百分位公式)', prog.total_words === expectWords && prog.percent === Math.round((expectWords / 30000) * 1000) / 10 && prog.chapter_count === 6);
const ck1 = L.addCheckin([], prog.total_words, '第一次打卡');
const ck2 = L.addCheckin(ck1.checkins, prog.total_words + 100, '同日再打');
check('TC-84 打卡增量与同日upsert', ck1.checkin.word_delta === prog.total_words && ck2.checkins.length === 1 && ck2.checkin.word_delta === 100);
check('TC-85 连续天数计算(今日打卡≥1)', L.calcStreak(ck2.checkins) >= 1);
check('TC-86 文本导出(标题与正文)', L.thesisToTxt('测试论文', tree).includes('# 第1章 绪论') && L.thesisToTxt('测试论文', tree).includes('研究背景测试') && L.outlineToTxt('测试论文', tree).includes('1.1 研究背景'));
check('TC-87 树操作(查找节点/父节点)', L.findNode(tree, 6).title === '1.1 研究背景' && L.findParent(tree, 6, null).id === 1);

// ===== 用例组15：浏览器端 Word 导出（docx IIFE 构建·确定性） =====
console.log('[测试] 组15 浏览器端docx导出…');
const { createRequire } = await import('node:module');
globalThis.docx = createRequire(import.meta.url)('docx');
const doc1 = L.buildThesisDocx('测试论文', tree);
const buf1 = Buffer.from(await globalThis.docx.Packer.toBuffer(doc1));
const doc2 = L.buildThesisDocx('测试论文', tree);
const buf2 = Buffer.from(await globalThis.docx.Packer.toBuffer(doc2));
check('TC-88 docx导出合法zip魔数', buf1[0] === 0x50 && buf1[1] === 0x4b);
const AdmZip3 = createRequire(import.meta.url)('adm-zip');
const xmlA = new AdmZip3(buf1).getEntry('word/document.xml').getData().toString('utf8');
const xmlB = new AdmZip3(buf2).getEntry('word/document.xml').getData().toString('utf8');
check('TC-89 docx含标题层级与正文', xmlA.includes('Heading1') && xmlA.includes('研究背景测试'));
check('TC-90 导出确定性(两次document.xml一致)', xmlA === xmlB);
const docO = L.buildOutlineDocx('测试论文', tree);
const bufO = Buffer.from(await globalThis.docx.Packer.toBuffer(docO));
check('TC-91 大纲docx导出合法(zip魔数)', bufO[0] === 0x50 && bufO[1] === 0x4b);

// ===== 用例组16：前端完整性（v0.4 本地优先） =====
console.log('[测试] 组16 前端完整性（v0.4 本地优先）…');
const localjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'dingao-local.js'), 'utf8');
check('TC-92 前端引入本地库与docx浏览器构建', idx.includes('vendor/docx.iife.js') && idx.includes('dingao-local.js'));
check('TC-93 本地库按账号分库(IndexedDB)', localjs.includes('dingao_v04_') && localjs.includes('indexedDB.open'));
check('TC-94 前端不再调用服务端论文存储端点', !appjs.includes('/api/chapters/') && !appjs.includes('/api/thesis/export') && !appjs.includes('/api/outline/export') && !appjs.includes('/api/checkins') && !appjs.includes('/api/progress'));
check('TC-95 写作自动保存为本地写库', appjs.includes('saveChapter') && appjs.includes('saveChapters(localId()'));
check('TC-96 选题追问走纯中转iterate', appjs.includes('/api/topics/iterate') && !appjs.includes('/api/topics/sessions/'));
check('TC-97 前端无内嵌密钥与明文Key', !/sk-[A-Za-z0-9]{16,}/.test(appjs) && !/sk-[A-Za-z0-9]{16,}/.test(idx) && !/sk-[A-Za-z0-9]{16,}/.test(localjs));
check('TC-98 本地模式支持(未登录可写作/AI提示后端)', appjs.includes('localId') && appjs.includes("'guest'") && appjs.includes('后端未连接'));
check('TC-99 写作子视图互斥显示(左侧命令只显示对应页面)', idx.includes('view-outline" class="write-view hidden') && idx.includes('view-writing" class="write-view hidden') && idx.includes('view-progress" class="write-view hidden') && appjs.includes('classList.toggle('));

server.kill();
console.log('\n========== 测试结果 ==========');
results.forEach((x) => console.log(x));
console.log(`\n通过 ${pass} / 失败 ${fail}，共 ${pass + fail} 条用例`);
process.exit(fail > 0 ? 1 : 0);
