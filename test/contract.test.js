// 定稿AI 测试工程师 · 前后端路径契约（测试方案 V1.1 §5.2：TC-I01）
// 运行：node test/contract.test.js
// 方法：静态比对 app.js 调用的全部 /api/* 与服务端路由表——无 404 孤儿调用；前端不引用论文存储端点
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const srvjs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
}

// 前端调用点（'/api/...' 字面量）
const calls = [...new Set([...appjs.matchAll(/['"`](\/api\/[a-z0-9_\/:-]+)['"`]/g)].map((m) => m[1]))];
// 服务端路由（app.METHOD('path', …) 字面量）
const routes = [...new Set([...srvjs.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map((m) => m[2]))];
const routeBase = routes.map((r) => r.replace(/\/:[^/]+/g, '/:p'));   // 动态段规范化

// 孤儿调用：前端调用路径与服务端路由逐段匹配（:p 段匹配任意值）
const segMatch = (call, route) => {
  const c = call.split('?')[0].split('/').filter(Boolean);
  const r = route.split('/').filter(Boolean);
  if (c.length !== r.length) return false;
  return r.every((s, i) => s.startsWith(':') || s === c[i]);
};
const orphans = calls.filter((c) => !routes.some((r) => segMatch(c, r)));
check('TC-I01a 前端无孤儿API调用(全部路由存在)', orphans.length === 0, `孤儿: ${orphans.join(', ')}`);

// 前端不得引用论文存储端点（L-3 红线，扩 TC-94）——精确区分 /api/outline（存储，已删）与 /api/outline/generate（纯中转，合法）
const forbidden = ['/api/thesis', '/api/chapters', '/api/outline', '/api/progress', '/api/checkins', '/api/topic_sessions'];
const used = forbidden.filter((f) => {
  const re = new RegExp(`['"\`]${f}(?![a-z0-9_/:-])`);
  return re.test(appjs);
});
check('TC-I01b 前端不引用论文存储端点(L-3)', used.length === 0, `命中: ${used.join(', ')}`);

// 前端调用清单与路由表对照输出（留档用）
console.log('\n[契约] 前端调用 ' + calls.length + ' 条 → 服务端路由 ' + routes.length + ' 条');
console.log('[契约] 前端调用:', calls.join(' '));

console.log(`\n[契约] 结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
