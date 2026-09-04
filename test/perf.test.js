// 定稿AI 测试工程师 · 性能测试（测试方案 V1.1 §5.6 自动化部分：TC-P01~P06、P13）
// 运行：node test/perf.test.js  （自动拉起独立性能实例 8790 / perf.db，不碰生产库与测试库）
// 基线约定：绝对阈值以基线机（本机）空载为准；P13 按 DoD G-2 硬口径 ≤60s
// TC-P07（长文校对）由全量回归 TC-46 覆盖；TC-P08（AI端点基线）由回归 TC-70~75 覆盖，本节不重复压测 AI
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8790';
const DB = path.join(__dirname, 'perf.db');
try { fs.rmSync(DB, { force: true }); } catch {}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: '8790', DINGAO_TEST: '1', DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 3000));
if (server.exitCode !== null) { console.error('性能实例未能启动'); process.exit(2); }

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
}
const p95 = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
async function timeIt(fn) { const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, r }; }
const baseReq = (path_, opt = {}) => {
  const headers = { ...(opt.headers || {}) };
  if (opt.token) headers.Authorization = `Bearer ${opt.token}`;
  if (opt.body && typeof opt.body === 'string' && !opt.raw) headers['Content-Type'] = 'application/json';
  return fetch(BASE + path_, { ...opt, headers, signal: AbortSignal.timeout(30000) });
};

console.log('[性能] 基线机：' + (process.platform) + ' Node ' + process.version + '，负载以当前空载为准');

// ---- TC-P01 健康接口延迟 ×100 ----
let lat = [];
for (let i = 0; i < 100; i++) lat.push((await timeIt(() => baseReq('/api/health'))).ms);
check('TC-P01 health P95<50ms', p95(lat) < 50, `P95=${p95(lat).toFixed(1)}ms max=${Math.max(...lat).toFixed(1)}`);

// ---- TC-P02 登录延迟 ×50（独立账号）----
lat = [];
for (let i = 0; i < 50; i++) {
  const u = 'p' + Date.now().toString(36).slice(-5) + i;
  const { ms } = await timeIt(async () => {
    await baseReq('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u, password: 'Perf#12345', agree: true }) });
    return baseReq('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: 'Perf#12345', agree: true }) });
  });
  lat.push(ms);
}
check('TC-P02 注册+登录 P95<200ms', p95(lat) < 200, `P95=${p95(lat).toFixed(1)}ms`);

// ---- TC-P03 规则引擎吞吐 citecheck 10000字×50 + 内存无持续增长 ----
const text10k = '文'.repeat(10000);
const memBefore = process.memoryUsage().heapUsed;
lat = [];
for (let i = 0; i < 50; i++) {
  const { ms, r } = await timeIt(() => baseReq('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: text10k }) }));
  if ((await r).status !== 200) { check('TC-P03a 50次全部200', false, `第${i}次status=${(await r).status}`); break; }
  lat.push(ms);
}
global.gc && global.gc();
const memAfter = process.memoryUsage().heapUsed;
check('TC-P03a 单次<500ms', lat.length === 50 && Math.max(...lat) < 500, `max=${Math.max(...lat).toFixed(1)}ms`);
check('TC-P03b 内存无持续增长(<50MB)', (memAfter - memBefore) / 1048576 < 50, `Δ=${((memAfter - memBefore) / 1048576).toFixed(1)}MB`);

// ---- TC-P04 交稿检查 fixture.docx <3s ----
const docxBuf = fs.readFileSync(path.join(__dirname, 'fixture.docx'));
let t4 = await timeIt(async () => {
  const imp = await baseReq('/api/import', { method: 'POST', headers: { 'X-Filename': 'fixture.docx' }, body: docxBuf, raw: true });
  const j = await imp.json();
  return baseReq('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: j.text, meta: j.meta }) });
});
check('TC-P04 交稿检查<3s', t4.ms < 3000, `${t4.ms.toFixed(0)}ms`);

// ---- TC-P05 导入性能（先校准）10万字txt ----
const txt100k = Buffer.from('测'.repeat(100000), 'utf8');
const t5 = await timeIt(() => baseReq('/api/import', { method: 'POST', headers: { 'X-Filename': 'perf100k.txt' }, body: txt100k, raw: true }));
check('TC-P05 10万字txt导入<5s(校准值' + t5.ms.toFixed(0) + 'ms)', t5.ms < 5000, `${t5.ms.toFixed(0)}ms`);

// ---- TC-P06 并发压力 20并发×10请求混合 ----
const u6 = 'conc_' + Date.now().toString(36).slice(-5);
await baseReq('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u6, password: 'Conc#12345', agree: true }) });
const l6 = await (await baseReq('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u6, password: 'Conc#12345', agree: true }) })).json();
const tk = l6.token;
const mkReq = (i) => {
  if (i % 3 === 0) return baseReq('/api/health');
  if (i % 3 === 1) return baseReq('/api/citecheck', { method: 'POST', body: JSON.stringify({ text: '并发测试[1]。\n[1] 作者. 标题[J]. 期刊, 2020.' }) });
  return baseReq('/api/records', { token: tk });
};
const t0 = performance.now();
const codes = [];
const batch = (n) => Promise.all(Array.from({ length: n }, (_, i) => mkReq(i).then(async (r) => codes.push(r.status)).catch(() => codes.push(0))));
for (let round = 0; round < 10; round++) await batch(20);
const dur = performance.now() - t0;
const no500 = codes.filter((c) => c === 500).length === 0;
const p95t = dur / 200;
check('TC-P06 200并发请求无500且无崩溃', no500 && server.exitCode === null, `500数=${codes.filter((c) => c === 500).length} 崩溃=${server.exitCode !== null}`);
check('TC-P06b 全程P95<1s(总耗时/请求数口径)', p95t < 1000, `总${dur.toFixed(0)}ms/200请求 平均${(dur / 200).toFixed(0)}ms`);

// ---- TC-P13 10万字交稿检查（DoD G-2 硬口径 ≤60s，先校准）----
const t13 = await timeIt(() => baseReq('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: '论'.repeat(100000) }) }));
check('TC-P13 10万字checkreport≤60s(校准值' + (t13.ms / 1000).toFixed(1) + 's)', t13.ms <= 60000, `${(t13.ms / 1000).toFixed(1)}s`);

server.kill();
console.log(`\n[性能] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项断言）`);
process.exit(fail ? 1 : 0);
