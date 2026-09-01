// 诊断 TC-09 / TC-27
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, 'debug.db');
try { fs.rmSync(DB, { force: true }); } catch {}
const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '8789', DINGAO_TEST: '1', DB_PATH: DB }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const citeText = '正文引用了方法[1]与案例[2,3]。\n\n[1] 张三. 测试文献一[J]. 测试学报, 2024.\n[2] 李四. 测试文献二[J]. 测试学报, 2024.';
let r = await fetch('http://127.0.0.1:8789/api/citecheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: citeText }) });
console.log('citecheck:', r.status, JSON.stringify(await r.json()));
const docxBuf = fs.readFileSync(path.join(__dirname, 'fixture.docx'));
r = await fetch('http://127.0.0.1:8789/api/import', { method: 'POST', headers: { 'X-Filename': 'fixture.docx' }, body: docxBuf });
const d = await r.json().catch(() => ({}));
console.log('docx导入:', r.status, 'error=', d.error || '', 'chars=', d.chars, 'text=', JSON.stringify((d.text || '').slice(0, 60)));
server.kill();
process.exit(0);
