// 定稿AI 测试工程师 · 黄金测试集（D5-1，v0.5：TC-G 系列）
// 运行：node test/golden.test.js（自动拉起 8792 实例 golden.db，PLATFORM_KEY_PUBLIC=true；真实 DeepSeek，约 10-15 分钟，费用约 ¥0.5-1.5）
// 覆盖：引用预埋 4 篇（确定性）/ 格式预埋 4 篇 docx（确定性）/ 校对预埋 2 篇（真实AI）/ T-6 选题 10 组回归（真实AI）/ D4-2 互译 100 句（真实AI，输出留档供人工抽检）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(__dirname, 'golden');
const BASE = 'http://127.0.0.1:8792';
const DB = path.join(__dirname, 'golden.db');
try { fs.rmSync(DB, { force: true }); } catch {}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: '8792', DINGAO_TEST: '1', DB_PATH: DB, PLATFORM_KEY_PUBLIC: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', () => {});
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
  const r = await fetch(BASE + path_, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs || 200000) });
  let data = null; const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json().catch(() => null);
  else if (ct.includes('text')) data = await r.text();
  else data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
async function sseCollect(path_, body, token, timeout = 600000) {
  const r = await fetch(BASE + path_, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) return { status: r.status, events: [] };
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const ln of buf.split('\n')) {
      const s = ln.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
    buf = '';
  }
  return { status: 200, events };
}

// 账号：admin（T-6/校对）+ 两个互译账号（限流分摊）
const uname = 'gld_' + Date.now().toString(36).slice(-5);
const pw = 'Golden#2026';
const tokens = [];
for (let i = 0; i < 3; i++) {
  const u = `${uname}_${i}`;
  await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u, password: pw, agree: true }) });
  const lr = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: pw }) });
  tokens.push(lr.data && lr.data.token);
}
check('TC-G00 三账号准备(平台Key开放)', tokens.every(Boolean), '');

// ============ A. 引用预埋 4 篇（确定性） ============
for (const id of ['p01', 'p02', 'p03', 'p04']) {
  const text = fs.readFileSync(path.join(GOLDEN, 'papers/cite', id + '.txt'), 'utf8');
  const ans = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'answers', id + '.json'), 'utf8'));
  const r = await req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text }) });
  const issues = (r.data && r.data.issues || []).join('\n');
  const hit = ans.expect.every((k) => issues.includes(k));
  check(`TC-G01 ${id} 预埋缺陷检出(${ans.defs.join('/')})`, r.status === 200 && hit, issues.slice(0, 120));
}

// ============ B. 格式预埋 4 篇 docx（确定性） ============
const fmtExpect = { f01: ['字体种类', 'warn'], f02: ['字号', 'warn'], f03: ['行距', 'warn'], f04: ['标题层级', 'warn'] };
for (const [id, [item, want]] of Object.entries(fmtExpect)) {
  const buf = fs.readFileSync(path.join(GOLDEN, 'papers/format', id + '.docx'));
  const imp = await req('/api/import', { method: 'POST', headers: { 'X-Filename': id + '.docx' }, body: buf, raw: true });
  const rp = await req('/api/checkreport', { method: 'POST', body: JSON.stringify({ text: imp.data.text, meta: imp.data.meta }) });
  const row = (rp.data && rp.data.format || []).find((x) => x.item === item);
  check(`TC-G02 ${id} 预埋格式违规→${item} ${want}`, !!row && row.status === want, JSON.stringify(row));
}

// ============ C. 校对预埋 2 篇（真实 AI） ============
for (const id of ['p05', 'p06']) {
  const ans = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'answers', id + '.json'), 'utf8'));
  const res = await sseCollect('/api/ai/proofread', { text: ans.body, params: { model: 'deepseek-v4-flash', maxChunk: 2500 } }, tokens[0]);
  const content = res.events.filter((e) => e.event === 'chunk_done').map((e) => e.content).join('\n');
  // 口径：AI 输出有随机性——必检签名必须命中，其余签名检出率 ≥60%（检出率如实记录）
  const sigs = ans.signatures || [];
  const sigHits = sigs.filter((s) => content.includes(s)).length;
  const mustOk = (ans.mustHit || []).every((s) => content.includes(s));
  console.log(`TC-G03 ${id} 签名检出 ${sigHits}/${sigs.length} 必检=${mustOk ? 'OK' : 'MISS'}`);
  check(`TC-G03 ${id} 预埋检出 ${sigHits}/${sigs.length}`, mustOk && sigHits >= Math.ceil(sigs.length * 0.6), content.slice(0, 200));
}

// ============ D. T-6 选题 10 组固定输入回归（真实 AI） ============
const topicSixOk = (t) => !!t.title && !!t.research_question && Array.isArray(t.innovation_points) && !!t.relation_to_literature && !!t.feasibility && Array.isArray(t.reasons);
const topicFiles = fs.readdirSync(path.join(GOLDEN, 'topics')).sort();
let totalTopics = 0, completeTopics = 0;
for (const f of topicFiles) {
  const form = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'topics', f), 'utf8'));
  const r = await req('/api/topics/suggest', { method: 'POST', body: JSON.stringify({ form }), token: tokens[0], timeoutMs: 240000 });
  const ts = (r.data && r.data.topics) || [];
  totalTopics += ts.length;
  completeTopics += ts.filter(topicSixOk).length;
  console.log(`T-6 ${f}: ${ts.length} 选题 / 齐全 ${ts.filter(topicSixOk).length}（status=${r.status}）`);
}
const rate = totalTopics ? Math.round((completeTopics / totalTopics) * 1000) / 10 : 0;
check(`TC-G04 T-6 选题齐全率 ${rate}% ≥95%`, rate >= 95, `${completeTopics}/${totalTopics}`);

// ============ E. D4-2 互译 100 句（真实 AI，输出留档） ============
const sFiles = fs.readdirSync(path.join(GOLDEN, 'sentences')).sort();
const allPairs = [];
for (const f of sFiles) {
  const lines = fs.readFileSync(path.join(GOLDEN, 'sentences', f), 'utf8').split('\n').filter(Boolean);
  lines.forEach((src, i) => allPairs.push({ id: `${f.replace('.txt', '')}-${i + 1}`, src }));
}
const outLines = [];
let blank = 0, tErr = 0;
for (let i = 0; i < allPairs.length; i++) {
  const p = allPairs[i];
  const token = tokens[1 + (i % 2)];
  const res = await sseCollect('/api/ai/translate', { text: p.src, params: { model: 'deepseek-v4-flash' } }, token, 300000);
  const deltas = res.events.filter((e) => e.delta).map((e) => e.delta).join('');
  const err = res.events.find((e) => e.event === 'error');
  if (err) tErr++;
  const tgt = deltas.replace(/——\s*\[AI生成\][\s\S]*$/, '').trim();
  if (!tgt) blank++;
  outLines.push(`[${p.id}] ${p.src}\n    → ${tgt}`);
  if (i % 20 === 19) console.log(`D4-2 进度 ${i + 1}/${allPairs.length}`);
}
const ts2 = Date.now().toString(36);
fs.writeFileSync(path.join(__dirname, '..', 'logs', `golden_translations_${ts2}.txt`), outLines.join('\n\n'));
check(`TC-G05 D4-2 互译 100 句完成(错误${tErr}/空输出${blank})`, tErr === 0 && blank === 0, `err=${tErr} blank=${blank} 留档=logs/golden_translations_${ts2}.txt`);

server.kill();
console.log(`\n[黄金集] 结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项断言）`);
if (findings.length) { console.log('[黄金集] 发现项:'); for (const f of findings) console.log('  ' + f.name + ': ' + f.detail); }
process.exit(fail ? 1 : 0);
