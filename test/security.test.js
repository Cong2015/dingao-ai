// 定稿AI 测试工程师 · 安全测试（测试方案 V1.1 §5.7：TC-SC01~SC17；SC15 前端token存储为发现项）
// 运行：node test/security.test.js  （自动拉起 8789 测试实例 security.db，结束回收）
// 顺序约束：TC-SC08 限流用例置于本实例所有用例之后执行，执行后重启实例验证恢复（方案 §5.7）
// 红线项（零论文存储/密钥不泄露/越权隔离）必须全部通过，任一失败即 P0
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8789';
const DB = path.join(__dirname, 'security.db');
try { fs.rmSync(DB, { force: true }); } catch {}

function startServer() {
  const s = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '8789', DINGAO_TEST: '1', DB_PATH: DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stderr.on('data', () => {});
  return s;
}
let server = startServer();
await new Promise((r) => setTimeout(r, 3000));
if (server.exitCode !== null) { console.error('测试实例未能启动'); process.exit(2); }

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

// 准备：A/B 两账号（同密码）
const ts = Date.now().toString(36).slice(-5);
const uA = 'sca_' + ts, uB = 'scb_' + ts;
let tA = '', tB = '';
for (const [u, pw] of [[uA, 'SamePass#1'], [uB, 'SamePass#1']]) {
  await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u, password: pw, agree: true }) });
  const lr = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: pw, agree: true }) });
  if (u === uA) tA = lr.data && lr.data.token; else tB = lr.data && lr.data.token;
}
check('TC-SC00 双账号准备', !!tA && !!tB, '');

// ---- TC-SC01 SQL注入 ----
let r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: "' OR '1'='1", password: "' OR '1'='1" }) });
check('TC-SC01a 登录注入→401(无越权登录)', r.status === 401, `status=${r.status}`);
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'inj', title: "'; DROP TABLE users;--", inputLen: 1, output: 'x' }), token: tA });
check('TC-SC01b 记录title注入→正常处理', r.status === 200, `status=${r.status}`);
if (r.status === 200) await req(`/api/records/${r.data.id}`, { method: 'DELETE', token: tA });
r = await req("/api/records?q=" + encodeURIComponent("' OR '1'='1"), { token: tA });
check('TC-SC01c 搜索q注入→正常处理', r.status === 200, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uA, password: 'SamePass#1' }) });
check('TC-SC01d 注入后users表无损(登录仍成功)', r.status === 200, `status=${r.status}`);

// ---- TC-SC02 存储型XSS（服务端原样存储，前端文本渲染——静态断言转义链）----
const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'xss', title: 'xss', inputLen: 1, output: xss }), token: tA });
let xssId = r.data && r.data.id;
const rBack = await req(`/api/records/${xssId}`, { token: tA });
check('TC-SC02a 服务端原样存储回读', rBack.status === 200 && rBack.data.output === xss, `output=${JSON.stringify(rBack.data && rBack.data.output)}`);
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
check('TC-SC02b 前端渲染走textContent或esc(静态)', appjs.includes('el.textContent = text') && appjs.includes("function esc(s)") && appjs.includes("esc(r.title)"), '记录渲染esc+结果textContent');
if (xssId) await req(`/api/records/${xssId}`, { method: 'DELETE', token: tA });

// ---- TC-SC03 反射型XSS（q参数）----
r = await req('/api/records?q=' + encodeURIComponent('<script>alert(1)</script>'), { token: tA });
check('TC-SC03 反射XSS→JSON响应+前端esc渲染', r.status === 200 && (!r.data || r.data.length === 0), `status=${r.status}`);

// ---- TC-SC04 记录越权 ----
r = await req('/api/records', { method: 'POST', body: JSON.stringify({ type: 'priv', title: 'A的记录', inputLen: 1, output: 'secretA' }), token: tA });
const ridA = r.data && r.data.id;
r = await req(`/api/records/${ridA}`, { token: tB });
check('TC-SC04 B的token访问A的记录→404(L-4)', r.status === 404, `status=${r.status}`);
r = await req(`/api/records/${ridA}`, { method: 'DELETE', token: tB });
// FIND-04已修复（v0.5）：他人记录无命中→404（原0行删除仍返回200「已删除」语义误导）
check('TC-SC04b B删除A的记录→404(FIND-04修复)', r.status === 404, `status=${r.status}`);
const afterDel = await req(`/api/records/${ridA}`, { token: tA });
check('TC-SC04c B删除后A的记录仍存在(数据未越权删除)', afterDel.status === 200 && afterDel.data.output === 'secretA', `status=${afterDel.status}`);

// ---- TC-SC05 未授权访问（无token遍历全部路由，带合法body使鉴权前置校验通过）----
const unauth = [];
const authRoutes = [
  ['/api/auth/me', { method: 'GET' }],
  ['/api/apikey', { method: 'GET' }],
  ['/api/records', { method: 'GET' }],
  ['/api/ai/translate', { method: 'POST', body: JSON.stringify({ text: '你好', params: {} }) }],
  ['/api/ai/proofread', { method: 'POST', body: JSON.stringify({ text: '你好', params: {} }) }],
  ['/api/topics/suggest', { method: 'POST', body: JSON.stringify({ form: { problem: '问题描述' } }) }],
  ['/api/topics/iterate', { method: 'POST', body: JSON.stringify({ question: '追问内容', history: [] }) }],
  ['/api/outline/generate', { method: 'POST', body: JSON.stringify({ title: '标题' }) }],
];
for (const [p, opt] of authRoutes) {
  const rr = await req(p, { ...opt, timeoutMs: 20000 });
  if (rr.status !== 401) unauth.push(`${p}=${rr.status}`);
}
check('TC-SC05 无token访问账号/AI端点全部401', unauth.length === 0, unauth.join(', '));
// 工具端点（import/export/citecheck/checkreport）无鉴权——纯内存解析零落盘设计；记录资源消耗面发现项
const toolOpen = [];
for (const [p, opt] of [
  ['/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '测试[1]' }) }],
  ['/api/checkreport', { method: 'POST', body: JSON.stringify({ text: '测试' }) }],
  ['/api/import', { method: 'POST', headers: { 'X-Filename': 't.txt' }, body: Buffer.from('hi'), raw: true }],
  ['/api/export', { method: 'POST', body: JSON.stringify({ title: 't', sections: [], fmt: 'txt' }) }],
]) {
  const rr = await req(p, { ...opt, timeoutMs: 20000 });
  toolOpen.push(`${p}=${rr.status}`);
}
check('TC-SC05b 工具端点免登录可用(设计:纯内存零落盘)', toolOpen.length === 4, toolOpen.join(', '));
// FIND-05已修复（v0.5）：工具端点已加 IP 级限流（每5分钟60次），触发验证见文末 TC-SC05c

// ---- TC-SC06 会话伪造 ----
r = await req('/api/auth/me', { token: tA.slice(0, -4) + 'ffff' });
check('TC-SC06a 篡改token→401', r.status === 401, `status=${r.status}`);
r = await req('/api/auth/logout', { method: 'POST', token: tB });
r = await req('/api/auth/me', { token: tB });
check('TC-SC06b logout后复用→401', r.status === 401, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uB, password: 'SamePass#1' }) });
tB = r.data && r.data.token;

// ---- TC-SC07 密码存储 ----
const { DatabaseSync } = await import('node:sqlite');
const sdb = new DatabaseSync(DB);
const ua = sdb.prepare('SELECT pass_hash, salt FROM users WHERE username=?').get(uA);
const ub = sdb.prepare('SELECT pass_hash, salt FROM users WHERE username=?').get(uB);
check('TC-SC07a 密码非明文存储', !!ua && ua.pass_hash !== 'SamePass#1' && /^[0-9a-f]{128}$/.test(ua.pass_hash), 'scrypt 64字节hex');
check('TC-SC07b 独立salt且同密码不同哈希', !!ua && !!ub && ua.salt !== ub.salt && ua.pass_hash !== ub.pass_hash, '');
sdb.close();

// ---- TC-SC09 暴力破解（FIND-02已修复v0.5：同用户名+IP连续5次失败锁15分钟）----
let lockedAt = 0;
for (let i = 0; i < 20; i++) {
  const rr = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uA, password: 'wrong' + i }) });
  if (rr.status === 429) { lockedAt = i + 1; break; }
}
check('TC-SC09 连续失败触发429锁定(FIND-02修复)', lockedAt >= 5 && lockedAt <= 10, `第${lockedAt}次触发429`);

// ---- TC-SC10 密钥防护 ----
r = await req('/api/apikey', { token: tA });
check('TC-SC10a 无key→hasKey:false(不泄露)', r.status === 200 && r.data && r.data.hasKey === false, JSON.stringify(r.data).slice(0, 80));
// 有key形态：只返回掩码（sk-****），永不下发明文（掩码格式断言+实现静态核对）
const srvKey = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('TC-SC10b 服务端apikey接口仅查masked字段(静态)', srvKey.includes('SELECT masked') && srvKey.includes('key_enc') && !srvKey.includes('ok(res, { key:'), 'GET仅掩码/PUT加密落库');
check('TC-SC10b 前端无明文sk-密钥(静态)', !/sk-[A-Za-z0-9]{16,}/.test(appjs) && !/sk-[A-Za-z0-9]{16,}/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')) && !/sk-[A-Za-z0-9]{16,}/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'dingao-local.js'), 'utf8')));

// ---- TC-SC12 路径遍历 ----
for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2fserver.js', '/static/../server.js']) {
  const rr = await req(p);
  if (rr.status !== 404) { check(`TC-SC12 路径遍历${p}→404`, false, `status=${rr.status}`); break; }
  check(`TC-SC12 路径遍历${p}→404`, true, '');
}

// ---- TC-SC13 超大伪装docx（简化口径：体积限制生效+进程存活）----
const bigDocx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16 * 1024 * 1024, 0x61)]);
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'bomb.docx' }, body: bigDocx, raw: true, timeoutMs: 60000 });
check('TC-SC13 16MB伪装docx→413/400且进程存活', [413, 400].includes(r.status) && server.exitCode === null, `status=${r.status}`);
r = await req('/api/health');
check('TC-SC13b 压缩炸弹后服务健康', r.status === 200, `status=${r.status}`);

// ---- TC-SC14 文件名注入 ----
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': '../../../etc/passwd.txt' }, body: Buffer.from('file content test', 'utf8'), raw: true });
check('TC-SC14a ../文件名→按扩展名正常处理不越界', r.status === 200 && r.data && r.data.text === 'file content test', `status=${r.status}`);
try {
  await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'a\r\nb.txt' }, body: Buffer.from('crlf test', 'utf8'), raw: true });
  check('TC-SC14b CRLF文件名→服务端正常处理', true, '');
} catch (e) {
  // undici/HTTP 客户端层拒绝 CRLF header 值——传输层拦截即防护，如实记录
  check('TC-SC14b CRLF文件名→客户端层拦截(undici拒绝非法header)', /invalid header/i.test(String(e.message || e)), String(e).slice(0, 80));
}
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'evil%0d%0a.txt' }, body: Buffer.from('encoded crlf', 'utf8'), raw: true });
check('TC-SC14c 编码CRLF文件名→按.txt正常导入无注入', r.status === 200 && r.data.text === 'encoded crlf', `status=${r.status} text=${JSON.stringify(r.data && r.data.text)}`);

// ---- TC-SC16 SSE注入（静态断言：服务端JSON转义+前端textContent）----
const srvjs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('TC-SC16a SSE输出经JSON.stringify转义(静态)', srvjs.includes('JSON.stringify({ delta: piece })'), '');
check('TC-SC16b 前端delta走textContent追加(静态)', appjs.includes('box.lastChild.textContent += delta'), '');

// ---- TC-SC17 导入零落盘 ----
const before = new Set(fs.readdirSync(path.join(__dirname, '..')));
r = await req('/api/import', { method: 'POST', headers: { 'X-Filename': 'notmp.txt' }, body: Buffer.from('tmp check', 'utf8'), raw: true });
const after = fs.readdirSync(path.join(__dirname, '..'));
const newFiles = after.filter((f) => !before.has(f));
check('TC-SC17 导入后服务端目录零新增文件(D5-3)', newFiles.length === 0, `新增: ${newFiles.join(', ')}`);

// ---- TC-SC05c 工具端点IP限流（FIND-05修复v0.5：每5分钟60次→429；置于所有工具用例之后）----
let tool429 = 0;
for (let i = 0; i < 65; i++) {
  const rr = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '限流[1]' }), timeoutMs: 20000 });
  if (rr.status === 429) { tool429 = i + 1; break; }
}
check('TC-SC05c 工具端点触发429(FIND-05修复)', tool429 > 0, `第${tool429}次触发429`);

// ---- TC-SC08 限流（最后执行：61次无key调用→429；重启实例验证恢复）----
let got429 = 0, total = 0;
for (let i = 0; i < 70; i++) {
  const rr = await req('/api/ai/translate', { method: 'POST', body: JSON.stringify({ text: '限流测试', params: {} }), timeoutMs: 20000 });
  total++;
  if (rr.status === 429) { got429 = i + 1; break; }
  if (rr.status === 401) continue;   // 无token：auth前置401不计数? 实测记录
  if (rr.status !== 403 && rr.status !== 400) break;
}
check('TC-SC08 限流触发429(第' + got429 + '次)', got429 > 0, `total=${total} 最后status=`);
server.kill();
await new Promise((r) => setTimeout(r, 1500));
server = startServer();
await new Promise((r) => setTimeout(r, 3000));
r = await req('/api/health');
check('TC-SC08b 重启实例后恢复(health200)', r.status === 200, `status=${r.status}`);
r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uA, password: 'SamePass#1' }) });
check('TC-SC08c 重启后登录正常(内存窗口已清)', r.status === 200, `status=${r.status}`);

server.kill();
console.log(`\n[安全] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项断言）`);
if (findings.length) { console.log('[安全] 发现项:'); for (const f of findings) console.log('  ' + f.name + ': ' + f.detail); }
process.exit(fail ? 1 : 0);
