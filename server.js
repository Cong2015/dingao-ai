// 定稿AI 开发版 v0.4 — 后端服务（本地优先架构）
// 范围（对应 R8 DoD V1.3 Must 清单；V1.4 架构修订）：
//   PBI-21 M9 选题助手 / PBI-22 M10 大纲生成（纯中转：AI JSON，服务端不存会话与内容）
//   PBI-23 M11 本地编写 / PBI-24 M12 进度打卡（V1.4起全部在用户浏览器 IndexedDB 本地实现，服务端无存储）
//   PBI-04 M4 互译 / PBI-20 M8 交稿检查报告 / PBI-05 工程地基（沿用 v0.2/v0.3 实现）
//   M2/M5/M6/M7 降级保留（S7/S8/C7/C8，功能仍可用）
// 红线（V1.4修订）：论文全文仅存用户自己电脑的浏览器本地（IndexedDB），服务端数据库不含任何论文数据；
//   服务端仅存：账号/会话/用户API密钥/用户主动保存的工具结果记录。
//   内容0修改 · 密钥仅存服务端 · AI输出标注需人工核验
// 修复（v0.1诊断，v0.2实测校准）：校对按块执行避免整篇超时；检测finish_reason=length与空输出并自动细分重试；
// max_tokens默认不设（V4推理模型思考与答案共用预算，显式小值会饿死答案：2500字块0.8s/完整输出 vs 4096上限0.4s/空输出）
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import * as pdfNS from 'pdf-parse';
const pdf = pdfNS.default || pdfNS;
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dingao.db');
const IS_TEST = !!process.env.DINGAO_TEST;

// ---------- DeepSeek 密钥（仅服务端；环境变量 > API.txt > config/key.txt） ----------
function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  for (const p of ['config/key.txt', path.join(__dirname, 'config/key.txt')]) {
    try { const k = fs.readFileSync(p, 'utf8').trim(); if (k) return k; } catch {}
  }
  return '';
}
const API_KEY = loadApiKey();
const DS_URL = 'https://api.deepseek.com/chat/completions';
const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

// ---------- 密钥体系：平台Key（管理员/付费）+ 用户自带Key（BYOK，加密存储） ----------
const PLATFORM_KEY_PUBLIC = (process.env.PLATFORM_KEY_PUBLIC || 'false') === 'true';
const ADMIN_LIST = (process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim()).filter(Boolean);
function loadEncSecret() {
  if (process.env.DINGAO_ENC_SECRET) return process.env.DINGAO_ENC_SECRET;
  const p = path.join(__dirname, 'config', 'secret.key');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
  return s;
}
const ENC_SECRET = loadEncSecret();
const encKey = crypto.createHash('sha256').update(ENC_SECRET).digest();
function enc(s) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encKey, iv); const e = Buffer.concat([c.update(s, 'utf8'), c.final()]); return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + e.toString('hex'); }
function dec(v) { try { const [iv, tag, e] = v.split(':'); const d = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'hex'), { authTagLength: 16 }); d.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([d.update(Buffer.from(e, 'hex')), d.final()]).toString('utf8'); } catch { return ''; } }
const maskKey = (k) => k.slice(0, 5) + '****' + k.slice(-4);
async function verifyDeepSeekKey(key) {
  if (!/^sk-[A-Za-z0-9]{10,}$/.test(key)) return { ok: false, reason: '格式不正确：应为 sk- 开头的DeepSeek密钥' };
  try {
    const r = await fetch(DS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: MODELS[0], messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, reason: `DeepSeek拒绝该密钥（HTTP ${r.status}），请检查key是否有效` };
    return { ok: true };
  } catch { return { ok: false, reason: '无法连通DeepSeek（网络问题），请稍后重试' }; }
}
function resolveKeyFor(userId) {
  const row = db.prepare('SELECT key_enc, verified FROM api_keys WHERE user_id=?').get(userId);
  if (row && row.verified) { const k = dec(row.key_enc); if (k) return { key: k, source: 'user' }; }
  const u = db.prepare('SELECT username, is_admin FROM users WHERE id=?').get(userId);
  const isAdmin = !!u && (u.is_admin === 1 || ADMIN_LIST.includes(u.username));
  if ((isAdmin || PLATFORM_KEY_PUBLIC) && API_KEY) return { key: API_KEY, source: 'platform' };
  return null;
}

// ---------- 数据库 ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS api_keys(
  user_id INTEGER PRIMARY KEY, key_enc TEXT NOT NULL, masked TEXT NOT NULL,
  verified INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL, input_len INTEGER NOT NULL, output TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')));
`);
// v0.4 本地优先架构：论文全文/大纲/进度/打卡全部存用户浏览器 IndexedDB（见 public/dingao-local.js），
// 服务端数据库只保留：用户账号、会话、用户API密钥、用户主动保存的工具结果记录（records）。
// 原 v0.3 的 theses/chapters/checkins/topic_sessions/topic_messages 五表已随架构调整移除。
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
if (!userCols.includes('is_admin')) db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`);

// ---------- 工具 ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const now = () => Date.now();
function uid(token) { const r = db.prepare('SELECT user_id, expires FROM sessions WHERE token=?').get(token); if (!r || r.expires < now()) return null; return r.user_id; }
function requireAuth(req, res) { const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const id = t && uid(t); if (!id) { res.status(401).json({ error: '未登录或登录已过期' }); return null; } return id; }
const ok = (res, data) => res.json(data);
const sse = (res) => { res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); };
const sendEvent = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

// ---------- 简单限流（每用户 60 次 AI 请求/小时；分段校对单次任务按1次计） ----------
const rl = new Map();
function rateLimit(req, res, next) {
  const id = uid((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const key = id || req.ip;
  const win = rl.get(key) || { n: 0, t: now() };
  if (now() - win.t > 3600e3) { win.n = 0; win.t = now(); }
  win.n++;
  rl.set(key, win);
  if (win.n > 60) return res.status(429).json({ error: '请求过于频繁，请稍后再试（每小时60次）' });
  next();
}

// ---------- AI JSON 解析（选题/大纲中转用；论文数据不落服务端） ----------
const topicSixOk = (t) => !!t.title && !!t.research_question && Array.isArray(t.innovation_points) && !!t.relation_to_literature && !!t.feasibility && Array.isArray(t.reasons);
function parseAiJson(content) {
  let s = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return { ok: true, data: JSON.parse(s) }; } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return { ok: true, data: JSON.parse(s.slice(a, b + 1)) }; } catch {} }
  return { ok: false };
}

// ---------- 提示词（内容0修改红线内置于系统提示） ----------
const PROMPTS = {
  translate: {
    system: '你是定稿AI的学术翻译引擎。要求：①译文使用规范学术语体；②专业术语准确，人名/机构名/期刊名保留原文；③只输出译文本身，不加任何解释；④本译文由AI生成，使用者需人工核验。',
    build: (text, p) => `翻译方向：${p.lang === 'en2zh' ? '英文→中文' : '中文→英文'}。内容如下：\n\n${text}`,
  },
  analyze: {
    system: '你是定稿AI的文献分析引擎。基于用户提供的文献内容，输出固定四节（每节2-5句话）：\n## 研究方法\n## 核心结论\n## 局限与不足\n## 可切入的研究方向\n约束：只基于给定内容推断，不虚构数据；本分析由AI生成，需人工核验。',
    build: (text) => `文献内容如下：\n\n${text}`,
  },
  proofread: {
    system: '你是定稿AI的校对引擎，只处理机械错误：错别字、全/半角标点混用、多余空格、重复标点。约束：①不改动任何内容表述与措辞（内容0修改红线）；②输出格式：逐条「位置原文 → 建议修正」，末尾统计（共N处）；③若无机械错误则输出「未发现机械错误」；④不润色、不改写。',
    build: (text) => `待校对文本如下：\n\n${text}`,
  },
  review: {
    system: '你是定稿AI的综述辅助引擎。基于用户提供的多篇文献内容生成「参考版文献综述」：①按主题整合而非逐篇罗列；②引用用[1][2]标注对应文献编号；③结尾附固定声明「本综述由AI生成，为参考版——引用与论断均需人工核验后方可使用」；④不虚构文献与数据。',
    build: (text) => `多篇文献内容如下（按编号[1][2]…排列）：\n\n${text}`,
  },
  // M9 选题（参考研墨系统实测形态：六要素JSON）
  topic: {
    system: '你是定稿AI的选题助手，扮演一位深耕工程领域15年的研究生导师，擅长从实际工程问题中提炼有研究价值的硕士/博士论文选题。你的原则：①问题真实性——选题必须源于用户描述的实际问题；②方法可行性——数据可得、方法成熟；③创新可论证性——能在已有研究基础上说清差异；④与学位周期匹配；⑤只基于用户提供的信息推断，绝不虚构文献。输出格式约束（必须严格遵守）：只输出一个JSON对象；每个选题对象必须完整包含全部6个字段——title（题目，≤50字）、research_question（核心研究问题，1-2句）、innovation_points（创新点数组，≥2条）、relation_to_literature（与已读文献的继承与差异，100字内）、feasibility（对象，必须含 data_availability、method_maturity、time_estimate 三个键）、reasons（推荐理由数组，≥2条）；不得省略任何一个字段，输出前请逐选题自查字段完整性。',
    build: (text, p) => {
      const f = p.form || {};
      const lits = (Array.isArray(f.literatures) ? f.literatures : []).filter(Boolean).map((x, i) => `[文献${i + 1}]\n${x}`).join('\n\n');
      return `实际工程问题：\n${f.problem || text}\n\n已读文献：\n${lits || '（未提供）'}\n\n所属工程领域：${f.discipline || '未提供'}\n个人研究兴趣：${f.interests || '未提供'}\n\n请为上述信息提出 ${Math.min(Math.max(Number(f.count) || 5, 3), 5)} 个论文选题建议，输出JSON：\n{"topics":[{"index":1,"title":"论文题目(不超过50字)","research_question":"核心研究问题(1-2句)","innovation_points":["创新点1","创新点2"],"relation_to_literature":"与已读文献的继承与差异(100字内)","feasibility":{"data_availability":"数据可得性说明","method_maturity":"方法成熟度说明","time_estimate":"与学位周期的匹配说明"},"reasons":["推荐理由1","推荐理由2"]}]}`;
    },
    systemIter: '你是定稿AI的选题助手。用户正在追问，请基于以上会话上下文理解追问意图，重新输出改进后的选题建议。约束同上：只输出一个JSON对象，不要输出任何其他文字。',
  },
  // M10 大纲（章-节两级JSON）
  outline: {
    system: '你是定稿AI的大纲助手。基于用户提供的选题与研究信息，生成硕士学位论文的标准章节大纲（章-节两级以上）。要求：①结构完整（一般含绪论/文献综述与理论基础/研究方法/实证或案例研究/结论与展望）；②章节标题简洁规范；③紧扣选题。你必须只输出一个JSON对象，不要输出任何其他文字或代码块标记。',
    build: (text, p) => `选题或论文标题：${p.title || text}\n${p.extra ? `补充信息（关键词/资料说明）：\n${p.extra}` : ''}\n\n请输出JSON：\n{"chapters":[{"title":"第1章 绪论","sections":["1.1 研究背景","1.2 研究意义"]}]}`,
  },
};

// ---------- M5 智能分段（≤maxLen字/块；不截断句子与[n]引用标记；切块无损拼接还原） ----------
function splitLongPara(s, maxLen) {
  const parts = s.split(/(?<=[。！？；!?;])/);
  const out = []; let cur = '';
  for (let piece of parts) {
    piece = piece.trim(); if (!piece) continue;
    if (piece.length > maxLen) {
      if (cur) { out.push(cur); cur = ''; }
      let rest = piece;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf('，', maxLen);
        if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen);
        if (cut < maxLen * 0.5) cut = Math.max(rest.indexOf(' ', maxLen * 0.6), maxLen);
        if (cut <= 0) cut = maxLen;
        out.push(rest.slice(0, cut + 1));
        rest = rest.slice(cut + 1);
      }
      if (rest) cur = rest;
    } else if ((cur + piece).length > maxLen) { out.push(cur); cur = piece; }
    else cur += piece;
  }
  if (cur) out.push(cur);
  return out;
}
function chunkText(text, maxLen = 2500) {
  const tokens = text.split(/(\n+)/);
  const chunks = []; let cur = '';
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\n+$/.test(tok)) { cur += tok; continue; }                 // 换行符跟随内容
    if (tok.length > maxLen) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (const sub of splitLongPara(tok, maxLen)) chunks.push(sub);
    } else if ((cur + tok).length > maxLen) {
      chunks.push(cur); cur = tok;
    } else cur += tok;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

// ---------- DeepSeek 调用（非流式单次获取；检测截断与空输出） ----------
// v0.2实测：V4是推理模型，思考(reasoning)与答案共用输出预算——显式设小max_tokens会饿死答案（fr=length且content为空）；
// 不设max_tokens时API默认预算充足：2500字块0.8s完成、输出完整。仅在调用方显式传maxTokens时才设置。
// AI 中转自动重试（DeepSeek 瞬时故障时再试一次，提升夜间/高峰期成功率；两次都失败才报错）
async function dsCallRetry(task, text, params, key) {
  const r = await dsCall(task, text, params, key);
  if (r.ok) return r;
  return dsCall(task, text, params, key);
}
async function dsCall(task, text, params, key) {
  const model = MODELS.includes(params.model) ? params.model : MODELS[0];
  const body = {
    model, stream: false, temperature: params.temperature ?? 0.3,
    messages: [
      { role: 'system', content: params.systemOverride || PROMPTS[task].system },
      { role: 'user', content: PROMPTS[task].build(text, params) },
    ],
  };
  const mt = Number(params.maxTokens);
  if (mt > 0) body.max_tokens = Math.min(Math.max(mt, 256), 8192);
  if (params.responseFormat) body.response_format = { type: 'json_object' };
  try {
    const r = await fetch(DS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(params.timeoutMs || 120000),
    });
    if (!r.ok) { const e = await r.text().catch(() => ''); return { ok: false, error: `DeepSeek调用失败(${r.status})：${e.slice(0, 160)}` }; }
    const j = await r.json();
    const msg = j.choices?.[0]?.message || {};
    let content = msg.content || '';
    if (!content) content = msg.reasoning_content || '';
    return { ok: true, content, finishReason: j.choices?.[0]?.finish_reason || 'stop', model };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'DeepSeek调用超时（120秒），请稍后重试' : String(e.message || e).slice(0, 160) };
  }
}

// ---------- M2 引用核查（规则引擎增强版·确定性，不调用LLM） ----------
function normalizeRef(s) { return s.replace(/[\s\u3000.,;:;'"「」《》()（）\-—]/g, ''); }
function citeCheck(text, fmt = 'gbt7714') {
  const lines = text.split(/\r?\n/);
  const refs = []; const refText = {}; const bodyParts = [];
  for (const ln of lines) {
    const m = ln.match(/^\s*\[(\d{1,3})\]/) || ln.match(/^\s*(\d{1,3})\s*[\.、．]/);
    if (m) { refs.push(Number(m[1])); refText[Number(m[1])] = ln.trim(); }
    else bodyParts.push(ln);
  }
  const body = bodyParts.join('\n');
  const intext = []; const seq = [];
  for (const m of body.matchAll(/\[(\d+(?:[,-]\d+)*)\]/g)) {
    for (const part of m[1].split(',')) {
      const n = part.includes('-') ? (([a, b]) => { const arr = []; for (let i = Number(a); i <= Number(b); i++) arr.push(i); return arr; })(part.split('-')) : [Number(part)];
      for (const v of n) { intext.push(v); if (!seq.includes(v)) seq.push(v); }
    }
  }
  const inSet = [...new Set(intext)], refSet = [...new Set(refs)];
  const orphanInText = inSet.filter((n) => !refSet.includes(n));
  const orphanRefs = refSet.filter((n) => !inSet.includes(n));
  const dupInText = intext.length - inSet.length;
  const authorYear = (body.match(/[（(][\u4e00-\u9fa5A-Za-z]+[，,]\s*\d{4}[a-z]?[)）]/g) || []).length;

  // 序号错位：首次出现顺序应为递增（顺序编码制）
  const seqErrors = [];
  let maxSeen = 0;
  for (const n of seq) { if (n < maxSeen) seqErrors.push(n); maxSeen = Math.max(maxSeen, n); }

  // 去重：完全重复（规范化后一致）/ 疑似重复（首作者＋年份相同）
  const dupGroups = []; const suspected = [];
  const byNorm = {};
  for (const n of refSet) {
    const norm = normalizeRef((refText[n] || '').replace(/^\s*\[?\d{1,3}\]?\s*[\.、．]?\s*/, ''));
    if (!byNorm[norm]) byNorm[norm] = [];
    byNorm[norm].push(n);
  }
  for (const [norm, arr] of Object.entries(byNorm)) {
    if (norm && arr.length > 1) dupGroups.push([...arr]);
  }
  if (!dupGroups.length) {
    const byAuthorYear = {};
    for (const n of refSet) {
      const t = refText[n] || '';
      const m = t.match(/([\u4e00-\u9fa5A-Za-z]+)[，,][\s\S]{0,30}?(\d{4})/);
      if (m) { const k = m[1] + '|' + m[2]; if (!byAuthorYear[k]) byAuthorYear[k] = []; byAuthorYear[k].push(n); }
    }
    for (const arr of Object.values(byAuthorYear)) if (arr.length > 1) suspected.push([...arr]);
  }

  // 序号修正建议：按首次出现顺序重新编号（仅涉及在文末列表存在的序号）
  const mapping = {};
  let i = 1;
  for (const n of seq) { if (refSet.includes(n) && !(n in mapping)) { mapping[n] = i++; } }
  const renumberedBody = body.replace(/\[(\d+(?:[,-]\d+)*)\]/g, (m0) => {
    let changed = false;
    const inner = m0.slice(1, -1).split(',').map((part) => {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        const sub = []; for (let x = a; x <= b; x++) sub.push(mapping[x] || x); changed = true;
        return sub.join('-');
      }
      const n = Number(part);
      if (mapping[n]) { changed = true; return String(mapping[n]); }
      return part;
    }).join(',');
    return '[' + inner + ']';
  });
  const renumberedRefs = refSet
    .filter((n) => mapping[n])
    .sort((a, b) => mapping[a] - mapping[b])
    .map((n) => `[${mapping[n]}] ${refText[n].replace(/^\s*\[?\d{1,3}\]?\s*[\.、．]?\s*/, '')}`);
  const renumberApplied = Object.keys(mapping).length > 0 && seqErrors.length > 0;

  const issues = [];
  if (orphanInText.length) issues.push(`文内引用序号 ${orphanInText.join('、')} 在文末参考文献中缺失（漏引/序号错位风险）`);
  if (orphanRefs.length) issues.push(`文末文献 ${orphanRefs.join('、')} 未被正文引用（多余文献）`);
  if (dupInText > 0) issues.push(`文内重复引用 ${dupInText} 处（请核对序号对应）`);
  if (seqErrors.length) issues.push(`序号错位：引用 ${[...new Set(seqErrors)].join('、')} 的首次出现早于更小序号，建议一键重排（见下方修正建议）`);
  if (fmt === 'gbt7714' && authorYear > 0) issues.push(`检测到 ${authorYear} 处著者-出版年体例引用，请确认与顺序编码制不混用`);
  if (dupGroups.length) issues.push(`发现 ${dupGroups.length} 组完全重复文献：${dupGroups.map((g) => g.join('、')).join('；')}`);
  if (suspected.length) issues.push(`疑似重复文献（首作者＋年份相同）：${suspected.map((g) => g.join('、')).join('；')}`);

  return {
    intextCount: intext.length, refCount: refs.length,
    intextIndices: inSet, refIndices: refSet,
    orphanInText, orphanRefs, authorYearCount: authorYear,
    seqErrors: [...new Set(seqErrors)], dupGroups, suspected,
    renumber: renumberApplied ? { mapping, renumberedBody, renumberedRefs } : null,
    issues: issues.length ? issues : [`未发现明显引用问题；体例检查：${fmt === 'gbt7714' ? 'GB/T 7714 顺序编码制' : fmt === 'apa' ? 'APA 7th' : fmt === 'mla' ? 'MLA 9th' : 'GB/T 7714 著者-出版年制'} ✓`],
    fmt,
    rule: '规则引擎（确定性）·未调用LLM',
  };
}

// ---------- M8 docx 基础格式元数据（规则引擎·确定性） ----------
function docxMeta(zip) {
  const docXml = zip.getEntry('word/document.xml')?.getData().toString('utf8') || '';
  const sect = docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  const pgMar = {};
  if (sect) {
    const m = sect[0].match(/<w:pgMar([^>]*)\/>/);
    if (m) for (const k of ['top', 'bottom', 'left', 'right']) { const v = m[1].match(new RegExp(`w:${k}="(\\d+)"`)); if (v) pgMar[k] = Number(v[1]); }
  }
  const fonts = [...new Set([...docXml.matchAll(/<w:rFonts[^>]*w:eastAsia="([^"]+)"/g)].map((x) => x[1]))];
  const sizes = [...new Set([...docXml.matchAll(/<w:sz w:val="(\d+)"/g)].map((x) => Number(x[1])))].sort((a, b) => a - b);
  const lines = [...new Set([...docXml.matchAll(/<w:spacing[^>]*w:line="(\d+)"/g)].map((x) => Number(x[1])))];
  const headings = {};
  for (const x of docXml.matchAll(/<w:pStyle w:val="(Heading\d|标题\s*\d|Title)"/g)) headings[x[1]] = (headings[x[1]] || 0) + 1;
  let hasPageNum = false;
  for (const e of zip.getEntries()) {
    if (/word\/footer\d*\.xml$/.test(e.entryName)) {
      const fx = e.getData().toString('utf8');
      if (fx.includes('PAGE') || fx.includes('页码')) hasPageNum = true;
    }
  }
  return { pgMar, fonts, sizes, lines, headings, hasPageNum };
}
function formatCheck(meta) {
  const rows = [];
  if (!meta) {
    rows.push({ item: '页边距', status: '未检查', note: '请导入 .docx 文件（当前为纯文本）' });
    rows.push({ item: '字体/字号/行距', status: '未检查', note: '请导入 .docx 文件（当前为纯文本）' });
    rows.push({ item: '标题层级', status: '未检查', note: '请导入 .docx 文件（当前为纯文本）' });
    rows.push({ item: '页码', status: '未检查', note: '请导入 .docx 文件（当前为纯文本）' });
    return rows;
  }
  const cm = (t) => t ? (t / 567).toFixed(2) + 'cm' : '—';
  const { pgMar, fonts, sizes, lines, headings, hasPageNum } = meta;
  const mOK = pgMar.top && pgMar.bottom && pgMar.left && pgMar.right;
  rows.push({
    item: '页边距',
    status: mOK ? 'ok' : '未检出',
    note: mOK ? `上 ${cm(pgMar.top)} · 下 ${cm(pgMar.bottom)} · 左 ${cm(pgMar.left)} · 右 ${cm(pgMar.right)}（学校规范常见：上3.0cm 下2.5cm 左3.0cm 右2.5cm，请对照本校要求）` : '未能从文档中检出页边距设置',
  });
  rows.push({
    item: '字体种类',
    status: fonts.length <= 2 ? 'ok' : 'warn',
    note: fonts.length ? `检测到 ${fonts.length} 种中文字体：${fonts.join('、')}${fonts.length > 2 ? '——正文混用≥3种字体，建议统一' : ''}` : '未检出字体（可能为扫描件/图片型PDF转换）',
  });
  rows.push({
    item: '字号',
    status: sizes.length <= 4 ? 'ok' : 'warn',
    note: sizes.length ? `检测到字号（半磅）：${sizes.join('、')}${sizes.length > 4 ? '——字号混用较多，建议核对立项规范' : ''}` : '未检出字号',
  });
  rows.push({
    item: '行距',
    status: lines.length <= 3 ? 'ok' : 'warn',
    note: lines.length ? `检测到 ${lines.length} 种行距设置${lines.length > 3 ? '——行距不统一，建议检查' : ''}` : '未检出行距设置',
  });
  const hCount = Object.values(headings).reduce((a, b) => a + b, 0);
  rows.push({
    item: '标题层级',
    status: hCount > 0 ? 'ok' : 'warn',
    note: hCount > 0 ? `检测到标题样式段落 ${hCount} 个（${Object.entries(headings).map(([k, v]) => `${k}×${v}`).join('、')}）——请确认标题均使用「标题1/标题2」样式以支持目录自动生成` : '未检测到标题样式——若使用手动加粗模拟标题，建议改用标题样式',
  });
  rows.push({
    item: '页码',
    status: hasPageNum ? 'ok' : 'warn',
    note: hasPageNum ? '已检测到页脚页码' : '未检测到页码——学位论文通常要求正文连续页码（摘要/目录可用罗马数字），请检查页脚',
  });
  return rows;
}

// ---------- 应用 ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
// CORS：允许 GitHub Pages 静态前端跨域调用本服务（本地/局域网同源不受影响；Bearer 头模式无需凭证）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));

// 认证
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(username || '')) return res.status(400).json({ error: '用户名需2-20位（中英文/数字/下划线）' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const salt = crypto.randomBytes(16).toString('hex');
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  try { db.prepare('INSERT INTO users(username, pass_hash, salt, is_admin) VALUES(?,?,?,?)').run(username, hashPw(password, salt), salt, isFirst ? 1 : 0); }
  catch { return res.status(409).json({ error: '用户名已存在' }); }
  ok(res, { message: isFirst ? '注册成功（首个账号自动成为管理员，可使用平台Key）' : '注册成功，请登录' });
});
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u) return res.status(401).json({ error: '用户名或密码错误' });
  const h = hashPw(password || '', u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.pass_hash, 'hex'))) return res.status(401).json({ error: '用户名或密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, expires) VALUES(?,?,?)').run(token, u.id, now() + 30 * 86400e3);
  ok(res, { token, username: u.username });
});
app.post('/api/auth/logout', (req, res) => {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  ok(res, { message: '已退出' });
});
app.get('/api/auth/me', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const u = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id=?').get(id);
  const k = db.prepare('SELECT masked, verified FROM api_keys WHERE user_id=?').get(id);
  ok(res, { ...u, isAdmin: u.is_admin === 1 || ADMIN_LIST.includes(u.username), hasKey: !!k, keyMasked: k ? k.masked : '', keyVerified: k ? k.verified === 1 : false, platformKeyPublic: PLATFORM_KEY_PUBLIC });
});

// ---------- AI 分段校对（M5：智能分段·逐块·SSE进度·截断自动细分·单块失败不阻塞） ----------
// 注意：本组路由必须先于 /api/ai/:task 注册，否则会被通配路由吞掉
async function proofreadChunkOnce(chunk, params, key, depth) {
  let r = await dsCall('proofread', chunk, params, key);
  if (!r.ok) r = await dsCall('proofread', chunk, params, key);   // 瞬时故障自动重试一次
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.content.trim()) {
    // 输出为空：模型思考耗尽预算——缩小块重试（最多细分两级）
    if (chunk.length > 600 && depth < 2) {
      const subs = chunkText(chunk, Math.ceil(chunk.length / 2));
      let merged = ''; let subFailed = false;
      for (const s of subs) {
        const r2 = await dsCall('proofread', s, params, key);
        if (!r2.ok || !r2.content.trim()) { subFailed = true; continue; }
        merged += (merged ? '\n' : '') + r2.content;
      }
      if (!subFailed) return { ok: true, content: merged, truncated: true, resplit: true };
      return { ok: false, error: '模型输出为空（思考超预算），细分后仍失败，请稍后重试' };
    }
    return { ok: false, error: '模型输出为空（思考超预算），请稍后重试' };
  }
  if (r.finishReason === 'length' && chunk.length > 1000 && depth < 1) {
    // 输出截断：把本块一分为二再跑（只细分一次）
    const subs = chunkText(chunk, Math.ceil(chunk.length / 2));
    let merged = ''; let subFailed = false;
    for (const s of subs) {
      const r2 = await dsCall('proofread', s, params, key);
      if (!r2.ok || !r2.content.trim()) { subFailed = true; continue; }
      merged += (merged ? '\n' : '') + r2.content;
    }
    if (subFailed) return { ok: false, error: '块细分后仍有子块失败，请重试' };
    return { ok: true, content: merged, truncated: true, resplit: true };
  }
  return { ok: true, content: r.content, truncated: r.finishReason === 'length' };
}
app.post('/api/ai/proofread', rateLimit, async (req, res) => {
  const { text, params } = req.body || {};
  if (!text || String(text).length > 100000) return res.status(400).json({ error: '文本为空或超长（≤10万字符）' });
  const id = requireAuth(req, res); if (!id) return;
  const rk = resolveKeyFor(id);
  if (!rk) return res.status(403).json({ error: 'AI功能需要API Key：请先在「我的Key」配置你自己的DeepSeek密钥并完成本地核对' });
  const p = params || {};
  const maxChunk = Math.min(Math.max(Number(p.maxChunk) || 2500, 800), 3000);
  const chunks = chunkText(String(text), maxChunk);
  sse(res);
  sendEvent(res, { event: 'start', chunks: chunks.length, totalChars: String(text).length, maxChunk });
  for (let i = 0; i < chunks.length; i++) {
    sendEvent(res, { event: 'progress', index: i, done: i, total: chunks.length });
    const r = await proofreadChunkOnce(chunks[i], p, rk.key, 0);
    if (r.ok) sendEvent(res, { event: 'chunk_done', index: i, ok: true, truncated: !!r.truncated, content: r.content });
    else sendEvent(res, { event: 'chunk_error', index: i, ok: false, message: r.error });
  }
  sendEvent(res, { event: 'end' });
  res.write('data: [DONE]\n\n');
  res.end();
});
// 单块重试（M5 F-5 降级重试）
app.post('/api/ai/proofread-chunk', rateLimit, async (req, res) => {
  const { text, params } = req.body || {};
  if (!text || String(text).length > 10000) return res.status(400).json({ error: '单块文本为空或超长（≤1万字符）' });
  const id = requireAuth(req, res); if (!id) return;
  const rk = resolveKeyFor(id);
  if (!rk) return res.status(403).json({ error: 'AI功能需要API Key：请先在「我的Key」配置你自己的DeepSeek密钥并完成本地核对' });
  sse(res);
  const r = await proofreadChunkOnce(String(text), params || {}, rk.key, 1);
  if (!r.ok) { sendEvent(res, { event: 'error', message: r.error }); res.end(); return; }
  sendEvent(res, { event: 'result', content: r.content, truncated: !!r.truncated });
  res.write('data: [DONE]\n\n');
  res.end();
});

// ---------- AI 常规流式（互译M4 / 四要素M6 / 综述M7） ----------
// 注意：/api/ai/proofread 与 /api/ai/proofread-chunk 必须先于 :task 注册，否则被 :task 吞掉
app.post('/api/ai/:task', rateLimit, async (req, res) => {
  const task = req.params.task;
  if (!PROMPTS[task]) return res.status(400).json({ error: '未知功能' });
  const { text, params } = req.body || {};
  if (!text || String(text).length > 100000) return res.status(400).json({ error: '文本为空或超长（≤10万字符）' });
  const id = requireAuth(req, res); if (!id) return;
  const rk = resolveKeyFor(id);
  if (!rk) return res.status(403).json({ error: 'AI功能需要API Key：请先在「我的Key」配置你自己的DeepSeek密钥并完成本地核对（平台Key暂仅管理员可用，付费功能上线后开放借用）' });
  sse(res);
  const r = await dsCall(task, String(text), params || {}, rk.key);
  if (!r.ok) { sendEvent(res, { event: 'error', message: r.error }); res.end(); return; }
  let content = r.content;
  let truncatedNote = '';
  if (r.finishReason === 'length') truncatedNote = '\n\n⚠️ 输出达到长度上限被截断，请缩短输入或分段处理后重试。';
  sendEvent(res, { event: 'meta', model: r.model, finishReason: r.finishReason });
  const CH = 120;
  let i = 0;
  const timer = setInterval(() => {
    if (i >= content.length) {
      clearInterval(timer);
      if (truncatedNote) res.write(`data: ${JSON.stringify({ delta: truncatedNote })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end(); return;
    }
    const piece = content.slice(i, i + CH);
    i += CH;
    res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
  }, 25);
  if (!content.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); }
});

// 引用核查（M2 规则引擎增强版）
app.post('/api/citecheck', (req, res) => {
  const { text, fmt } = req.body || {};
  const t = String(text || '');
  if (!t) return res.status(400).json({ error: '文本为空' });
  if (t.length > 100000) return res.status(400).json({ error: '文本超长（≤10万字符）' });
  ok(res, citeCheck(t, ['gbt7714', 'gbt7714a', 'apa', 'mla'].includes(fmt) ? fmt : 'gbt7714'));
});

// 交稿检查报告（M8：引用核查＋docx基础格式检查·只检不改·确定性）
app.post('/api/checkreport', (req, res) => {
  const { text, fmt, meta } = req.body || {};
  const t = String(text || '');
  if (!t) return res.status(400).json({ error: '文本为空' });
  if (t.length > 100000) return res.status(400).json({ error: '文本超长（≤10万字符）' });
  ok(res, { cite: citeCheck(t, fmt), format: formatCheck(meta || null), rule: '规则引擎（确定性）·未调用LLM' });
});

// 我的Key（BYOK）
app.put('/api/apikey', async (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const key = String((req.body || {}).key || '').trim();
  if (!key) return res.status(400).json({ error: '请输入API Key' });
  const v = await verifyDeepSeekKey(key);
  if (!v.ok) return res.status(400).json({ error: '本地核对未通过：' + v.reason });
  db.prepare('INSERT INTO api_keys(user_id, key_enc, masked, verified, updated_at) VALUES(?,?,?,1,datetime(\'now\',\'localtime\')) ON CONFLICT(user_id) DO UPDATE SET key_enc=excluded.key_enc, masked=excluded.masked, verified=1, updated_at=excluded.updated_at').run(id, enc(key), maskKey(key));
  ok(res, { message: '本地核对通过，密钥已加密保存', masked: maskKey(key) });
});
app.get('/api/apikey', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const k = db.prepare('SELECT masked, verified, updated_at FROM api_keys WHERE user_id=?').get(id);
  ok(res, k ? { hasKey: true, masked: k.masked, verified: k.verified === 1, updatedAt: k.updated_at } : { hasKey: false });
});
app.delete('/api/apikey', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  db.prepare('DELETE FROM api_keys WHERE user_id=?').run(id);
  ok(res, { message: '已删除，AI功能恢复为平台Key规则' });
});

// 记录
app.post('/api/records', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const { type, title, inputLen, output } = req.body || {};
  if (!type || !output) return res.status(400).json({ error: '参数不完整' });
  const r = db.prepare('INSERT INTO records(user_id, type, title, input_len, output) VALUES(?,?,?,?,?)')
    .run(id, String(type).slice(0, 20), String(title || '未命名').slice(0, 80), Number(inputLen) || 0, String(output).slice(0, 200000));
  ok(res, { id: Number(r.lastInsertRowid), message: '已保存（原文不落库，仅保存结果）' });
});
app.get('/api/records', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const q = String(req.query.q || '');
  const rows = q
    ? db.prepare('SELECT id, type, title, input_len, created_at FROM records WHERE user_id=? AND (title LIKE ? OR type LIKE ?) ORDER BY id DESC LIMIT 200').all(id, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT id, type, title, input_len, created_at FROM records WHERE user_id=? ORDER BY id DESC LIMIT 200').all(id);
  ok(res, rows);
});
app.get('/api/records/:rid', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const r = db.prepare('SELECT * FROM records WHERE id=? AND user_id=?').get(Number(req.params.rid), id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  ok(res, r);
});
app.delete('/api/records/:rid', (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  db.prepare('DELETE FROM records WHERE id=? AND user_id=?').run(Number(req.params.rid), id);
  ok(res, { message: '已删除' });
});

// 文件导入（.txt / .docx 含格式元数据 / .pdf 文本层）
app.post('/api/import', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const name = String(req.headers['x-filename'] || '');
  const ext = path.extname(name).toLowerCase();
  try {
    let text = ''; let meta = null;
    if (ext === '.txt' || ext === '.md') text = req.body.toString('utf8');
    else if (ext === '.docx') {
      const zip = new AdmZip(req.body);
      const entry = zip.getEntry('word/document.xml');
      if (!entry) return res.status(400).json({ error: 'docx解析失败：缺少document.xml' });
      text = entry.getData().toString('utf8').replace(/<w:p\b[^>]*>/g, '\n').replace(/<[^>]+>/g, '');
      meta = docxMeta(zip);
    } else if (ext === '.pdf') {
      const r = await pdf(req.body).catch(() => null);
      if (!r) return res.status(400).json({ error: 'PDF解析失败：可能为扫描件（无文本层），OCR能力开发中' });
      text = r.text;
    } else return res.status(400).json({ error: '支持格式：.txt / .docx / .pdf' });
    text = text.slice(0, 100000);
    ok(res, { filename: name, text, chars: text.length, meta });
  } catch (e) { res.status(500).json({ error: `导入失败：${e.message}` }); }
});

// 导出（.txt / .docx）
app.post('/api/export', async (req, res) => {
  const { title, sections, fmt } = req.body || {};
  const secs = Array.isArray(sections) ? sections : [];
  if (!secs.length) return res.status(400).json({ error: '无内容可导出' });
  const fname = (title || '定稿AI导出').replace(/[\\/:*?"<>|]/g, '_');
  if (fmt === 'txt') {
    let out = `${title || '定稿AI导出'}\n\n`;
    for (const s of secs) { out += `【${s.heading || ''}】\n${s.body || ''}\n\n`; }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}.txt"`);
    return res.send(out);
  }
  const kids = [new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title || '定稿AI导出', bold: true, size: 36, font: { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' } })] })];
  for (const s of secs) {
    if (s.heading) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: s.heading, bold: true, size: 28, font: { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' } })] }));
    if (s.body) kids.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, indent: { firstLine: 420 }, spacing: { line: 360 }, children: [new TextRun({ text: s.body, size: 24, font: { ascii: 'Times New Roman', eastAsia: 'SimSun' } })] }));
  }
  const doc = new Document({ sections: [{ properties: { page: { size: { width: 11906, height: 16838 } } }, children: kids }] });
  const buf = await Packer.toBuffer(doc);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}.docx"`);
  res.send(Buffer.from(buf));
});

// 测试辅助：切块单元测试（仅测试模式）
if (IS_TEST) {
  app.post('/api/_test/chunk', (req, res) => {
    const { text, maxChunk } = req.body || {};
    const chunks = chunkText(String(text || ''), Number(maxChunk) || 2500);
    ok(res, { chunks, joined: chunks.join(''), identical: chunks.join('') === String(text || '') });
  });
}

// ============================================================
// 写作全流程 AI 中转（v0.4 本地优先：纯转发·绝不落盘）
// 隐私红线（V1.4修订）：论文全文/大纲/进度/打卡仅存用户浏览器 IndexedDB；
// 服务端没有任何论文数据——以下端点对输入内容仅内存中转调用 DeepSeek，绝不写入数据库。
// 注：v0.3 的 /api/thesis /api/chapters /api/outline(树) /api/progress /api/checkins
//     已在 v0.4 移除（论文数据不再经过服务器存储，改由前端本地库实现）。
// ============================================================

// ---------- M9 选题助手（纯中转：表单→3-5选题六要素JSON；追问由前端携带历史） ----------
app.post('/api/topics/suggest', rateLimit, async (req, res) => {
  const form = (req.body || {}).form || {};
  const problem = String(form.problem || '').trim();
  if (!problem) return res.status(400).json({ error: '请填写实际工程问题（研究起点）' });
  if (problem.length > 20000) return res.status(400).json({ error: '问题描述过长（≤2万字）' });
  const id = requireAuth(req, res); if (!id) return;
  const rk = resolveKeyFor(id);
  if (!rk) return res.status(403).json({ error: 'AI功能需要API Key：请先在「我的Key」配置你自己的DeepSeek密钥并完成本地核对' });
  const count = Math.min(Math.max(Number(form.count) || 5, 3), 5);
  const r = await dsCallRetry('topic', problem, { form: { ...form, count }, responseFormat: true, timeoutMs: 180000 }, rk.key);
  if (!r.ok) return res.status(502).json({ error: r.error });
  const parsed = parseAiJson(r.content);
  if (!parsed.ok || !Array.isArray(parsed.data.topics) || !parsed.data.topics.length) {
    return res.status(502).json({ error: 'AI未按约定格式返回选题（JSON解析失败），请重试或调整问题描述' });
  }
  let topics = parsed.data.topics.slice(0, 5).map((t, i) => ({ index: t.index ?? i + 1, ...t }));
  // T-6 口径：六要素齐全率≥80%，不足时自动带修正要求重试一次（V4生成有随机性）
  if (topics.filter(topicSixOk).length < Math.ceil(topics.length * 0.8)) {
    const r2 = await dsCallRetry('topic', problem, { form: { ...form, count, problem: problem + '（修正要求：上一轮输出有个别选题缺少必要字段——每个选题必须完整包含 title/research_question/innovation_points/relation_to_literature/feasibility(data_availability/method_maturity/time_estimate)/reasons 全部6个字段，请自查后重新输出）' }, responseFormat: true, timeoutMs: 180000 }, rk.key);
    if (r2.ok) {
      const p2 = parseAiJson(r2.content);
      if (p2.ok && Array.isArray(p2.data.topics) && p2.data.topics.length) topics = p2.data.topics.slice(0, 5).map((t, i) => ({ index: t.index ?? i + 1, ...t }));
    }
  }
  ok(res, { topics, model: r.model, aiNote: '选题由AI生成，需人工核验；输入仅内存中转，服务端不存储' });
});
// 追问迭代（纯中转：前端携带会话历史，服务端不存会话）
app.post('/api/topics/iterate', rateLimit, async (req, res) => {
  const { history, question } = req.body || {};
  const q = String(question || '').trim();
  if (!q) return res.status(400).json({ error: '请输入追问内容' });
  if (q.length > 4000) return res.status(400).json({ error: '追问过长（≤4000字）' });
  const id = requireAuth(req, res); if (!id) return;
  const rk = resolveKeyFor(id);
  if (!rk) return res.status(403).json({ error: 'AI功能需要API Key：请先在「我的Key」配置你自己的DeepSeek密钥并完成本地核对' });
  const hist = Array.isArray(history)
    ? history.map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 1500)}`).join('\n')
    : String(history || '').slice(0, 8000);
  const r = await dsCallRetry('topic', hist + '\n用户追问：' + q, { form: {}, responseFormat: true, timeoutMs: 180000, systemOverride: PROMPTS.topic.systemIter }, rk.key);
  if (!r.ok) return res.status(502).json({ error: r.error });
  const parsed = parseAiJson(r.content);
  if (!parsed.ok || !Array.isArray(parsed.data.topics) || !parsed.data.topics.length) {
    return res.status(502).json({ error: 'AI未按约定格式返回选题（JSON解析失败），请重试' });
  }
  let topics = parsed.data.topics.slice(0, 5);
  if (topics.filter(topicSixOk).length < Math.ceil(topics.length * 0.8)) {
    const r2 = await dsCallRetry('topic', hist + '\n用户追问：' + q + '（修正要求：每个选题必须完整包含 title/research_question/innovation_points/relation_to_literature/feasibility(data_availability/method_maturity/time_estimate)/reasons 全部6个字段，请自查后重新输出）', { form: {}, responseFormat: true, timeoutMs: 180000, systemOverride: PROMPTS.topic.systemIter }, rk.key);
    if (r2.ok) {
      const p2 = parseAiJson(r2.content);
      if (p2.ok && Array.isArray(p2.data.topics) && p2.data.topics.length) topics = p2.data.topics.slice(0, 5);
    }
  }
  ok(res, { topics, model: r.model, aiNote: '选题由AI生成，需人工核验；输入仅内存中转，服务端不存储' });
});

// ---------- M10 大纲生成（纯中转：AI章-节两级JSON；树编辑与导出在前端本地库） ----------
app.post('/api/outline/generate', rateLimit, async (req, res) => {
  const id = requireAuth(req, res); if (!id) return;
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ error: '请提供选题/论文标题（可先采纳选题）' });
  const rk = resolveKeyFor(id);
  if (!rk) return res.status(403).json({ error: 'AI功能需要API Key：请先在「我的Key」配置你自己的DeepSeek密钥并完成本地核对' });
  const r = await dsCallRetry('outline', title, { title, extra: String((req.body || {}).extra || '').slice(0, 2000), responseFormat: true, timeoutMs: 180000 }, rk.key);
  if (!r.ok) return res.status(502).json({ error: r.error });
  const parsed = parseAiJson(r.content);
  if (!parsed.ok || !Array.isArray(parsed.data.chapters) || !parsed.data.chapters.length) {
    return res.status(502).json({ error: 'AI未按约定格式返回大纲（JSON解析失败），请重试', raw: r.content.slice(0, 500) });
  }
  ok(res, { chapters: parsed.data.chapters.slice(0, 12), model: r.model, aiNote: '大纲由AI生成，需人工核验；应用后可在「大纲」页继续编辑' });
});
// 健康与能力清单
function lanUrls() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return [...new Set(out)];
}
app.get('/api/health', (req, res) => ok(res, { status: 'ok', version: '0.4', models: MODELS, hasKey: !!API_KEY, lanUrls: lanUrls(), local: `http://localhost:${PORT}`, privacy: '论文数据仅存用户浏览器本地，服务端不存储论文内容', time: new Date().toISOString() }));

app.listen(PORT, '::', () => {
  console.log(`[定稿AI v0.4] 服务已启动 http://[::]:${PORT}（IPv4/IPv6 双栈，cpolar 走 [::1] 亦可达）`);
  for (const u of lanUrls()) console.log(`[定稿AI v0.4] 本机访问 ${u} （其他电脑请用此地址，需防火墙放行 TCP ${PORT}）`);
  console.log(`[定稿AI v0.4] DeepSeek密钥：${API_KEY ? '已加载' : '未配置（功能将返回503）'} · 数据库：${DB_PATH}（仅账号/密钥/记录，无论文数据）`);
  if (IS_TEST) console.log('[定稿AI v0.4] 测试模式');
});

// ---------- 测试钩子：纯函数导出（单元测试 TC-U01~U10 import 用；不影响服务行为） ----------
export { chunkText, splitLongPara, citeCheck, docxMeta, formatCheck };
