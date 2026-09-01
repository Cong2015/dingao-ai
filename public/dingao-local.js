// 定稿AI v0.4 — 本地优先核心库（论文数据仅存用户浏览器 IndexedDB）
// UMD 兼容：浏览器挂 window.DingaoLocal；node ESM 测试先 import 再读 globalThis.DingaoLocal
// 红线（V1.4）：论文全文/大纲/进度/打卡全部本地存储，服务器不保存任何论文内容
(function (root, factory) {
  const api = factory();
  root = root || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.DingaoLocal = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 纯函数（确定性：字数/日期/树/进度/打卡/导出文本） ----------
  function wordCount(t) {
    const s = String(t || '');
    const cjk = (s.match(/[一-鿿　-〿＀-￯]/g) || []).length;
    const latin = (s.replace(/[一-鿿　-〿＀-￯]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    return cjk + latin;
  }
  function localDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function buildTree(flat) {
    const byId = new Map();
    for (const r of flat) byId.set(r.id, { ...r, children: [] });
    const out = [];
    for (const r of flat) {
      if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(byId.get(r.id));
      else out.push(byId.get(r.id));
    }
    return out;
  }
  function flattenTree(tree, out = []) {
    for (const c of tree) { out.push({ id: c.id, parent_id: c.parent_id, title: c.title, content: c.content, status: c.status, sort: c.sort }); flattenTree(c.children || [], out); }
    return out;
  }
  function findNode(list, id) { for (const c of list) { if (c.id === id) return c; const r = findNode(c.children || [], id); if (r) return r; } return null; }
  function findParent(list, id, parent) { for (const c of list) { if (c.id === id) return parent; const r = findParent(c.children || [], id, c); if (r) return r; } return null; }
  // 注意：返回的 id=0 为占位符，调用方必须分配唯一 id（如 newChapterId），否则 buildTree 会因重复 id 折叠节点
  function standardChapters() {
    return ['第1章 绪论', '第2章 文献综述与理论基础', '第3章 研究方法', '第4章 案例研究与数据分析', '第5章 结论与展望']
      .map((title, i) => ({ id: 0, parent_id: 0, title, content: '', status: 'todo', sort: i }));
  }
  function computeProgress(tree, targetWords) {
    const chapters = [];
    const walk = (list, parentId) => { for (const c of list) { chapters.push({ id: c.id, parent_id: parentId, title: c.title, status: c.status, words: wordCount(c.content) }); walk(c.children || [], c.id); } };
    walk(tree, 0);
    const total = chapters.reduce((a, b) => a + b.words, 0);
    const target = Math.max(Number(targetWords) || 30000, 1000);
    return { total_words: total, target_words: target, percent: Math.min(100, Math.round((total / target) * 1000) / 10), chapters, chapter_count: chapters.length };
  }
  function addCheckin(checkins, totalWords, note) {
    const date = localDate();
    const prev = checkins.find((c) => c.date === date);
    const last = [...checkins].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const delta = Math.max(0, totalWords - (prev ? prev.total_words : last ? last.total_words : 0));
    const rec = { date, word_delta: delta, total_words: totalWords, note: String(note || '').slice(0, 200) };
    const next = checkins.filter((c) => c.date !== date).concat(rec).sort((a, b) => b.date.localeCompare(a.date));
    return { checkins: next, checkin: rec };
  }
  function calcStreak(checkins) {
    const days = new Set(checkins.map((c) => c.date));
    let streak = 0;
    const d = new Date();
    if (!days.has(localDate(d))) d.setDate(d.getDate() - 1);
    while (days.has(localDate(d))) { streak++; d.setDate(d.getDate() - 1); }
    return streak;
  }
  function thesisToTxt(title, tree) {
    let out = `${title}\n\n`;
    const walk = (list, depth) => { for (const c of list) { out += `${'#'.repeat(Math.min(depth + 1, 3))} ${c.title}\n${c.content || ''}\n\n`; walk(c.children || [], depth + 1); } };
    walk(tree, 0);
    return out;
  }
  function outlineToTxt(title, tree) {
    let out = `${title}——大纲\n\n`;
    const walk = (list, depth) => { for (const c of list) { out += `${'  '.repeat(depth)}${c.title}\n`; walk(c.children || [], depth + 1); } };
    walk(tree, 0);
    return out;
  }

  // ---------- docx 导出（浏览器用全局 docx；node 测试用 require） ----------
  function getDocx() {
    if (typeof docx !== 'undefined' && docx && docx.Document) return docx;
    if (typeof require !== 'undefined') { try { return require('docx'); } catch {} }
    return null;
  }
  function buildDocx(kids) {
    const D = getDocx();
    if (!D) throw new Error('docx 库未加载（请检查 vendor/docx.iife.js）');
    return new D.Document({ sections: [{ properties: { page: { size: { width: 11906, height: 16838 } } }, children: kids }] });
  }
  const FONT_ZH = { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' };
  const FONT_BODY = { ascii: 'Times New Roman', eastAsia: 'SimSun' };
  function buildThesisDocx(title, tree) {
    const D = getDocx();
    if (!D) throw new Error('docx 库未加载');
    const kids = [new D.Paragraph({ heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: title || '定稿AI论文', bold: true, size: 36, font: FONT_ZH })] })];
    const walk = (list, depth) => { for (const c of list) {
      kids.push(new D.Paragraph({ heading: depth === 0 ? D.HeadingLevel.HEADING_1 : D.HeadingLevel.HEADING_2, children: [new D.TextRun({ text: c.title, bold: true, size: depth === 0 ? 28 : 26, font: FONT_ZH })] }));
      if (c.content) for (const para of String(c.content).split(/\n+/)) if (para.trim()) kids.push(new D.Paragraph({ alignment: D.AlignmentType.JUSTIFIED, indent: { firstLine: 420 }, spacing: { line: 360 }, children: [new D.TextRun({ text: para.trim(), size: 24, font: FONT_BODY })] }));
      walk(c.children || [], depth + 1);
    } };
    walk(tree, 0);
    return buildDocx(kids);
  }
  function buildOutlineDocx(title, tree) {
    const D = getDocx();
    if (!D) throw new Error('docx 库未加载');
    const kids = [new D.Paragraph({ heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: (title || '') + '（大纲）', bold: true, size: 32, font: FONT_ZH })] })];
    const walk = (list, depth) => { for (const c of list) {
      kids.push(new D.Paragraph({ heading: depth === 0 ? D.HeadingLevel.HEADING_1 : D.HeadingLevel.HEADING_2, children: [new D.TextRun({ text: c.title, size: depth === 0 ? 28 : 26, font: FONT_ZH })] }));
      walk(c.children || [], depth + 1);
    } };
    walk(tree, 0);
    return buildDocx(kids);
  }
  function docxToBlob(doc, D) {
    const lib = D || getDocx();
    return lib.Packer.toBlob(doc);
  }

  // ---------- IndexedDB 封装（按账号分库：dingao_v04_<userId>，账号间天然隔离） ----------
  const idb = {
    _db: null,
    _dbName: '',
    open(userId) {
      const name = `dingao_v04_${userId}`;
      if (this._db && this._dbName === name) return Promise.resolve(this._db);
      if (this._db) this._db.close();
      this._dbName = name;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('thesis')) db.createObjectStore('thesis', { keyPath: 'k' });
          if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('checkins')) db.createObjectStore('checkins', { keyPath: 'date' });
          if (!db.objectStoreNames.contains('topics')) db.createObjectStore('topics', { keyPath: 'k' });
        };
        req.onsuccess = () => { this._db = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB 被占用，请关闭其他标签页后重试'));
      });
    },
    async tx(userId, store, mode) { await this.open(userId); return this._db.transaction(store, mode).objectStore(store); },
    async get(userId, store, key) { const o = await this.tx(userId, store, 'readonly'); return new Promise((res, rej) => { const r = o.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async all(userId, store) { const o = await this.tx(userId, store, 'readonly'); return new Promise((res, rej) => { const r = o.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); },
    async put(userId, store, val) { const o = await this.tx(userId, store, 'readwrite'); return new Promise((res, rej) => { const r = o.put(val); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
    async del(userId, store, key) { const o = await this.tx(userId, store, 'readwrite'); return new Promise((res, rej) => { const r = o.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
    async bulk(userId, store, list) {
      const o = await this.tx(userId, store, 'readwrite');
      return new Promise((res, rej) => {
        o.clear();
        for (const v of list) o.put(v);
        o.transaction.oncomplete = () => res();
        o.transaction.onerror = () => rej(o.transaction.error);
        o.transaction.onabort = () => rej(new Error('IndexedDB 写入中断'));
      });
    },
  };

  // ---------- 业务封装（每用户一份本地论文） ----------
  async function getThesis(userId) {
    return (await idb.get(userId, 'thesis', 'main')) || { k: 'main', title: '我的论文', topic: '', target_words: 30000, seq: 0 };
  }
  async function saveThesis(userId, t) { await idb.put(userId, 'thesis', { k: 'main', ...t }); }
  async function getChapters(userId) { return await idb.all(userId, 'chapters'); }
  async function saveChapters(userId, flat) { await idb.bulk(userId, 'chapters', flat); }
  async function getCheckins(userId) { return await idb.all(userId, 'checkins'); }
  async function saveCheckins(userId, list) { await idb.bulk(userId, 'checkins', list); }
  async function getTopicSession(userId) { return await idb.get(userId, 'topics', 'session'); }
  async function saveTopicSession(userId, s) { await idb.put(userId, 'topics', { k: 'session', ...s }); }

  return {
    wordCount, localDate, buildTree, flattenTree, findNode, findParent,
    standardChapters, computeProgress, addCheckin, calcStreak,
    thesisToTxt, outlineToTxt,
    buildThesisDocx, buildOutlineDocx, docxToBlob, getDocx,
    getThesis, saveThesis, getChapters, saveChapters, getCheckins, saveCheckins,
    getTopicSession, saveTopicSession,
  };
});
