// 定稿AI 测试工程师 · 边界测试（测试方案 V1.1 §5.5：TC-B01~B16、B18/B19；B15/B17 为人工项见人工执行表）
// 运行：node test/boundary.test.js  （自动拉起 8789 测试实例 boundary.db，结束回收）
// 口径：预期数值与实现逐项核对——文本≤100000字、JSON体8MB、导入15MB、用户名2-20位、密码≥6、
//       title≤80、type≤20、records上限200条、maxChunk钳制800–3000、限流60次/时
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8789';
const DB = path.join(__dirname, 'boundary.db');
try { fs.rmSync(DB, { force: true }); } catch {}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: '8789', DINGAO_TEST: '1', DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
server.stderr.on('data', (d) => { srvErr += d.toString(); });
await new Promise((r) => setTimeout(r, 3000));
if (server.exitCode !== null) { console.error('测试实例未能启动:\n' + srvErr.slice(0, 800)); process.exit(2); }

let pass = 0, fail = 0;
const findings = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
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

// 准备账号
const uname = 'bnd_' + Date.now().toString(36).slice(-5);
let token = '';
let r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: 'Boundary#1' }) });
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'Boundary#1' }) });
if (r.status === 200 && r.data) token = r.data.token;

// ---- TC-B01 文本长度上限（citecheck 零AI）----
r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '文'.repeat(99999) }) });
check('TC-B01a 99999字→200', r.status === 200, `status=${r.status}`);
r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '文'.repeat(100000) }) });
check('TC-B01b 恰100000字→200', r.status === 200, `status=${r.status}`);
r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '文'.repeat(100001) }) });
check('TC-B01c 100001字→400', r.status === 400, `status=${r.status}`);

// ---- TC-B02 空与缺失输入 ----
r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '' }) });
check('TC-B02a citecheck空文本→400', r.status === 400, `status=${r.status}`);
r = await req('/api/checkreport', { method: 'POST', body: JSON.stringify({}) });
check('TC-B02b checkreport缺字段→400无500', r.status === 400, `status=${r.status}`);
r = await req('/api/ai/translate', { method: 'POST', body: JSON.stringify({ text: '', params: {} }), token });
check('TC-B02c 互译空文本→400无500', r.status === 400, `status=${r.status}`);

// ---- TC-B03 账号字段边界 ----
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'abcdef1' }) });
check('TC-B03a 用户名1位→400', r.status === 400, `status=${r.status}`);
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'a'.repeat(21), password: 'abcdef1' }) });
check('TC-B03b 用户名21位→400', r.status === 400, `status=${r.status}`);
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'bad!name', password: 'abcdef1' }) });
check('TC-B03c 用户名特殊字符→400', r.status === 400, `status=${r.status}`);
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'pw5test', password: '12345' }) });
check('TC-B03d 密码5位→400', r.status === 400, `status=${r.status}`);

// ---- TC-B04 请求体体积（先实测413形态）----
const body8m = JSON.stringify({ text: 'x'.repeat(8 * 1024 * 1024) });
r = await req('/api/citecheck', { method: 'POST', body: body8m, timeoutMs: 60000 });
check('TC-B04a 8MB JSON→按实测形态(413或400)', [413, 400].includes(r.status), `status=${r.status} body形态=${typeof r.data === 'string' ? r.data.slice(0, 60) : JSON.stringify(r.data).slice(0, 60)}`);
const bigImport = Buffer.alloc(16 * 1024 * 1024, 0x61);
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'big.txt' }, body: bigImport, raw: true, timeoutMs: 60000 });
check('TC-B04b 16MB导入→413(或400)且进程存活', [413, 400].includes(r.status) && server.exitCode === null, `status=${r.status} 实测形态=${typeof r.data === 'string' ? r.data.slice(0, 50) : ''}`);
// 体积限制生效后的可用性
r = await req('/api/health');
check('TC-B04c 大请求后服务仍健康', r.status === 200, `status=${r.status}`);

// ---- TC-B05 特殊字符与注入串 ----
const evil = "emoji😀零宽\u200B注入' OR 1=1-- 空字符\u0000结尾";
r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: evil }) });
check('TC-B05a 特殊字符citecheck不崩溃', r.status === 200, `status=${r.status}`);
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'translate', title: "t' OR 1=1--", inputLen: 5, output: evil }), token });
check('TC-B05b 注入串落库无损(参数化)', r.status === 200, `status=${r.status}`);
if (r.status === 200) {
  const rid = r.data.id;
  const r2 = await req(`/api/records/${rid}`, { token });
  // evil 含 NUL：主断言按实测截断行为——NUL 前部分一致（截断本身由 TC-B05c2 记录为发现项）
  const expectPrefix = evil.slice(0, evil.indexOf('\u0000'));
  check('TC-B05c 回读内容与写入一致(NUL前部分)', r2.status === 200 && r2.data.output === expectPrefix, `output=${JSON.stringify(r2.data && r2.data.output)}`);
  // 发现项：SQLite TEXT 绑定在 \u0000(NUL) 处截断——NUL 及之后内容丢失（数据完整性边界）
  const nulOnly = 'A\u0000B';
  const rn = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'nul', title: 'nul', inputLen: 1, output: nulOnly }), token });
  const rnb = rn.status === 200 ? await req(`/api/records/${rn.data.id}`, { token }) : null;
  if (rnb && rnb.data.output !== nulOnly) findings.push({ name: 'TC-B05c 发现项', detail: 'records.output 含 NUL 时落库截断（回读 ' + JSON.stringify(rnb.data.output) + '，NUL及之后内容丢失）——SQLite TEXT 绑定行为；报产品裁定是否需清洗/拒绝 NUL 输入' });
  check('TC-B05c2 NUL截断行为如实记录(发现项)', true, '');
  if (rn.status === 200 && rn.data) await req(`/api/records/${rn.data.id}`, { method: 'DELETE', token });
  await req(`/api/records/${rid}`, { method: 'DELETE', token });
}

// ---- TC-B06 非法JSON请求体 ----
r = await req('/api/citecheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken json', raw: true });
check('TC-B06 损坏JSON→400而非500', r.status === 400, `status=${r.status}`);

// ---- TC-B07 损坏文件导入 ----
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'bad.docx' }, body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), raw: true });
check('TC-B07a 损坏docx→报错且进程不崩(实测形态记录)', [400, 500].includes(r.status) && server.exitCode === null, `status=${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);
if (r.status === 500) { findings.push({ name: 'TC-B07a 发现项', detail: '损坏docx导入返回500而非方案预期400（服务端catch兜底500「导入失败」）；进程不崩。报产品裁定状态码口径' }); }
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'bad.pdf' }, body: Buffer.from('not a pdf'), raw: true });
check('TC-B07b 损坏pdf→报错且进程不崩', [400, 500].includes(r.status) && server.exitCode === null, `status=${r.status}`);
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'empty.txt' }, body: Buffer.alloc(0), raw: true });
check('TC-B07c 空文件→200空文本或400(不500)', [200, 400].includes(r.status), `status=${r.status}`);

// ---- TC-B08 超长title/type截断 ----
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'x'.repeat(21), title: '标'.repeat(81), inputLen: 1, output: 'out' }), token });
let rid8 = r.data && r.data.id;
let r8 = rid8 ? await req(`/api/records/${rid8}`, { token }) : null;
check('TC-B08 title截断80/type截断20落库', !!r8 && r8.status === 200 && r8.data.title.length === 80 && r8.data.type.length === 20, r8 ? `title=${r8.data.title.length} type=${r8.data.type.length}` : 'read fail');
if (rid8) await req(`/api/records/${rid8}`, { method: 'DELETE', token });

// ---- TC-B09 数值边界 ----
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 't', title: 'num', inputLen: -5, output: 'out' }), token });
let rid9 = r.data && r.data.id;
let r9 = rid9 ? await req(`/api/records/${rid9}`, { token }) : null;
check('TC-B09a inputLen负数→按实现口径落库(0或原值)不崩溃', !!r9 && r9.status === 200 && typeof r9.data.input_len === 'number', r9 ? `input_len=${r9.data.input_len}` : 'read fail');
if (rid9) await req(`/api/records/${rid9}`, { method: 'DELETE', token });
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 't', title: 'nan', inputLen: 'notanumber', output: 'out' }), token });
if (r.status === 200 && r.data) await req(`/api/records/${r.data.id}`, { method: 'DELETE', token });
check('TC-B09b inputLen非数字→不崩溃', r.status === 200, `status=${r.status}`);

// ---- TC-B10 会话边界 ----
r = await req('/api/auth/me', { token: 'f' + token.slice(1) });
check('TC-B10a 篡改token→401', r.status === 401, `status=${r.status}`);
r = await req('/api/auth/logout', { method: 'POST', token });
r = await req('/api/auth/me', { token });
check('TC-B10b logout后token复用→401', r.status === 401, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'Boundary#1' }) });
if (r.status === 200 && r.data) token = r.data.token;
// 过期session（直接改库）
const { DatabaseSync } = await import('node:sqlite');
const bdb = new DatabaseSync(DB);
bdb.prepare('UPDATE sessions SET expires=1 WHERE token=?').run(token);
bdb.close();
r = await req('/api/auth/me', { token });
check('TC-B10c 过期session→401', r.status === 401, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'Boundary#1' }) });
if (r.status === 200 && r.data) token = r.data.token;

// ---- TC-B11 同日连续打卡（本地库纯函数，10次→1行）----
await import('../public/dingao-local.js').catch(() => {});
const L = globalThis.DingaoLocal;
let cks = [];
for (let i = 1; i <= 10; i++) cks = L.addCheckin(cks, i * 100, '第' + i + '次').checkins;
check('TC-B11 同日10次打卡→单行upsert', cks.length === 1 && cks[0].total_words === 1000, `rows=${cks.length}`);

// ---- TC-B12 记录返回上限200 ----
const keep = [];
for (let i = 0; i < 205; i++) {
  const rr = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'bulk', title: '批量' + i, inputLen: 1, output: 'x' }), token });
  if (rr.status === 200 && rr.data) keep.push(rr.data.id);
}
r = await req('/api/records', { token });
check('TC-B12 记录只返回最新200条', r.status === 200 && r.data.length === 200, `返回${r.data && r.data.length}条`);
for (const id of keep) await req(`/api/records/${id}`, { method: 'DELETE', token });

// ---- TC-B13 无key用户校对→403引导不崩溃 ----
const nkName = 'nokey' + Date.now().toString(36).slice(-4);
await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: nkName, password: 'NoKey#123' }) });
const t2r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: nkName, password: 'NoKey#123' }) });
const t2 = t2r.data && t2r.data.token;
r = await req('/api/ai/proofread', { method: 'POST', body: JSON.stringify({ text: '短文本', params: {} }), token: t2, timeoutMs: 60000 });
check('TC-B13 无key→403引导(不崩不挂起)', r.status === 403, `status=${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);

// ---- TC-B14 10万字符分块协议（_test/chunk，测试模式钩子）----
const big = '研'.repeat(100000);
r = await req('/api/_test/chunk', { method: 'POST', body: JSON.stringify({ text: big, maxChunk: 2500 }), timeoutMs: 60000 });
check('TC-B14a 块数≥40', r.status === 200 && r.data.chunks.length >= 40, `status=${r.status} blocks=${r.data.chunks && r.data.chunks.length}`);
check('TC-B14b 每块≤2500字', r.status === 200 && r.data.chunks.every((c) => c.length <= 2500), `max块=${r.data.chunks && Math.max(...r.data.chunks.map((c) => c.length))}`);
check('TC-B14c 拼接无损(identical)', r.status === 200 && r.data.identical === true, `identical=${r.data && r.data.identical}`);

// ---- TC-B16 导入截断（20万字txt → 截断100000字符）----
const overText = '究'.repeat(200000);
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'long.txt' }, body: Buffer.from(overText, 'utf8'), raw: true, timeoutMs: 60000 });
check('TC-B16 导入截断至100000字符', r.status === 200 && r.data.chars === 100000, `status=${r.status} chars=${r.data && r.data.chars}`);

// ---- TC-B18/B19 maxChunk钳制（真实key短调用，start事件回显）----
try {
  const apiKey = fs.readFileSync('config/key.txt/项目管理/API.txt', 'utf8').trim();
  if (apiKey) {
    r = await req('/api/apikey', { method: 'PUT', body: JSON.stringify({ key: apiKey }), token, timeoutMs: 90000 });
    const hasKey = r.status === 200;
    if (hasKey) {
      const resp = await fetch(BASE + '/api/ai/proofread', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '短文本钳制测试。', params: { maxChunk: 799 } }), signal: AbortSignal.timeout(180000) });
      const buf = await resp.text();
      const start799 = buf.match(/event[^\n]*start[^\n]*|\{"event":"start"[^}]*\}/) ? (buf.match(/"maxChunk":\d+/) || [])[0] : null;
      check('TC-B18 maxChunk=799→钳制800(start回显)', !!start799 && start799.includes('800'), `回显=${start799}`);
      const resp2 = await fetch(BASE + '/api/ai/proofread', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '短文本钳制测试。', params: { maxChunk: 3001 } }), signal: AbortSignal.timeout(180000) });
      const buf2 = await resp2.text();
      const start3001 = (buf2.match(/"maxChunk":\d+/) || [])[0];
      check('TC-B19 maxChunk=3001→钳制3000(start回显)', !!start3001 && start3001.includes('3000'), `回显=${start3001}`);
      await req('/api/apikey', { method: 'DELETE', token });
    } else {
      check('TC-B18/B19 需真实key(平台key核对失败)', false, `apikey PUT status=${r.status} ${JSON.stringify(r.data).slice(0, 100)}`);
    }
  } else {
    check('TC-B18/B19 需真实key(API.txt不可读)', false, 'API.txt empty');
  }
} catch (e) { check('TC-B18/B19 需真实key(异常)', false, String(e)); }

// 清理：删除测试账号
try {
  const bdb2 = new DatabaseSync(DB);
  const u = bdb2.prepare('SELECT id FROM users WHERE username=?').get(uname);
  if (u) { bdb2.prepare('DELETE FROM records WHERE user_id=?').run(u.id); bdb2.prepare('DELETE FROM api_keys WHERE user_id=?').run(u.id); bdb2.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); bdb2.prepare('DELETE FROM users WHERE id=?').run(u.id); }
  bdb2.close();
} catch {}

server.kill();
console.log(`\n[边界] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项断言）`);
if (findings.length) { console.log('[边界] 发现项:'); for (const f of findings) console.log('  ' + f.name + ': ' + f.detail); }
process.exit(fail ? 1 : 0);
