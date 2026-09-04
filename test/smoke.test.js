// 定稿AI 测试工程师 · 冒烟套件 v0.5（测试方案 V1.1 §5.3：TC-SM01~08）
// 运行：node test/smoke.test.js   （默认打生产实例 http://localhost:8788，SMOKE_BASE 可改）
// 验收方式（方案 §8）：8 条全过且总时长 ≤60 秒；不依赖真实 DeepSeek（AI 项不涉）；生产库零污染
// 执行治理：写操作仅 tester_smoke_ 前缀账号，执行后清理（records 删除/logout/账号与会话行删除）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SMOKE_BASE || 'http://localhost:8788';
const t0 = Date.now();

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
  const r = await fetch(BASE + path_, { ...opt, headers, signal: AbortSignal.timeout(15000) });
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json().catch(() => null);
  else if (ct.includes('text')) data = await r.text();
  else data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

console.log('[冒烟] TC-SM 套件开始（生产实例 ' + BASE + '）');

// ---- TC-SM01 服务健康 ----
let r = await req('/api/health');
check('TC-SM01 服务健康(200/version/privacy)', r.status === 200 && r.data && r.data.version === '0.5' && typeof r.data.privacy === 'string' && r.data.privacy.includes('不存储'), `status=${r.status} data=${JSON.stringify(r.data)}`);

// ---- TC-SM02 注册登录会话（tester_smoke_ 前缀） ----
const uname = 'smk_' + Date.now().toString(36).slice(-5);   // ≤20位（用户名限制）
const pwd = 'Smoke#2026';
let token = '';
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pwd, agree: true }) });
check('TC-SM02a 注册', r.status === 200, `status=${r.status} ${JSON.stringify(r.data)}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pwd, agree: true }) });
if (r.status === 200 && r.data && r.data.token) token = r.data.token;
check('TC-SM02b 登录', r.status === 200 && !!token, `status=${r.status}`);
r = await req('/api/auth/me', { token });
check('TC-SM02c me返回用户名与hasKey', r.status === 200 && r.data && r.data.username === uname && 'hasKey' in r.data, `status=${r.status} ${JSON.stringify(r.data)}`);

// ---- TC-SM03 引用核查存活（零AI秒级） ----
r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '本文引用文献[1][2]，参考文献：\n[1] 作者A. 论文标题[J]. 期刊, 2020.\n[2] 作者B. 论文标题[J]. 期刊, 2021.' }) });
check('TC-SM03 引用核查存活(200/结构完整)', r.status === 200 && r.data && r.data.intextCount !== undefined && Array.isArray(r.data.seqErrors) && Array.isArray(r.data.dupGroups), `status=${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);

// ---- TC-SM04 交稿检查存活（fixture.docx 导入 meta → checkreport，零AI） ----
let meta = null;
const docxBuf = fs.readFileSync(path.join(__dirname, 'fixture.docx'));
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'fixture.docx' }, body: docxBuf, raw: true });
if (r.status === 200 && r.data && r.data.meta) meta = r.data.meta;
r = await req('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: '导入的论文文本，用于交稿检查。[1]\n参考文献：\n[1] 作者A. 标题[J]. 期刊, 2020.', meta }) });
check('TC-SM04 交稿检查存活(200/行结构完整)', r.status === 200 && r.data && r.data.cite && r.data.format && r.data.rule, `status=${r.status} meta=${!!meta} ${JSON.stringify(r.data).slice(0, 150)}`);

// ---- TC-SM05 记录读写（清理） ----
let rid = null;
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'smoke', title: '冒烟记录', inputLen: 10, output: 'smoke output' }), token });
if (r.status === 200 && r.data && r.data.id) rid = r.data.id;
r = await req('/api/records/' + rid, { token });
check('TC-SM05 记录读写一致', r.status === 200 && r.data && r.data.title === '冒烟记录', `status=${r.status} ${JSON.stringify(r.data)}`);
if (rid) await req('/api/records/' + rid, { method: 'DELETE', token });

// ---- TC-SM06 导入导出 ----
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'smoke.txt' }, body: 'hello 定稿AI smoke', raw: true });
const impText = r.status === 200 && r.data ? r.data.text : '';
r = await req('/api/export', { method: 'POST', body: JSON.stringify({ title: '冒烟导出', sections: [{ heading: '一、冒烟', body: impText }], fmt: 'txt' }) });
check('TC-SM06 txt导入→导出内容一致', r.status === 200 && typeof r.data === 'string' && r.data.includes('冒烟导出') && r.data.includes('定稿AI smoke'), `status=${r.status} imp=${!!impText}`);

// ---- TC-SM07 前端资源加载 ----
const res = await Promise.all(['/', '/app.js', '/vendor/docx.iife.js', '/dingao-local.js', '/index.html'].map((p) => req(p)));
check('TC-SM07 前端资源全部200', res.every((x) => x.status === 200), res.map((x) => x.status).join(','));

// ---- TC-SM08 架构哨兵（六论文端点404 + 生产库无论文表） ----
const names = ['thesis', 'chapters', 'outline树', 'progress', 'checkins', 'thesis导出'];
const paths = ['/api/thesis', '/api/chapters/1', '/api/outline', '/api/progress', '/api/checkins', '/api/thesis/export?fmt=docx'];
for (const [i, p] of paths.entries()) {
  const rr = await req(p, { token });
  check(`TC-SM08a 论文存储端点404(${names[i]})`, rr.status === 404, `${names[i]} status=${rr.status}`);
}
try {
  const { DatabaseSync } = await import('node:sqlite');
  const pdb = new DatabaseSync(path.join(__dirname, '..', 'dingao.db'), { readOnly: true });
  const tables = pdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  pdb.close();
  check('TC-SM08b 生产库无论文数据表', !['theses', 'chapters', 'checkins', 'topic_sessions', 'topic_messages'].some((t) => tables.includes(t)), tables.join(','));
} catch (e) { check('TC-SM08b 生产库无论文数据表', false, String(e)); }

// ---- 清理：tester_smoke_ 账号全量清除（records已删/会话/账号行），生产库零污染 ----
try {
  await req('/api/auth/logout', { method: 'POST', token });
  const { DatabaseSync } = await import('node:sqlite');
  const pdb = new DatabaseSync(path.join(__dirname, '..', 'dingao.db'));
  const u = pdb.prepare('SELECT id FROM users WHERE username=?').get(uname);
  if (u) {
    pdb.prepare('DELETE FROM records WHERE user_id=?').run(u.id);
    pdb.prepare('DELETE FROM api_keys WHERE user_id=?').run(u.id);
    pdb.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    pdb.prepare('DELETE FROM users WHERE id=?').run(u.id);
    console.log('[冒烟] 测试账号已清除（零污染）');
  }
  pdb.close();
} catch (e) { console.log('[冒烟] 清理异常:', String(e)); }

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[冒烟] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项断言）· 用时 ${secs}s`);
if (fail) { console.log('失败明细:'); for (const s of results.filter((x) => x.startsWith('FAIL'))) console.log('  ' + s); }
if (secs > 60) console.log('[冒烟] ⚠️ 超过 60 秒验收线');
process.exit(fail ? 1 : 0);
