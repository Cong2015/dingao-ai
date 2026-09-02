// 定稿AI 开发版 v0.2 — 前端逻辑（原生JS，无构建依赖）
// 布局：左侧主要功能导航 + 主区（编辑器/细部选项/结果）
'use strict';
const $ = (s) => document.querySelector(s);
// 全局错误横幅：任何脚本错误直接显示在页面顶部（不再静默失效）
window.addEventListener('error', (e) => {
  const el = $('#jsError');
  if (el) {
    el.classList.remove('hidden');
    el.textContent = '⚠️ 页面脚本出错：' + (e && e.message ? e.message : '未知错误') + '（请按 Ctrl+F5 刷新；仍出现请截图反馈）';
  }
});
const api = {
  token: localStorage.getItem('dg_token') || '',
  async req(path, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opt.body && typeof opt.body === 'string' && !opt.raw) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, { ...opt, headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `请求失败(${r.status})`);
    return data;
  },
};

let currentFn = 'translate';
let lastResult = '';
let lastMeta = null;                    // docx 格式元数据（交稿检查报告用）
const editorHistory = [];               // 撤销栈（最多7次，PRD AC4）
const reviewDocs = [];                  // 参考版综述多文献（每批≤6篇）
let proofreadState = null;              // 分段校对进行中的状态

// ============================================================
// 功能注册表：左侧主要功能 → 主区细部功能
// ============================================================
const FNS = {
  translate: {
    title: '中英互译', desc: '文献段落学术语体互译，逐句对照，可一键替换到原文', editorTitle: '📝 原文 / 待翻译内容',
    hint: 'M4 · 译文仅限你上传/粘贴的文献资料，标注AI生成。撤销保留最近7次。',
    sample: '摘要：本文研究建设单位在商业TOD项目中的多方协同管理机制。基于利益相关者理论，对某商业综合体TOD项目开展案例研究，采用半结构化访谈与问卷调查相结合的方法，收集了开发商、政府、轨道交通公司、运营商与商户五类主体的协同数据。',
    opts: () => `
      <div class="opt-row"><span>翻译方向</span>
        <select id="optLang"><option value="en2zh">英 → 中</option><option value="zh2en">中 → 英</option></select></div>
      <div class="opt-row"><span>模型</span><select id="optModel">${modelOpts()}</select></div>
      <div class="opt-row"><span>温度</span><select id="optTemp"><option value="0.3" selected>0.3（稳定）</option><option value="0.7">0.7（多样）</option></select></div>`,
    run: (text) => runStream('/api/ai/translate', text, { lang: $('#optLang').value }),
  },
  proofread: {
    title: '分段校对', desc: '智能分段逐块校对机械错误（错别字/标点/空格），逐条确认后可应用到原文', editorTitle: '📝 原文（长文将自动分段处理）',
    hint: 'M5 · 自动按 ≤上限 切块逐块校对，可见进度、单块可重试；整篇一键修正不提供（实测长文AI不可靠），请逐条确认后应用。仅改机械错误（内容0修改红线）。',
    sample: '摘要:本文研就建设单位在商业TOD项目中的多方协同管理机制,基于利益相关者理论，对某商业综合体TOD项目开展案例研究, 采用半结构化访谈与问卷调查相结合的方法, 收集了开发商,政府,轨道交通公司,运营商与商户五类主体的协同数据。研究发现:①多方协同的核心障碍是目标不一致与信息不对称; ②联合体协议与数据共享平台显著提升协同效率;③利益分配机制是协同可持续的关键。。本研究的局限在于单案例研究的外部效度有限,且未纳入金融机构视角。',
    opts: () => `
      <div class="opt-row"><span>模型</span><select id="optModel">${modelOpts()}</select></div>
      <div class="opt-row"><span>单块上限</span>
        <select id="optChunk"><option value="1500">1500 字（更稳）</option><option value="2500" selected>2500 字（推荐）</option><option value="3000">3000 字（更快）</option></select></div>
      <div class="opt-row"><span>温度</span><select id="optTemp"><option value="0.3" selected>0.3（稳定）</option><option value="0.7">0.7（多样）</option></select></div>`,
    run: (text) => runProofread(text),
  },
  analyze: {
    title: '文献四要素分析', desc: '单篇文献 → 研究方法 / 核心结论 / 局限不足 / 可切入方向 四张卡片', editorTitle: '📝 文献内容（单篇，≤2万字）',
    hint: 'M6 · 只基于给定内容推断，不虚构数据；输出标注AI生成需人工核验。',
    sample: '摘要：本文研究建设单位在商业TOD项目中的多方协同管理机制。方法：基于利益相关者理论，对某商业综合体TOD项目开展案例研究，采用半结构化访谈与问卷调查，收集五类主体协同数据。结论：联合体协议与数据共享平台显著提升协同效率，利益分配机制是协同可持续的关键。局限：单案例研究外部效度有限，未纳入金融机构视角。',
    opts: () => `
      <div class="opt-row"><span>模型</span><select id="optModel">${modelOpts()}</select></div>
      <div class="opt-row"><span>温度</span><select id="optTemp"><option value="0.3" selected>0.3（稳定）</option><option value="0.7">0.7（多样）</option></select></div>`,
    run: (text) => runStream('/api/ai/analyze', text, {}),
  },
  review: {
    title: '参考版文献综述', desc: '上传 ≤6 篇文献，按主题整合生成参考版综述（引用[1][2]标注）', editorTitle: '📝 文献内容（可导入多篇，每批≤6篇）',
    hint: 'M7 · 按主题整合而非逐篇罗列；固定AI声明「为参考版，引用与论断均需人工核验后方可使用」。',
    sample: '',
    opts: () => `
      <div class="opt-row"><span>模型</span><select id="optModel">${modelOpts()}</select></div>
      <div class="opt-row"><span>温度</span><select id="optTemp"><option value="0.3" selected>0.3（稳定）</option><option value="0.7">0.7（多样）</option></select></div>
      <button id="addDocsBtn" class="btn" style="width:100%">📂 添加文献（≤6篇）</button>
      <div class="opt-note" id="docsNote">已添加 0 / 6 篇</div>`,
    run: (text) => {
      const parts = [];
      reviewDocs.forEach((d, i) => parts.push(`[${i + 1}] ${d.name}\n${d.text}`));
      if (text.trim()) parts.push(text);
      if (!parts.length) throw new Error('请先导入或粘贴文献内容');
      return runStream('/api/ai/review', parts.join('\n\n'), {});
    },
  },
  citecheck: {
    title: '引用核查', desc: '文内标记 ↔ 文末列表双向核查；序号错位一键修正建议；重复文献识别', editorTitle: '📝 论文全文（含文末参考文献列表）',
    hint: 'M2 · 规则引擎确定性实现，零AI成本。支持 GB/T 7714 / APA 7th / MLA 9th 体例。',
    sample: '正文引用了方法[1]与案例[3,2]。此外[2]给出理论框架。\n\n参考文献：\n[1] 张三. 测试文献一[J]. 测试学报, 2024.\n[2] 李四. 测试文献二[J]. 测试学报, 2024.\n[3] 王五. 测试文献三[J]. 测试学报, 2024.',
    opts: () => `
      <div class="opt-row"><span>引用体例</span>
        <select id="optFmt">
          <option value="gbt7714" selected>GB/T 7714 顺序编码制</option>
          <option value="gbt7714a">GB/T 7714 著者-出版年制</option>
          <option value="apa">APA 7th</option>
          <option value="mla">MLA 9th</option>
        </select></div>`,
    run: async (text) => {
      const d = await api.req('/api/citecheck', { method: 'POST', body: JSON.stringify({ text, fmt: $('#optFmt').value }) });
      renderCite(d);
      return citeText(d);
    },
  },
  checkreport: {
    title: '交稿检查报告', desc: '引用双向核查 + docx 基础格式检查（页边距/字体/行距/标题/页码）只检不改', editorTitle: '📝 论文全文（导入 .docx 可同时检查格式）',
    hint: 'M8 · 规则引擎确定性实现，10万字≤60秒，零AI成本。格式检查需导入 .docx（.txt 仅能查引用）。只检不改（内容0修改红线）。',
    sample: '',
    opts: () => `
      <div class="opt-row"><span>引用体例</span>
        <select id="optFmt">
          <option value="gbt7714" selected>GB/T 7714 顺序编码制</option>
          <option value="gbt7714a">GB/T 7714 著者-出版年制</option>
          <option value="apa">APA 7th</option>
          <option value="mla">MLA 9th</option>
        </select></div>
      <div class="opt-note ok" id="fmtMetaNote">${lastMeta ? '✅ 已载入 docx 格式元数据，将执行格式检查' : '💡 导入 .docx 文件后，此处将自动执行格式检查'}</div>`,
    run: async (text) => {
      const d = await api.req('/api/checkreport', { method: 'POST', body: JSON.stringify({ text, fmt: $('#optFmt').value, meta: lastMeta }) });
      renderReport(d);
      return reportText(d);
    },
  },
  records: {
    title: '我的记录', desc: '查看、搜索、删除保存过的处理结果（原文不落库）', editorTitle: '', hideEditor: true,
    hint: '仅保存你主动保存的结果记录；原文不落库。',
    opts: () => `<div class="opt-row"><span>搜索</span><input type="text" id="recSearch" placeholder="标题 / 功能类型…"></div><button id="recSearchBtn" class="btn" style="width:100%">🔍 查询</button>`,
    run: async () => { await loadRecords(); return ''; },
  },
};
function modelOpts() {
  return '<option value="deepseek-v4-flash" selected>deepseek-v4-flash（快·推荐）</option>' +
    '<option value="deepseek-v4-pro">deepseek-v4-pro（强·⚠️易超时）</option>';
}

// ============================================================
// 导航切换
// ============================================================
// 导航：点击左侧命令 → 右侧立即切换到对应操作页面（高亮同步）
function setActiveNav(fn) {
  document.querySelectorAll('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.fn === fn));
}
document.querySelectorAll('.nav-item').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  setActiveNav(a.dataset.fn);
  switchFn(a.dataset.fn);
}));
// hash 路由兜底：刷新页面/浏览器前进后退也回到对应功能页
window.addEventListener('hashchange', () => {
  const fn = (location.hash || '').replace(/^#\/?/, '') || 'topic';
  if (FNS[fn] || WRITE_FNS.includes(fn)) { setActiveNav(fn); switchFn(fn); }
});
const WRITE_FNS = ['topic', 'outline', 'writing', 'progress'];
const WRITE_META = {
  topic: ['选题助手', '从实际问题出发，AI 生成 3-5 个选题建议（六要素），可追问迭代、一键采纳'],
  outline: ['大纲生成', '章-节两级大纲：AI 生成 + 树状编辑，改动自动保存'],
  writing: ['本地编写', '按章节写作，自动保存，定期导出 Word 备份——内容仅存本机，不上云'],
  progress: ['进度打卡', '全文字数统计、进度条、每日打卡与连续天数'],
};
function switchFn(fn) {
  currentFn = fn;
  const isWrite = WRITE_FNS.includes(fn);
  $('#writeViews').classList.toggle('hidden', !isWrite);
  $('#workspace').classList.toggle('hidden', isWrite);
  $('#resultPanel').classList.toggle('hidden', isWrite);
  if (isWrite) {
    const [t, d] = WRITE_META[fn];
    $('#fnTitle').textContent = t;
    $('#fnDesc').textContent = d;
    if (!api.token) { if (fn === 'topic') renderTopic(); else showModal('login'); return; }
    if (fn === 'topic') renderTopic();
    else if (fn === 'outline') renderOutline();
    else if (fn === 'writing') renderWriting();
    else if (fn === 'progress') renderProgress();
    return;
  }
  const f = FNS[fn];
  $('#fnTitle').textContent = f.title;
  $('#fnDesc').textContent = f.desc;
  $('#fnHint').textContent = f.hint;
  $('#editorTitle').textContent = f.editorTitle || '';
  $('#editor').classList.toggle('hidden', !!f.hideEditor);
  $('#docList').classList.toggle('hidden', fn !== 'review');
  if (fn === 'records') { $('#runBtn').textContent = '🔄 刷新记录'; } else { $('#runBtn').textContent = '▶ 开始处理'; }
  $('#opts').innerHTML = f.opts ? f.opts() : '';
  bindFnOpts(fn);
  if (fn === 'records') { loadRecords(); }
  if (fn === 'review') renderDocs();
}
function bindFnOpts(fn) {
  if (fn === 'review') {
    $('#addDocsBtn')?.addEventListener('click', () => $('#multiInput').click());
    $('#recSearchBtn')?.addEventListener('click', () => loadRecords());
  }
  if (fn === 'records') {
    $('#recSearchBtn')?.addEventListener('click', () => loadRecords());
    $('#recSearch')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
  }
}

// ============================================================
// 编辑器：字数/撤销/导入/示例
// ============================================================
$('#editor').addEventListener('input', () => $('#charCount').textContent = $('#editor').value.length + ' 字');
function pushHistory() {
  editorHistory.push($('#editor').value);
  if (editorHistory.length > 7) editorHistory.shift();   // 保留最近7次（PRD AC4）
}
$('#undoBtn').addEventListener('click', () => {
  if (!editorHistory.length) return;
  $('#editor').value = editorHistory.pop();
  $('#charCount').textContent = $('#editor').value.length + ' 字';
});
$('#clearBtn').addEventListener('click', () => { pushHistory(); $('#editor').value = ''; $('#charCount').textContent = '0 字'; });
$('#sampleBtn').addEventListener('click', () => {
  const s = FNS[currentFn].sample;
  if (s) { pushHistory(); $('#editor').value = s; $('#charCount').textContent = s.length + ' 字'; }
});
$('#importBtn').addEventListener('click', () => {
  if (currentFn === 'review') $('#multiInput').click();
  else $('#fileInput').click();
});
async function readFiles(files) {
  const out = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const d = await api.req('/api/import', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: buf, raw: true });
    out.push(d);
  }
  return out;
}
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    pushHistory();
    const d = (await readFiles([f]))[0];
    lastMeta = d.meta || null;
    $('#editor').value = d.text;
    $('#charCount').textContent = d.chars + ' 字';
    if (currentFn === 'checkreport') { const n = $('#fmtMetaNote'); if (n) { n.className = 'opt-note ok'; n.textContent = '✅ 已载入 docx 格式元数据，将执行格式检查'; } }
    setResult(`✅ 已导入「${f.name}」（${d.chars} 字符）\n\n原文已填入左侧编辑器${d.meta ? '，格式元数据已载入（可在交稿检查报告中检查格式）' : ''}。`);
  } catch (err) { setResult('❌ ' + err.message, true); }
  e.target.value = '';
});
$('#multiInput').addEventListener('change', async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  try {
    if (reviewDocs.length + files.length > 6) throw new Error('每批最多6篇文献，请先移除部分文献');
    const list = await readFiles(files);
    list.forEach((d) => reviewDocs.push({ name: d.filename, text: d.text }));
    renderDocs();
    setResult(`✅ 已添加 ${list.length} 篇文献（当前共 ${reviewDocs.length}/6 篇），点击「开始处理」生成参考版综述。`);
  } catch (err) { setResult('❌ ' + err.message, true); }
  e.target.value = '';
});
function renderDocs() {
  $('#docList').innerHTML = reviewDocs.map((d, i) =>
    `<span class="doc-chip">📄 ${escapeHtml(d.name.slice(0, 18))}<span class="x" data-i="${i}">✕</span></span>`).join('');
  document.querySelectorAll('#docList .x').forEach((x) => x.addEventListener('click', () => {
    reviewDocs.splice(Number(x.dataset.i), 1); renderDocs();
  }));
  const n = $('#docsNote');
  if (n) n.textContent = `已添加 ${reviewDocs.length} / 6 篇`;
}

// ============================================================
// 结果区
// ============================================================
function setResult(text, isErr) {
  const box = $('#resultBox');
  box.innerHTML = ''; lastResult = text;
  if (!text) { box.innerHTML = '<span class="empty">等待处理……选择左侧功能，点击「开始处理」</span>'; $('#resultStatus').textContent = '等待处理'; return; }
  const el = document.createElement('div');
  if (isErr) el.style.color = '#c94f4f';
  el.textContent = text;
  box.appendChild(el);
  $('#resultStatus').textContent = '完成';
}
function setResultHTML(html, statusText) {
  $('#resultBox').innerHTML = html;
  $('#resultStatus').textContent = statusText || '完成';
}
function appendDelta(delta) {
  const box = $('#resultBox');
  if (!box.lastChild || !box.lastChild.classList || box.lastChild.classList.contains('empty')) { box.innerHTML = ''; const el = document.createElement('div'); box.appendChild(el); }
  box.lastChild.textContent += delta;
  box.scrollTop = box.scrollHeight;
}
function showProgress(show, text, pct) {
  $('#progressWrap').classList.toggle('hidden', !show);
  if (show) { $('#progressBar').style.width = (pct || 0) + '%'; $('#progressText').textContent = text || ''; }
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const escapeHtml = esc;

// ---------- 通用流式（互译/四要素/综述） ----------
async function runStream(path, text, extraParams) {
  const headers = { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' };
  const params = {
    model: $('#optModel')?.value || 'deepseek-v4-flash',
    temperature: Number($('#optTemp')?.value || 0.3),
    ...extraParams,
  };
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ text, params }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `请求失败(${r.status})`); }
  const reader = r.body.getReader(); const dec = new TextDecoder();
  $('#resultBox').innerHTML = '<div></div>';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      const s = ln.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') break;
      try { const j = JSON.parse(data); if (j.delta) appendDelta(j.delta); } catch {}
    }
  }
  const textOut = $('#resultBox').lastChild.textContent;
  lastResult = textOut + '\n\n—— 本内容由AI生成，需人工核验（内容0修改红线） ——';
  const el = $('#resultBox').lastChild;
  el.textContent = lastResult;
  $('#resultStatus').textContent = '完成（AI·需人工核验）';
  return lastResult;
}

// ---------- M5 分段校对（SSE进度 + 块卡片 + 逐条应用 + 单块重试） ----------
function parseFixes(content) {
  const fixes = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || /共\s*\d+\s*处|未发现机械错误|^#/.test(line)) continue;
    const m = line.match(/^(?:\d+[\.、）)]\s*|[-•]\s*)?(.+?)\s*→\s*(.+)$/);
    if (m && m[1].trim() !== m[2].trim()) fixes.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return fixes;
}
async function runProofread(text) {
  const headers = { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' };
  const params = {
    model: $('#optModel')?.value || 'deepseek-v4-flash',
    temperature: Number($('#optTemp')?.value || 0.3),
    maxChunk: Number($('#optChunk')?.value || 2500),
  };
  const r = await fetch('/api/ai/proofread', { method: 'POST', headers, body: JSON.stringify({ text, params }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `请求失败(${r.status})`); }
  proofreadState = { chunks: [], chunkTexts: [], allFixes: [], chunkStatus: [] };
  const box = $('#resultBox');
  box.innerHTML = '';
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      const s = ln.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.event === 'start') {
        proofreadState.chunkTexts = chunkLocal(text, j.maxChunk);
        showProgress(true, `准备校对 ${j.chunks} 块…`, 2);
      } else if (j.event === 'progress') {
        showProgress(true, `正在校对第 ${j.index + 1}/${j.total} 块…`, Math.round((j.index / j.total) * 95));
      } else if (j.event === 'chunk_done') {
        proofreadState.chunkStatus[j.index] = j.truncated ? 'warn' : 'ok';
        proofreadState.chunkTexts[j.index] = proofreadState.chunkTexts[j.index] || '';
        renderChunkCard(j.index, j.content, proofreadState.chunkStatus[j.index], j.truncated ? '已自动细分处理（输出曾达上限）' : '');
      } else if (j.event === 'chunk_error') {
        proofreadState.chunkStatus[j.index] = 'err';
        renderChunkCard(j.index, j.message, 'err', '', true);
      } else if (j.event === 'end') {
        showProgress(false);
        renderProofreadSummary();
      }
    }
  }
  const txt = proofreadAllText();
  lastResult = txt;
  return txt;
}
function chunkLocal(text, max) {
  // 与服务端同策略的轻量切块（仅用于前端展示块文本/重试），精确切块以服务端为准
  const chunks = []; let cur = '';
  for (const para of text.split(/(\n+)/)) {
    if (!para) continue;
    if (/^\n+$/.test(para)) { cur += para; continue; }
    if (para.length > max) { if (cur) { chunks.push(cur); cur = ''; } chunks.push(para); }
    else if ((cur + para).length > max) { chunks.push(cur); cur = para; }
    else cur += para;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
function renderChunkCard(index, content, status, note, failed) {
  const box = $('#resultBox');
  const card = document.createElement('div');
  card.className = 'chunk-card st-' + (status || 'ok');
  card.id = 'chunk-' + index;
  const statusTxt = status === 'err' ? '✗ 失败' : status === 'warn' ? '⚠ 截断已细分' : '✓ 成功';
  card.innerHTML = `<div class="chunk-head"><b>第 ${index + 1} 块</b><span>${statusTxt}</span><span style="color:#A6ADBB">${esc(note || '')}</span><span class="spacer" style="flex:1"></span><button class="btn ghost small" data-retry="${index}">重试此块</button></div>`;
  const body = document.createElement('div');
  body.className = 'chunk-body';
  if (failed) {
    body.innerHTML = `<div style="color:#c94f4f">${esc(content)}</div>`;
  } else {
    const fixes = parseFixes(content);
    if (!fixes.length) {
      body.innerHTML = `<div style="color:#0B8A63">✓ 未发现机械错误</div>`;
    } else {
      fixes.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'fix-item';
        item.innerHTML = `<input type="checkbox" checked data-fix="${index}-${i}"><span class="from">${esc(f.from)}</span><span class="arrow">→</span><span class="to">${esc(f.to)}</span>`;
        body.appendChild(item);
        proofreadState.allFixes.push({ index, i, ...f });
      });
    }
  }
  card.appendChild(body);
  box.appendChild(card);
  card.querySelector('[data-retry]')?.addEventListener('click', () => retryChunk(Number(card.querySelector('[data-retry]').dataset.retry)));
  box.scrollTop = box.scrollHeight;
}
async function retryChunk(index) {
  const text = proofreadState.chunkTexts[index];
  if (!text) return;
  const headers = { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' };
  const card = $('#chunk-' + index);
  card.querySelector('.chunk-head').innerHTML = `<b>第 ${index + 1} 块</b><span>重试中…</span><span class="spacer" style="flex:1"></span>`;
  const r = await fetch('/api/ai/proofread-chunk', { method: 'POST', headers, body: JSON.stringify({ text, params: { model: $('#optModel')?.value || 'deepseek-v4-flash', temperature: Number($('#optTemp')?.value || 0.3) } }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); alert('重试失败：' + (d.error || r.status)); return; }
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', content = '', truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const ln of buf.split('\n')) {
      const s = ln.trim(); if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim(); if (data === '[DONE]') continue;
      try { const j = JSON.parse(data); if (j.event === 'result') { content = j.content; truncated = !!j.truncated; } if (j.event === 'error') throw new Error(j.message); } catch (e) { if (e.message && e.message !== 'Unexpected token') alert(e.message); }
    }
  }
  proofreadState.chunkStatus[index] = truncated ? 'warn' : 'ok';
  card.remove();
  renderChunkCard(index, content, proofreadState.chunkStatus[index], truncated ? '已自动细分处理' : '');
}
function renderProofreadSummary() {
  const st = proofreadState;
  const done = st.chunkStatus.filter((s) => s === 'ok' || s === 'warn').length;
  const total = st.chunkStatus.length;
  const totalFixes = st.allFixes.length;
  const bar = document.createElement('div');
  bar.className = 'apply-bar';
  bar.innerHTML = `<span class="stat-chip">块完成 <b>${done}/${total}</b></span><span class="stat-chip">检出 <b>${totalFixes}</b> 处</span>`;
  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn primary small';
  applyBtn.textContent = '✍ 将选中项应用到原文';
  applyBtn.addEventListener('click', applySelectedFixes);
  bar.appendChild(applyBtn);
  const box = $('#resultBox');
  box.insertBefore(bar, box.firstChild);
  $('#resultStatus').textContent = `完成（${done}/${total} 块 · AI·需人工核验）`;
}
function applySelectedFixes() {
  const checked = new Set();
  document.querySelectorAll('#resultBox .fix-item input').forEach((c) => { if (c.checked) checked.add(c.dataset.fix); });
  const fixes = proofreadState.allFixes.filter((f) => checked.has(`${f.index}-${f.i}`));
  if (!fixes.length) { alert('未勾选任何修正项'); return; }
  pushHistory();
  let txt = $('#editor').value;
  let applied = 0;
  for (const f of fixes) {
    if (txt.includes(f.from)) { txt = txt.split(f.from).join(f.to); applied++; }
  }
  $('#editor').value = txt;
  $('#charCount').textContent = txt.length + ' 字';
  setResult(lastResult + `\n\n✅ 已将 ${applied} 处修正应用到原文（其余 ${fixes.length - applied} 处未在原稿中找到对应文字）。可在左侧原文继续核对。`);
}
function proofreadAllText() {
  const st = proofreadState;
  let out = '【分段校对结果】\n';
  st.chunkStatus.forEach((s, i) => {
    const fixes = parseFixes(st.chunkTexts[i] && $('#chunk-' + i) ? $('#chunk-' + i).textContent : '');
    out += `\n第 ${i + 1} 块：${s === 'err' ? '失败' : s === 'warn' ? '完成（已细分）' : '完成'}\n`;
  });
  const totalFixes = st.allFixes.length;
  out += `\n共检出 ${totalFixes} 处机械错误（逐条见上方卡片）。\n—— 本内容由AI生成，需人工核验（内容0修改红线） ——`;
  return out;
}

// ---------- M2 引用核查渲染 ----------
function citeText(d) {
  let out = `【引用核查结果】（${d.rule}）\n体例：${d.fmt === 'gbt7714' ? 'GB/T 7714 顺序编码制' : d.fmt === 'apa' ? 'APA 7th' : d.fmt === 'mla' ? 'MLA 9th' : 'GB/T 7714 著者-出版年制'}\n文内引用 ${d.intextCount} 处 · 文末文献 ${d.refCount} 条\n\n${d.issues.join('\n')}`;
  if (d.renumber) {
    out += `\n\n【序号修正建议】（旧→新）\n${Object.entries(d.renumber.mapping).map(([k, v]) => `[${k}] → [${v}]`).join('　')}\n\n【修正后参考文献顺序】\n${d.renumber.renumberedRefs.join('\n')}`;
  }
  return out;
}
function renderCite(d) {
  const li = (txt, cls) => `<li class="${cls || ''}">${esc(txt)}</li>`;
  let html = `<div class="stats-row">
    <span class="stat-chip">文内引用 <b>${d.intextCount}</b></span>
    <span class="stat-chip">文末文献 <b>${d.refCount}</b></span>
    <span class="stat-chip">体例 <b>${d.fmt === 'gbt7714' ? 'GB/T 7714 顺序编码制' : d.fmt === 'apa' ? 'APA 7th' : d.fmt === 'mla' ? 'MLA 9th' : 'GB/T 7714 著者-出版年制'}</b></span>
  </div><ul class="issue-list">`;
  for (const it of d.issues) html += li(it, d.issues.length === 1 && d.issues[0].startsWith('未发现') ? 'ok' : '');
  html += '</ul>';
  if (d.renumber) {
    html += `<div class="section-title">🔢 序号修正建议（按首次出现顺序重排）</div>
      <div class="stats-row">${Object.entries(d.renumber.mapping).map(([k, v]) => `<span class="stat-chip">[${k}] → [${v}]</span>`).join('')}</div>
      <div class="section-title">修正后参考文献顺序（可复制）</div>
      <div class="code-box">${esc(d.renumber.renumberedRefs.join('\n'))}</div>`;
  }
  html += `<div class="ai-note">${esc(d.rule)} · 修正建议需人工确认后应用（内容0修改红线）</div>`;
  setResultHTML(html, '完成（规则引擎·确定性）');
}

// ---------- M8 交稿检查报告渲染 ----------
function reportText(d) {
  let out = `【交稿检查报告】\n生成时间：${new Date().toLocaleString()}\n（${d.rule}）\n\n一、引用核查\n${d.cite.issues.join('\n')}\n\n二、基础格式检查\n`;
  for (const row of d.format) out += `· ${row.item}：${row.status === 'ok' ? '正常' : row.status === 'warn' ? '需注意' : '未检查'} —— ${row.note}\n`;
  return out;
}
function renderReport(d) {
  const pill = (s) => s === 'ok' ? '<span class="tag-pill ok">正常</span>' : s === 'warn' ? '<span class="tag-pill warn">需注意</span>' : '<span class="tag-pill na">未检查</span>';
  let html = `<div class="section-title">一、引用核查（规则引擎）</div>
    <div class="stats-row"><span class="stat-chip">文内引用 <b>${d.cite.intextCount}</b></span><span class="stat-chip">文末文献 <b>${d.cite.refCount}</b></span></div>
    <ul class="issue-list">`;
  for (const it of d.cite.issues) html += `<li class="${d.cite.issues.length === 1 && d.cite.issues[0].startsWith('未发现') ? 'ok' : ''}">${esc(it)}</li>`;
  html += `</ul><div class="section-title">二、基础格式检查（只检不改）</div><table class="fmt-table">
    <tr><th style="width:110px">检查项</th><th style="width:80px">结论</th><th>说明</th></tr>`;
  for (const row of d.format) html += `<tr><td>${esc(row.item)}</td><td>${pill(row.status)}</td><td>${esc(row.note)}</td></tr>`;
  html += `</table><div class="ai-note">${esc(d.rule)} · 全部问题仅列出定位，不做任何自动修改（内容0修改红线）</div>`;
  setResultHTML(html, '完成（规则引擎·确定性）');
}

// ============================================================
// 运行入口
// ============================================================
$('#runBtn').addEventListener('click', async () => {
  const f = FNS[currentFn];
  if (currentFn === 'records') { await loadRecords(); return; }
  const text = $('#editor').value;
  if (!text.trim() && !reviewDocs.length && !(currentFn === 'review')) { setResult('⚠️ 请先粘贴或导入文本', true); return; }
  if (!api.token) { showModal('login'); return; }
  setResult(''); lastResult = '';
  $('#resultStatus').textContent = '处理中…';
  $('#resultBox').innerHTML = '<div><span class="empty">正在处理</span><span class="cursor"></span></div>';
  try {
    const out = await f.run(text);
    if (out && currentFn !== 'proofread' && currentFn !== 'citecheck' && currentFn !== 'checkreport') {
      lastResult = out;
    }
  } catch (e) { setResult('❌ ' + e.message, true); $('#resultStatus').textContent = '失败'; }
});

// ============================================================
// 保存 / 导出 / 复制
// ============================================================
$('#saveBtn').addEventListener('click', async () => {
  if (!lastResult.trim()) { setResult('⚠️ 暂无结果可保存', true); return; }
  if (!api.token) { showModal('login'); return; }
  try {
    const d = await api.req('/api/records', { method: 'POST', body: JSON.stringify({ type: FNS[currentFn].title, title: ($('#editor').value.trim() || '未命名').slice(0, 40), inputLen: $('#editor').value.length, output: lastResult }) });
    setResult(lastResult + '\n\n✅ 已保存为记录 #' + d.id + '（仅保存结果，原文不落库）');
  } catch (e) { setResult('❌ ' + e.message, true); }
});
async function doExport(fmt) {
  if (!lastResult.trim()) { setResult('⚠️ 暂无结果可导出', true); return; }
  try {
    const d = { title: FNS[currentFn].title + '结果', sections: [{ heading: FNS[currentFn].title + '结果', body: lastResult }] };
    const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...d, fmt }) });
    if (!r.ok) throw new Error('导出失败');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (d.title || '定稿AI导出') + '.' + fmt;
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { setResult('❌ ' + e.message, true); }
}
$('#exportTxtBtn').addEventListener('click', () => doExport('txt'));
$('#exportDocxBtn').addEventListener('click', () => doExport('docx'));
$('#copyBtn').addEventListener('click', async () => {
  if (!lastResult.trim()) return;
  await navigator.clipboard.writeText(lastResult).catch(() => {});
  $('#resultStatus').textContent = '已复制';
});

// ============================================================
// 登录 / 我的Key
// ============================================================
let authMode = 'login';
function showModal(mode) { authMode = mode; $('#modalTitle').textContent = mode === 'login' ? '登录定稿AI' : '注册新账号'; $('#authSubmit').textContent = mode === 'login' ? '登录' : '注册'; $('#authToggle').textContent = mode === 'login' ? '去注册' : '去登录'; $('#authMsg').textContent = ''; $('#modal').classList.remove('hidden'); }
function hideModal() { $('#modal').classList.add('hidden'); }
function setAuth(ok2, msg) { const m = $('#authMsg'); m.textContent = msg; m.className = 'msg ' + (ok2 ? 'ok' : 'err'); }
async function authSubmit() {
  const username = $('#authUser').value.trim(), password = $('#authPass').value;
  try {
    if (authMode === 'login') {
      const d = await api.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      api.token = d.token; localStorage.setItem('dg_token', d.token);
      setAuth(true, '登录成功'); hideModal(); refreshUser(); loadRecords();
      switchFn(currentFn);   // 登录成功后立即渲染当前功能页（避免停在登录前状态）
    } else {
      await api.req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
      setAuth(true, '注册成功，请登录'); authMode = 'login'; $('#modalTitle').textContent = '登录定稿AI'; $('#authSubmit').textContent = '登录'; $('#authToggle').textContent = '去注册';
    }
  } catch (e) { setAuth(false, e.message); }
}
async function refreshUser() {
  if (!api.token) { api.userId = null; $('#userName').classList.add('hidden'); $('#keyBtn').classList.add('hidden'); $('#loginBtn').classList.remove('hidden'); $('#logoutBtn').classList.add('hidden'); return; }
  try {
    const u = await api.req('/api/auth/me');
    api.userId = u.id;
    $('#userName').textContent = u.username + (u.isAdmin ? '（管理员）' : '');
    $('#userName').classList.remove('hidden');
    $('#loginBtn').classList.add('hidden'); $('#logoutBtn').classList.remove('hidden');
    $('#keyBtn').classList.remove('hidden');
    $('#keyBtn').textContent = '🔑 API Key';   // 不显示 sk- 掩码，仅钥匙图标＋标签
  } catch { api.token = ''; api.userId = null; localStorage.removeItem('dg_token'); }
}
async function logout() { await api.req('/api/auth/logout', { method: 'POST' }).catch(() => {}); api.token = ''; api.userId = null; localStorage.removeItem('dg_token'); refreshUser(); loadRecords(); }
async function loadKeyStatus() {
  try {
    const k = await api.req('/api/apikey');
    const s = $('#keyStatus');
    s.className = 'msg';
    const me = await api.req('/api/auth/me').catch(() => ({}));
    if (k.hasKey) s.textContent = '已配置：密钥已加密保存，' + (k.verified ? '核对通过 ✓' : '待核对');
    else if (me.isAdmin) s.textContent = '未配置个人Key。管理员可直接使用平台Key——普通用户需配置个人Key。';
    else s.textContent = '未配置。平台Key暂仅管理员可用（付费功能上线后开放借用），请配置你自己的Key。';
  } catch (e) { const s = $('#keyStatus'); s.className = 'msg err'; s.textContent = e.message; }
}
$('#keyBtn').addEventListener('click', async () => { $('#keyModal').classList.remove('hidden'); $('#keyInput').value = ''; await loadKeyStatus(); });
$('#keyClose').addEventListener('click', () => $('#keyModal').classList.add('hidden'));
$('#keySave').addEventListener('click', async () => {
  const key = $('#keyInput').value.trim();
  const s = $('#keyStatus'); s.className = 'msg';
  if (!key) { s.className = 'msg err'; s.textContent = '请输入API Key'; return; }
  s.textContent = '本地核对中（格式＋连通性验证）…';
  try {
    const d = await api.req('/api/apikey', { method: 'PUT', body: JSON.stringify({ key }) });
    s.className = 'msg ok'; s.textContent = d.message + '（密钥已加密保存，不显示明文/掩码）';
    $('#keyBtn').textContent = '🔑 API Key';
    refreshUser();
  } catch (e) { s.className = 'msg err'; s.textContent = e.message; }
});
$('#keyDelete').addEventListener('click', async () => {
  try { await api.req('/api/apikey', { method: 'DELETE' }); $('#keyBtn').textContent = '🔑 API Key'; const s = $('#keyStatus'); s.className = 'msg ok'; s.textContent = '已删除，AI功能恢复为平台Key规则'; refreshUser(); }
  catch (e) { const s = $('#keyStatus'); s.className = 'msg err'; s.textContent = e.message; }
});

// ============================================================
// 记录
// ============================================================
async function loadRecords() {
  const box = $('#resultBox');
  if (!api.token) { box.innerHTML = '<div class="empty">登录后查看记录</div>'; return; }
  try {
    const q = ($('#recSearch')?.value || '').trim();
    const rows = await api.req('/api/records' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!rows.length) { setResultHTML('<div class="empty">暂无记录</div>', '完成'); return; }
    let html = '<table class="records-table"><thead><tr><th>ID</th><th>类型</th><th>标题</th><th>输入字数</th><th>时间</th><th>操作</th></tr></thead><tbody>';
    html += rows.map((r) => `<tr>
      <td>#${r.id}</td><td><span class="tag">${esc(r.type)}</span></td>
      <td>${esc(r.title)}</td><td>${r.input_len}</td><td>${esc(r.created_at)}</td>
      <td><button class="btn small" onclick="viewRecord(${r.id})">查看</button>
      <button class="btn small ghost" onclick="delRecord(${r.id})">删除</button></td></tr>`).join('');
    html += '</tbody></table>';
    setResultHTML(html, `共 ${rows.length} 条`);
  } catch (e) { setResultHTML('<div style="color:#c94f4f">' + esc(e.message) + '</div>', '失败'); }
}
window.viewRecord = async (id) => {
  try { const r = await api.req('/api/records/' + id); lastResult = r.output; setResult(r.output); switchFn('records'); } catch (e) { alert(e.message); }
};
window.delRecord = async (id) => {
  if (!confirm('删除记录 #' + id + '？')) return;
  try { await api.req('/api/records/' + id, { method: 'DELETE' }); loadRecords(); } catch (e) { alert(e.message); }
};

// ============================================================
// 写作四视图（V1.4 本地优先）：M9 选题 / M10 大纲 / M11 编写 / M12 进度
// 论文数据全部存本浏览器 IndexedDB（按账号分库），服务器不保存任何论文内容
// ============================================================
let topicLocal = null;                 // {topics, history:[{role,content}], form} 本地会话
let generatedOutline = null;
const writingState = { tree: [], currentId: null, dirty: false, saveTimer: null };
let outlineTree = [];
let outlineFlat = [];

// ---------- 通用小工具 ----------
function writeGuard() { if (!api.token || !api.userId) { showModal('login'); return false; } return true; }
const L = () => DingaoLocal;
const findNode = (list, id) => DingaoLocal.findNode(list, id);
const findParent = (list, id, parent) => DingaoLocal.findParent(list, id, parent);
async function newChapterId() {
  const t = await L().getThesis(api.userId);
  t.seq = (Number(t.seq) || 0) + 1;
  await L().saveThesis(api.userId, t);
  return t.seq;
}
function downloadText(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(name, blob);
}
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function loadLocalThesis() {
  const t = await L().getThesis(api.userId);
  outlineFlat = await L().getChapters(api.userId);
  outlineTree = DingaoLocal.buildTree(outlineFlat);
  return t;
}

// ---------- M9 选题助手（会话存本浏览器） ----------
async function renderTopic() {
  $('#tpList').innerHTML = '';
  $('#tpAskWrap').classList.add('hidden');
  $('#tpHistory').innerHTML = '';
  $('#tpStatus').textContent = '选题仅基于你提供的信息推断，由AI生成、需人工核验；采纳后自动生成标准章节结构。会话与论文数据仅存本浏览器。';
  if (!api.token || !api.userId) return;
  topicLocal = (await L().getTopicSession(api.userId)) || null;
  if (topicLocal && Array.isArray(topicLocal.topics) && topicLocal.topics.length) {
    renderTopicCards(topicLocal.topics);
    $('#tpAskWrap').classList.remove('hidden');
    $('#tpHistory').innerHTML = (topicLocal.history || []).slice(2)
      .map((m) => `<div class="tp-msg ${m.role === 'user' ? 'me' : 'ai'}">${m.role === 'user' ? '我' : 'AI'}：${esc(String(m.content).slice(0, 120))}</div>`).join('');
    $('#tpStatus').textContent = `已恢复上次选题会话（${topicLocal.topics.length} 个选题）· 由AI生成，需人工核验`;
  }
}
$('#tpGenBtn').addEventListener('click', async () => {
  const problem = $('#tpProblem').value.trim();
  if (!problem) { $('#tpStatus').textContent = '⚠️ 请填写实际工程问题'; return; }
  if (!writeGuard()) return;
  $('#tpStatus').textContent = 'AI 思考中（约 20-60 秒，输入仅内存中转、服务端不存储）…';
  $('#tpGenBtn').disabled = true;
  try {
    const form = {
      problem,
      literatures: $('#tpLits').value.split(/\n\s*\n/).filter(Boolean),
      discipline: $('#tpDiscipline').value.trim(),
      interests: $('#tpInterests').value.trim(),
      count: Number($('#tpCount').value),
    };
    const d = await api.req('/api/topics/suggest', { method: 'POST', body: JSON.stringify({ form }) });
    topicLocal = { topics: d.topics, history: [{ role: 'user', content: problem }, { role: 'assistant', content: '已生成 ' + d.topics.length + ' 个选题' }], form };
    await L().saveTopicSession(api.userId, topicLocal);
    renderTopicCards(d.topics);
    $('#tpAskWrap').classList.remove('hidden');
    $('#tpStatus').textContent = `✅ 已生成 ${d.topics.length} 个选题（${d.model}）· 由AI生成，需人工核验`;
  } catch (e) { $('#tpStatus').textContent = '❌ ' + e.message; }
  finally { $('#tpGenBtn').disabled = false; }
});
function renderTopicCards(topics) {
  $('#tpList').innerHTML = topics.map((t) => `
    <div class="topic-card">
      <div class="tc-head"><b>${esc(t.title)}</b><button class="btn primary small" data-adopt="${t.index}">✅ 采纳</button></div>
      <div class="tc-row"><span class="tc-label">核心研究问题</span>${esc(t.research_question || '—')}</div>
      <div class="tc-row"><span class="tc-label">创新点</span><span>${(t.innovation_points || []).map((x) => `<span class="tag">${esc(x)}</span>`).join(' ')}</span></div>
      <div class="tc-row"><span class="tc-label">与文献关系</span>${esc(t.relation_to_literature || '—')}</div>
      <div class="tc-row"><span class="tc-label">可行性</span>${t.feasibility ? `数据：${esc(t.feasibility.data_availability || '—')} · 方法：${esc(t.feasibility.method_maturity || '—')} · 周期：${esc(t.feasibility.time_estimate || '—')}` : '—'}</div>
      <div class="tc-row"><span class="tc-label">推荐理由</span><span>${(t.reasons || []).map((x) => `· ${esc(x)}`).join('<br>')}</span></div>
      <div class="tc-foot"><button class="btn ghost small" data-ask="${t.index}">💬 就此追问</button></div>
    </div>`).join('');
  document.querySelectorAll('#tpList [data-adopt]').forEach((b) => b.addEventListener('click', () => adoptTopic(b.dataset.adopt)));
  document.querySelectorAll('#tpList [data-ask]').forEach((b) => b.addEventListener('click', () => {
    const t = (topicLocal && topicLocal.topics || []).find((x) => String(x.index) === b.dataset.ask);
    $('#tpAsk').value = `关于「${t ? t.title : ''}」，我想了解：`;
    $('#tpAsk').focus();
  }));
}
async function adoptTopic(index) {
  if (!topicLocal || !topicLocal.topics.length) { alert('请先生成选题'); return; }
  const topic = topicLocal.topics.find((t) => String(t.index) === String(index));
  if (!topic) { alert('选题不存在，请重新生成'); return; }
  if (!confirm('采纳该选题？论文标题将设为该选题，并生成标准章节结构（当前本地章节将被替换）')) return;
  try {
    const t = await L().getThesis(api.userId);
    t.title = String(topic.title).slice(0, 100);
    t.topic = t.title;
    await L().saveThesis(api.userId, t);
    const chapters = DingaoLocal.standardChapters();
    for (const c of chapters) c.id = await newChapterId();
    await L().saveChapters(api.userId, chapters);
    alert(`✅ 已采纳选题，并生成 ${chapters.length} 个标准章节（仅存本浏览器）。可在「大纲」与「本地编写」中继续。`);
    switchFn('outline');
  } catch (e) { alert(e.message); }
}
async function topicAsk() {
  const q = $('#tpAsk').value.trim();
  if (!q) return;
  if (!topicLocal) { alert('请先生成选题'); return; }
  try {
    $('#tpAskBtn').disabled = true;
    $('#tpAskBtn').textContent = '思考中…';
    const history = (topicLocal.history || []).concat([{ role: 'user', content: q }]);
    const d = await api.req('/api/topics/iterate', { method: 'POST', body: JSON.stringify({ history, question: q }) });
    topicLocal.topics = d.topics;
    topicLocal.history = history.concat([{ role: 'assistant', content: '已更新 ' + d.topics.length + ' 个选题建议' }]);
    await L().saveTopicSession(api.userId, topicLocal);
    renderTopicCards(d.topics);
    $('#tpHistory').insertAdjacentHTML('beforeend',
      `<div class="tp-msg me">我：${esc(q)}</div><div class="tp-msg ai">AI：已更新 ${d.topics.length} 个选题建议（${d.model}）</div>`);
    $('#tpAsk').value = '';
    $('#tpHistory').scrollTop = $('#tpHistory').scrollHeight;
  } catch (e) { alert(e.message); }
  finally { $('#tpAskBtn').disabled = false; $('#tpAskBtn').textContent = '追问'; }
}
$('#tpAskBtn').addEventListener('click', topicAsk);
$('#tpAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter') topicAsk(); });

// ---------- M10 大纲（树存本浏览器，AI生成走纯中转） ----------
async function renderOutline() {
  if (!writeGuard()) return;
  try {
    const t = await loadLocalThesis();
    $('#olThesisTitle').textContent = `论文：${t.title}`;
    $('#olGenTitle').value = (t.topic && t.topic !== t.title) ? t.topic : (t.title !== '我的论文' ? t.title : '');
    $('#olApplyGen').classList.add('hidden');
    renderOlTree();
  } catch (e) { $('#olStatus').textContent = '❌ ' + e.message; }
}
function renderOlTree() {
  const box = $('#olTree');
  let html = '';
  const walk = (list, depth) => {
    for (const c of list) {
      html += `<div class="ol-node" style="margin-left:${depth * 24}px">
        <span class="ol-dot">${depth === 0 ? '▣' : '└'}</span>
        <span class="ol-title" data-id="${c.id}">${esc(c.title)}</span>
        <span class="ol-ops">
          <button class="btn ghost small" data-op="add" data-id="${c.id}" title="添加子节">＋子节</button>
          <button class="btn ghost small" data-op="up" data-id="${c.id}" title="上移">↑</button>
          <button class="btn ghost small" data-op="down" data-id="${c.id}" title="下移">↓</button>
          <button class="btn ghost small" data-op="promote" data-id="${c.id}" ${depth === 0 ? 'disabled' : ''} title="提升层级">⬅提级</button>
          <button class="btn ghost small" data-op="demote" data-id="${c.id}" title="降为上一项子节">降级➡</button>
          <button class="btn ghost small danger" data-op="del" data-id="${c.id}" title="删除（含子节）">✕</button>
        </span></div>`;
      walk(c.children || [], depth + 1);
    }
  };
  walk(outlineTree, 0);
  box.innerHTML = html || '<div class="empty">暂无大纲，可采纳选题或点击「AI 生成大纲」</div>';
  box.querySelectorAll('.ol-title').forEach((el) => {
    el.addEventListener('dblclick', () => { el.contentEditable = 'true'; el.focus(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('blur', async () => {
      el.contentEditable = 'false';
      const node = findNode(outlineTree, Number(el.dataset.id));
      const v = el.textContent.trim();
      if (node && v && node.title !== v) { node.title = v; await saveOutline(); }
    });
  });
  box.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', () => olOp(b.dataset.op, Number(b.dataset.id))));
}
async function olOp(op, id) {
  const node = findNode(outlineTree, id);
  if (!node) return;
  const parent = findParent(outlineTree, id, null);
  const list = parent ? parent.children : outlineTree;
  const idx = list.indexOf(node);
  if (op === 'add') {
    const title = prompt('新子节标题：');
    if (!title) return;
    node.children = node.children || [];
    node.children.push({ id: await newChapterId(), parent_id: node.id, title: title.trim().slice(0, 100), content: '', status: 'todo', children: [] });
    await saveOutline();
  } else if (op === 'del') {
    if (!confirm(`删除「${node.title}」及其所有子节？`)) return;
    list.splice(idx, 1);
    await saveOutline();
  } else if (op === 'up' && idx > 0) { list.splice(idx, 1); list.splice(idx - 1, 0, node); await saveOutline(); }
  else if (op === 'down' && idx < list.length - 1) { list.splice(idx, 1); list.splice(idx + 1, 0, node); await saveOutline(); }
  else if (op === 'promote' && parent) {
    const grand = findParent(outlineTree, parent.id, null);
    const glist = grand ? grand.children : outlineTree;
    const gidx = glist.indexOf(parent);
    list.splice(idx, 1);
    glist.splice(gidx + 1, 0, node);
    await saveOutline();
  } else if (op === 'demote' && idx > 0) {
    const prev = list[idx - 1];
    prev.children = prev.children || [];
    list.splice(idx, 1);
    prev.children.push(node);
    await saveOutline();
  }
}
async function saveOutline() {
  try {
    outlineFlat = DingaoLocal.flattenTree(outlineTree);
    let s = 0;
    for (const c of outlineFlat) c.sort = s++;
    await L().saveChapters(api.userId, outlineFlat);
    renderOlTree();
    $('#olSaveState').textContent = '✅ 已保存到本浏览器 ' + new Date().toLocaleTimeString();
  } catch (e) { $('#olSaveState').textContent = '⚠️ ' + e.message; }
}
$('#olAddCh').addEventListener('click', async () => {
  const title = prompt('新章标题：');
  if (!title) return;
  outlineTree.push({ id: await newChapterId(), parent_id: 0, title: title.trim().slice(0, 100), content: '', status: 'todo', children: [] });
  await saveOutline();
});
$('#olGenBtn').addEventListener('click', async () => {
  const title = $('#olGenTitle').value.trim();
  if (!title) { $('#olStatus').textContent = '⚠️ 请填写选题/论文标题'; return; }
  if (!writeGuard()) return;
  $('#olStatus').textContent = 'AI 生成中（约 20-60 秒，输入仅内存中转、服务端不存储）…';
  $('#olGenBtn').disabled = true;
  try {
    const d = await api.req('/api/outline/generate', { method: 'POST', body: JSON.stringify({ title, extra: $('#olGenExtra').value.trim() }) });
    generatedOutline = d.chapters;
    $('#olApplyGen').classList.remove('hidden');
    $('#olStatus').textContent = `✅ 已生成 ${d.chapters.length} 章大纲（${d.model}）· 点击「应用生成的大纲」写入本浏览器（将替换当前大纲）`;
  } catch (e) { $('#olStatus').textContent = '❌ ' + e.message; }
  finally { $('#olGenBtn').disabled = false; }
});
$('#olApplyGen').addEventListener('click', async () => {
  if (!generatedOutline) return;
  if (!confirm('应用生成的大纲？将替换当前大纲（本浏览器中的章节正文将被清空重建）')) return;
  try {
    const flat = [];
    for (const ch of generatedOutline) {
      const cid = await newChapterId();
      flat.push({ id: cid, parent_id: 0, title: String(ch.title || '').slice(0, 100), content: '', status: 'todo', sort: 0 });
      for (const s of (Array.isArray(ch.sections) ? ch.sections : [])) {
        flat.push({ id: await newChapterId(), parent_id: cid, title: String(s).slice(0, 100), content: '', status: 'todo', sort: 0 });
      }
    }
    let s = 0;
    for (const c of flat) c.sort = s++;
    await L().saveChapters(api.userId, flat);
    outlineFlat = flat;
    outlineTree = DingaoLocal.buildTree(flat);
    renderOlTree();
    $('#olApplyGen').classList.add('hidden');
    generatedOutline = null;
    $('#olStatus').textContent = '✅ 大纲已应用（仅存本浏览器），可双击标题继续编辑';
  } catch (e) { alert(e.message); }
});
async function olExport(fmt) {
  try {
    const title = $('#olThesisTitle').textContent.replace('论文：', '');
    if (fmt === 'txt') {
      downloadText(title + '-大纲.txt', DingaoLocal.outlineToTxt(title, outlineTree));
    } else {
      const doc = DingaoLocal.buildOutlineDocx(title, outlineTree);
      const blob = await DingaoLocal.docxToBlob(doc);
      downloadBlob(title + '-大纲.docx', blob);
    }
  } catch (e) { alert(e.message); }
}
$('#olExportTxt').addEventListener('click', () => olExport('txt'));
$('#olExportDocx').addEventListener('click', () => olExport('docx'));

// ---------- M11 本地编写（自动保存到本浏览器 IndexedDB + Word备份） ----------
async function renderWriting() {
  if (!writeGuard()) return;
  try {
    await loadLocalThesis();
    writingState.tree = outlineTree;
    renderChList();
    if (!writingState.currentId || !findNode(writingState.tree, writingState.currentId)) {
      const first = writingState.tree[0];
      if (first) selectChapter(first.id);
    }
    updateBackupWarn();
  } catch (e) { $('#chSaveState').textContent = '❌ ' + e.message; }
}
function renderChList() {
  const box = $('#chList');
  let html = '';
  const walk = (list, depth) => {
    for (const c of list) {
      const st = c.status === 'done' ? '✅' : c.status === 'writing' ? '✍️' : '⬜';
      const w = (c.content || '').length;
      html += `<div class="ch-item ${writingState.currentId === c.id ? 'active' : ''}" data-id="${c.id}" style="padding-left:${10 + depth * 14}px">${st} <span class="ch-t">${esc(c.title)}</span><span class="ch-w">${w}</span></div>`;
      walk(c.children || [], depth + 1);
    }
  };
  walk(writingState.tree, 0);
  box.innerHTML = html || '<div class="empty">暂无章节，请先到「大纲」页创建</div>';
  box.querySelectorAll('.ch-item').forEach((el) => el.addEventListener('click', () => selectChapter(Number(el.dataset.id))));
}
async function selectChapter(id) {
  await flushSave();
  writingState.currentId = id;
  const c = findNode(writingState.tree, id);
  if (!c) { $('#chSaveState').textContent = '⚠️ 章节不存在'; return; }
  $('#chTitle').textContent = c.title;
  $('#chEditor').value = c.content || '';
  $('#chStatus').value = c.status;
  $('#chCharCount').textContent = (c.content || '').length + ' 字';
  $('#chSaveState').textContent = '已载入（本浏览器本地）';
  writingState.dirty = false;
  renderChList();
}
async function flushSave() { if (writingState.dirty) await saveChapter(); }
async function saveChapter() {
  clearTimeout(writingState.saveTimer);
  if (!writingState.dirty || !writingState.currentId) return;
  try {
    const c = findNode(writingState.tree, writingState.currentId);
    if (!c) return;
    c.content = $('#chEditor').value;
    c.status = $('#chStatus').value;
    await L().saveChapter(api.userId, { id: c.id, parent_id: c.parent_id, title: c.title, content: c.content, status: c.status, sort: c.sort });
    writingState.dirty = false;
    $('#chSaveState').textContent = `✅ 已保存到本浏览器 ${new Date().toLocaleTimeString()}（${DingaoLocal.wordCount(c.content)} 字）`;
  } catch (e) { $('#chSaveState').textContent = '⚠️ 保存失败：' + e.message; }
}
$('#chEditor').addEventListener('input', () => {
  $('#chCharCount').textContent = $('#chEditor').value.length + ' 字';
  writingState.dirty = true;
  $('#chSaveState').textContent = '编辑中…';
  clearTimeout(writingState.saveTimer);
  writingState.saveTimer = setTimeout(saveChapter, 900);   // 自动保存（防抖，写入本浏览器 IndexedDB）
});
$('#chEditor').addEventListener('blur', saveChapter);
$('#chStatus').addEventListener('change', () => { writingState.dirty = true; saveChapter(); });
$('#chAdd').addEventListener('click', async () => {
  const title = prompt('新章节标题：');
  if (!title) return;
  try {
    const c = { id: await newChapterId(), parent_id: 0, title: title.trim().slice(0, 100), content: '', status: 'todo', sort: 9999 };
    outlineFlat.push(c);
    await L().saveChapters(api.userId, outlineFlat);
    writingState.tree = DingaoLocal.buildTree(outlineFlat);
    renderChList();
  } catch (e) { alert(e.message); }
});
async function thesisExport(fmt) {
  if (!writeGuard()) return;
  try {
    await flushSave();
    const t = await L().getThesis(api.userId);
    if (fmt === 'txt') {
      downloadText(t.title + '.txt', DingaoLocal.thesisToTxt(t.title, writingState.tree));
    } else {
      const doc = DingaoLocal.buildThesisDocx(t.title, writingState.tree);
      const blob = await DingaoLocal.docxToBlob(doc);
      downloadBlob(t.title + '.docx', blob);
    }
    localStorage.setItem('dg_last_export', String(Date.now()));
    updateBackupWarn();
    $('#chSaveState').textContent = `✅ 已导出 ${fmt.toUpperCase()} 备份（本机生成，未经过服务器）`;
  } catch (e) { alert(e.message); }
}
function updateBackupWarn() {
  const t = Number(localStorage.getItem('dg_last_export'));
  $('#chBackupWarn').classList.toggle('hidden', !!(t && Date.now() - t < 7 * 86400e3));
}
$('#chExportDocx').addEventListener('click', () => thesisExport('docx'));
$('#chExportTxt').addEventListener('click', () => thesisExport('txt'));

// ---------- M12 进度打卡（本地统计·零AI成本·零上传） ----------
async function renderProgress() {
  if (!writeGuard()) return;
  try {
    const t = await L().getThesis(api.userId);
    const flat = await L().getChapters(api.userId);
    const p = DingaoLocal.computeProgress(DingaoLocal.buildTree(flat), t.target_words);
    const ck = await L().getCheckins(api.userId);
    const streak = DingaoLocal.calcStreak(ck);
    $('#pgThesis').textContent = `《${t.title}》`;
    $('#pgBar').style.width = p.percent + '%';
    $('#pgStats').innerHTML = `
      <span class="stat-chip">总字数 <b>${p.total_words}</b></span>
      <span class="stat-chip">目标 <b>${p.target_words}</b></span>
      <span class="stat-chip">完成度 <b>${p.percent}%</b></span>
      <span class="stat-chip">章节 <b>${p.chapter_count}</b></span>
      <span class="stat-chip">🔒 本地统计·不上传</span>`;
    $('#pgTarget').value = t.target_words;
    const stTxt = { todo: '未开始', writing: '写作中', done: '已完成' };
    $('#pgChapterTable').innerHTML = '<tr><th>章节</th><th>字数</th><th>状态</th></tr>' +
      p.chapters.map((x) => `<tr><td style="padding-left:${x.parent_id ? 26 : 10}px">${esc(x.title)}</td><td>${x.words}</td><td>${stTxt[x.status] || x.status}</td></tr>`).join('');
    $('#pgStreak').textContent = `🔥 连续打卡 ${streak} 天`;
    $('#pgCheckinTable').innerHTML = '<tr><th>日期</th><th>当日字数</th><th>累计字数</th><th>备注</th></tr>' +
      (ck.length ? ck.map((x) => `<tr><td>${esc(x.date)}</td><td>+${x.word_delta}</td><td>${x.total_words}</td><td>${esc(x.note || '')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">还没有打卡记录，写下第一笔吧 ✍️</td></tr>');
  } catch (e) { $('#pgStats').innerHTML = '<span class="stat-chip">❌ ' + esc(e.message) + '</span>'; }
}
$('#pgTargetBtn').addEventListener('click', async () => {
  try {
    const t = await L().getThesis(api.userId);
    t.target_words = Math.min(Math.max(Number($('#pgTarget').value) || 30000, 1000), 1000000);
    await L().saveThesis(api.userId, t);
    alert('目标已设为 ' + t.target_words + ' 字（仅存本浏览器）');
    renderProgress();
  } catch (e) { alert(e.message); }
});
$('#pgCheckinBtn').addEventListener('click', async () => {
  try {
    const t = await L().getThesis(api.userId);
    const flat = await L().getChapters(api.userId);
    const p = DingaoLocal.computeProgress(DingaoLocal.buildTree(flat), t.target_words);
    const cur = await L().getCheckins(api.userId);
    const r = DingaoLocal.addCheckin(cur, p.total_words, $('#pgNote').value);
    await L().saveCheckins(api.userId, r.checkins);
    alert(`✅ ${r.checkin.date} 打卡成功：今日已写 ${r.checkin.word_delta} 字（仅存本浏览器）`);
    $('#pgNote').value = '';
    renderProgress();
  } catch (e) { alert(e.message); }
});

// ============================================================
// 事件绑定 & 初始化
// ============================================================
$('#loginBtn').addEventListener('click', () => showModal('login'));
$('#logoutBtn').addEventListener('click', logout);
$('#modalClose').addEventListener('click', hideModal);
$('#authToggle').addEventListener('click', () => showModal(authMode === 'login' ? 'register' : 'login'));
$('#authSubmit').addEventListener('click', authSubmit);
$('#authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') authSubmit(); });

async function checkHealth() {
  try {
    const h = await api.req('/api/health');
    const pill = $('#aiStatus');
    if (h.hasKey) { pill.className = 'pill pill-ok'; pill.textContent = '● AI 服务在线（v' + h.version + '）'; }
    else { pill.className = 'pill pill-warn'; pill.textContent = '● 平台Key未配置'; }
    // 访问地址动态显示：本机 + 局域网（IP 变化也不迷路）
    const urls = [h.local, ...(h.lanUrls || [])].join('　·　');
    $('#accessInfo').textContent = '访问地址：' + urls;
    $('#authAccess').textContent = '其他电脑访问地址：' + (h.lanUrls || []).join('　·　') + '（需防火墙放行）';
  } catch {
    const pill = $('#aiStatus');
    pill.className = 'pill pill-err';
    pill.textContent = '● 服务未连接';
    $('#accessInfo').textContent = '⚠️ 服务未连接——请在主机上运行「启动定稿AI.bat」';
  }
}

switchFn('topic');
setResult('');
refreshUser();
loadRecords();
checkHealth();
