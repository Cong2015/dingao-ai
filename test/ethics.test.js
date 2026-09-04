// 定稿AI 测试工程师 · 伦理与合规测试（v0.5 新增第八套件 TC-EC01~EC12；对应合并版计划"测试地图13"）
// 运行：node test/ethics.test.js （自动拉起 8792 测试实例 ethics.db，结束回收）
// 覆盖：B1 告知同意 / B3 委托处理披露 / B4 注销 / C3 投诉举报 / C5 日志留存 / D5-2 埋点看板 /
//       FIND-03 CORS 白名单 / FIND-05 工具端点限流 / A4 标识（前端静态） / 文书三件套静态核验
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8792';
const DB = path.join(__dirname, 'ethics.db');
try { fs.rmSync(DB, { force: true }); } catch {}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: '8792', DINGAO_TEST: '1', DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 3000));
if (server.exitCode !== null) { console.error('测试实例未能启动'); process.exit(2); }

let pass = 0, fail = 0;
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
  else data = await r.text();
  return { status: r.status, data, headers: r.headers };
}

const uname = 'eth_' + Date.now().toString(36).slice(-5);
const pw = 'Ethics#12345';
let token = '';

// ---- TC-EC01 注册协议勾选必填（B1）----
let r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
check('TC-EC01a 未勾选协议注册→400', r.status === 400, `status=${r.status}`);
r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw, agree: true }) });
check('TC-EC01b 勾选协议注册→200', r.status === 200, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
token = r.data && r.data.token;
check('TC-EC01c 登录成功（首个账号=管理员）', !!token, '');

// ---- TC-EC02 同意时间戳与补签（B1）----
r = await req('/api/auth/me', { token });
check('TC-EC02a 注册即带同意时间戳(agreed=true)', r.status === 200 && r.data && r.data.agreed === true, JSON.stringify(r.data));
r = await req('/api/consent', { method: 'POST', token });
check('TC-EC02b 补签接口幂等200', r.status === 200, `status=${r.status}`);

// ---- TC-EC03 账号注销（B4/PIPL47）----
r = await req('/api/auth/delete-account', { method: 'POST', body: JSON.stringify({ password: 'wrongpw1' }), token });
check('TC-EC03a 错误密码注销→401', r.status === 401, `status=${r.status}`);
r = await req('/api/auth/delete-account', { method: 'POST', body: JSON.stringify({ password: pw }), token });
check('TC-EC03b 正确密码注销→200', r.status === 200, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
check('TC-EC03c 注销后登录→401(账号已删除)', r.status === 401, `status=${r.status}`);

// 重建管理员账号供后续用例
await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: pw, agree: true }) });
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: pw }) });
token = r.data && r.data.token;
// 非管理员账号
const otherName = 'ethb_' + Date.now().toString(36).slice(-5);
await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: otherName, password: pw, agree: true }) });
const lr2 = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: otherName, password: pw }) });
const token2 = lr2.data && lr2.data.token;

// ---- TC-EC04 投诉举报落库与管理员查看（C3）----
r = await req('/api/feedback', { method: 'POST', body: JSON.stringify({ type: 'bug', content: '测试反馈：登录页偶发白屏', contact: 't@example.com' }) });
check('TC-EC04a 匿名投诉提交→200', r.status === 200, `status=${r.status}`);
r = await req('/api/feedback', { method: 'POST', body: JSON.stringify({ type: 'other', content: '' }) });
check('TC-EC04b 空内容→400', r.status === 400, `status=${r.status}`);
r = await req('/api/admin/feedback', { token });
check('TC-EC04c 管理员可查看投诉列表', r.status === 200 && Array.isArray(r.data) && r.data.length >= 1 && r.data[0].status === 'open', `status=${r.status}`);
r = await req('/api/admin/feedback', { token: token2 });
check('TC-EC04d 非管理员→403', r.status === 403, `status=${r.status}`);

// ---- TC-EC05 可观测性看板与日志表（D5-2/C5）----
r = await req('/api/admin/stats', { token });
check('TC-EC05a 管理员统计看板可用(含聚合键)', r.status === 200 && r.data && r.data.totalCalls !== undefined && Array.isArray(r.data.byTask), `status=${r.status}`);
r = await req('/api/admin/stats', { token: token2 });
check('TC-EC05b 非管理员看板→403', r.status === 403, `status=${r.status}`);
const { DatabaseSync } = await import('node:sqlite');
const edb = new DatabaseSync(DB);
const tables = edb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_logs','feedback')").all().map((x) => x.name);
check('TC-EC05c ai_logs/feedback 表存在(日志留存载体)', tables.includes('ai_logs') && tables.includes('feedback'), tables.join(','));
edb.close();

// ---- TC-EC06 CORS Origin 白名单（FIND-03）----
r = await req('/api/health', { headers: { Origin: 'https://cong2015.github.io' } });
check('TC-EC06a github.io Origin→回显ACAO', r.headers.get('access-control-allow-origin') === 'https://cong2015.github.io', String(r.headers.get('access-control-allow-origin')));
r = await req('/api/health', { headers: { Origin: 'https://evil.example.com' } });
check('TC-EC06b 白名单外Origin→不回ACAO(浏览器拦截)', !r.headers.get('access-control-allow-origin'), String(r.headers.get('access-control-allow-origin')));

// ---- TC-EC07 工具端点IP限流（FIND-05，独立于SC05c复证）----
let got429 = 0;
for (let i = 0; i < 65; i++) {
  const rr = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '限流[1]' }) });
  if (rr.status === 429) { got429 = i + 1; break; }
}
check('TC-EC07 工具端点第' + got429 + '次触发429', got429 > 0, '未触发429');

// ---- TC-EC08 AI 标识（前端静态，A4/C4）----
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check('TC-EC08a 输出含[AI生成]模型+时间标识(静态)', appjs.includes('[AI生成]') && appjs.includes('metaModel') && appjs.includes('toLocaleString()'), '');
check('TC-EC08b 首次AI调用披露弹窗存在(静态)', appjs.includes('ensureAiDisclosure') && html.includes('发送至 DeepSeek'), '');

// ---- TC-EC09 文书三件套（B1，静态核验关键条款）----
const priv = fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8');
const terms = fs.readFileSync(path.join(__dirname, '..', 'public', 'terms.html'), 'utf8');
const ethics = fs.readFileSync(path.join(__dirname, '..', 'public', 'ethics.html'), 'utf8');
check('TC-EC09a 隐私政策含DeepSeek委托处理披露', priv.includes('DeepSeek') && priv.includes('本地优先'), '');
check('TC-EC09b 隐私政策含日志留存≥6个月与注销权利', priv.includes('不少于六个月') && priv.includes('注销'), '');
check('TC-EC09c 用户协议含版权归属与学术边界', terms.includes('归您所有') && terms.includes('学术诚信'), '');
check('TC-EC09d 学术诚信规范含禁止直接提交', ethics.includes('禁止将 AI 生成内容直接作为本人学术成果提交') && ethics.includes('学位法'), '');

// ---- TC-EC10 注册弹窗协议勾选（前端静态）----
check('TC-EC10 注册页三协议勾选+年龄确认(静态)', html.includes('agreeTerms') && html.includes('agreePrivacy') && html.includes('agreeEthics') && html.includes('agreeAge'), '');

// ---- TC-EC11 v4-pro 移除 UI（收敛项，静态）----
check('TC-EC11 模型下拉仅剩v4-flash(收敛)', appjs.includes('deepseek-v4-flash') && !appjs.includes('value="deepseek-v4-pro"'), '');

// ---- TC-EC12 前端无论文存储端点引用（契约红线，静态）----
check('TC-EC12 前端不引用论文存储端点', !/\/api\/thes|\/api\/chapters|\/api\/checkins|\/api\/progress/.test(appjs), '');

server.kill();
console.log(`\n[伦理合规] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项断言）`);
process.exit(fail ? 1 : 0);
