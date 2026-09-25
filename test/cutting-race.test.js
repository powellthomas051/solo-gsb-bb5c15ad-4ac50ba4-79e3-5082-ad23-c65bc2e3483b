'use strict';

// 批量裁切下料「输入变更竞态」前端回归测试：
// 用最小 DOM 桩加载真实的 public/app.js，模拟
//   350×250 mm 原纸 + 所需 1 张发起计算 → 响应返回前改为 300×200 mm / 数量 2
// 校验在途响应失效、已展示方案标记过期并暂停下载、仅当前输入重算成功才恢复，
// 以及旧请求的成功/失败/收尾更新均不覆盖新状态；换稿与重复计算只认最新请求。
// 仅使用 Node 内置模块（vm/assert），不引入新依赖。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); process.exit(1); });

// ---------- 最小 DOM 桩 ----------

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { cs.forEach((c) => this.set.add(c)); }
  remove(...cs) { cs.forEach((c) => this.set.delete(c)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : Boolean(force);
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

class FakeText {
  constructor(text) { this.textContent = String(text); this.parentNode = null; }
  _walk(out) { return out; }
  _matches() { return false; }
}

function toNode(kid) {
  return kid instanceof FakeElement || kid instanceof FakeText ? kid : new FakeText(kid);
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.textContent = '';
    this._className = '';
    this._innerHTML = '';
  }

  set className(v) {
    this._className = String(v);
    this.classList = new FakeClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  get className() { return this._className; }

  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type, evt = {}) {
    (this.listeners[type] || []).slice().forEach((fn) => fn(evt));
  }
  click() { this.dispatch('click', { preventDefault() {} }); }

  appendChild(child) {
    const node = toNode(child);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...kids) { kids.forEach((k) => this.appendChild(k)); }
  prepend(child) {
    const node = toNode(child);
    node.parentNode = this;
    this.children.unshift(node);
    return node;
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }

  _walk(out) {
    for (const c of this.children) { out.push(c); c._walk(out); }
    return out;
  }
  _matches(sel) {
    let tag = null;
    let cls = null;
    const dot = sel.indexOf('.');
    if (dot === 0) cls = sel.slice(1);
    else if (dot > 0) { tag = sel.slice(0, dot); cls = sel.slice(dot + 1); }
    else tag = sel;
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    if (cls && !this.classList.contains(cls)) return false;
    return true;
  }
  querySelectorAll(sel) { return this._walk([]).filter((el) => el._matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const elementsById = new Map();
const documentStub = {
  activeElement: null,
  body: new FakeElement('body'),
  getElementById(id) {
    if (!elementsById.has(id)) elementsById.set(id, new FakeElement('div'));
    return elementsById.get(id);
  },
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => new FakeElement(tag),
  createDocumentFragment: () => new FakeElement('fragment'),
  querySelectorAll: () => [],
};

const localStorageStub = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

class FormDataStub {
  constructor() { this.data = {}; }
  append(k, v) { this.data[k] = v; }
}
class BlobStub {
  constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; }
}

// ---------- 可控制的 fetch 桩 ----------

const plan = {
  signatureMode: false,
  sheets: [{
    sheet: 1,
    front: { left: { blank: false, page: 4 }, right: { blank: false, page: 1 } },
    back: { left: { blank: false, page: 2 }, right: { blank: false, page: 3 } },
  }],
  sourceCount: 4, paddedCount: 0, blanks: 0,
  panel: { width: 595.3, height: 841.9, orientation: 'portrait' },
  sheet: { width: 1190.6, height: 841.9 },
  marks: { enabled: false, marginMm: 0 },
  creep: { enabled: false, paperThicknessMm: 0 },
};

const quoteResp = {
  feasible: false,
  reason: '维护的纸张均无法容纳版面。',
  selected: null,
  layout: {
    signatureMode: false, signatureCount: null, sheetCount: 1, runCount: 1,
    panel: { widthMm: 210, heightMm: 297 },
    sheet: { widthMm: 420, heightMm: 297 },
  },
  options: [],
};

function makeCuttingResp(paper, requiredSheets) {
  return {
    feasible: true,
    layout: { sheet: { widthMm: 420, heightMm: 297 } },
    requiredSheets,
    recommended: { index: 0 },
    options: [{
      index: 0, name: paper.name, feasible: true,
      paper: { widthMm: paper.widthMm, heightMm: paper.heightMm },
      yieldsPerSheet: 1, sheetsRequired: requiredSheets,
      utilizationPercent: 100,
      placement: {
        rotated: false, rotatedItemCount: 0,
        frameWidthMm: paper.widthMm, frameHeightMm: paper.heightMm,
        paperWidthUsedMm: paper.widthMm, paperHeightUsedMm: paper.heightMm,
      },
      cutting: {
        cutCount: 0, cuts: [],
        items: [{ xMm: 0, yMm: 0, widthMm: 420, heightMm: 297, rotated: false }],
        item: { widthMm: 420, heightMm: 297 },
        wasteRegions: [],
      },
      lastSheet: { isLastSheetPartial: false, fullSheets: requiredSheets, lastSheetYield: 1, spareCapacity: 0 },
      waste: { perSheetAreaMm2: 0, totalAreaMm2: 0 },
    }],
  };
}

const cuttingCalls = []; // 每个在途 /api/cutting 请求：{ body, resolve, reject }

function jsonResp(data) {
  return { ok: true, status: 200, json: async () => data, headers: { get: () => null } };
}

function fetchStub(url, opts) {
  if (url === '/api/impose') {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'X-Imposition-Plan' ? encodeURIComponent(JSON.stringify(plan)) : null) },
      blob: async () => new BlobStub(['pdf'], { type: 'application/pdf' }),
    });
  }
  if (url === '/api/quote') return Promise.resolve(jsonResp(quoteResp));
  if (url === '/api/cutting') {
    const body = JSON.parse(opts.body);
    return new Promise((resolve, reject) => cuttingCalls.push({ body, resolve, reject }));
  }
  return Promise.reject(new Error(`未预期的 fetch：${url}`));
}

// ---------- 加载真实 app.js ----------

const sandbox = {
  document: documentStub,
  localStorage: localStorageStub,
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  fetch: fetchStub,
  FormData: FormDataStub,
  Blob: BlobStub,
  TextDecoder,
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(sandbox);
const appCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(appCode, sandbox, { filename: 'public/app.js' });

const el = (id) => documentStub.getElementById(id);
// 与 index.html 初始状态保持一致
el('cutting-required').value = '1';
el('cutting-download-btn').disabled = true;

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};
async function waitFor(cond, what) {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return;
    await flush(1);
  }
  throw new Error(`等待超时：${what}`);
}

function paperRows() { return el('paper-table-body').querySelectorAll('tr.paper-row'); }
function rowInputs(row) { return row.querySelectorAll('input'); }
function editInput(input, value) {
  input.value = value;
  input.dispatch('input', {});
}
function editPaperWidthHeight(rowIndex, width, height) {
  const inputs = rowInputs(paperRows()[rowIndex]);
  editInput(inputs[1], width);
  editInput(inputs[2], height);
}
function selectFile(name) {
  const input = el('file-input');
  input.files = [{ name, type: 'application/pdf', size: 2048 }];
  input.dispatch('change', {});
}
function staleBanner() { return el('cutting-result').querySelector('.cutting-stale-banner'); }

async function main() {
  // ---------- 0. 初始：维护 350×250 mm 原纸（任务示例），再选文件 ----------
  editPaperWidthHeight(0, '350', '250');
  selectFile('demo.pdf');
  await flush();
  assert.strictEqual(el('cutting-box').hidden, true, '选文件后裁切卡片仍隐藏');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '无方案时下载停用');

  // ---------- 1. 拼版成功 → 自动发起裁切计算（在途） ----------
  el('impose-btn').click();
  await waitFor(() => cuttingCalls.length === 1, '拼版后自动发起裁切计算');
  assert.strictEqual(cuttingCalls[0].body.papers[0].widthMm, 350, '首次计算用 350 mm 原纸');
  assert.strictEqual(cuttingCalls[0].body.papers[0].heightMm, 250, '首次计算用 250 mm 原纸');
  assert.strictEqual(cuttingCalls[0].body.requiredSheets, 1, '首次计算所需 1 张');
  assert.strictEqual(el('cutting-calc-btn').disabled, true, '计算在途时按钮停用');

  // ---------- 2. 响应返回前把原纸改为 300×200 mm：在途响应必须失效 ----------
  editPaperWidthHeight(0, '300', '200');
  assert.strictEqual(el('cutting-calc-btn').disabled, false, '输入变更后立即可重新计算');
  assert.ok(el('cutting-calc-btn').classList.contains('stale'), '计算按钮标记过期');
  assert.ok(el('cutting-status').textContent.includes('已过期'), '状态提示方案已过期');

  // 旧参数（350×250）的成功响应返回：不得回填刀线/边料/用纸量
  cuttingCalls[0].resolve(jsonResp(makeCuttingResp({ name: '旧纸', widthMm: 350, heightMm: 250 }, 1)));
  await flush();
  assert.strictEqual(el('cutting-result').hidden, true, '旧响应不得展示旧方案');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '旧响应不得恢复下载');
  assert.ok(el('cutting-status').textContent.includes('已过期'), '旧响应不得覆盖过期提示');
  assert.ok(!el('cutting-status').textContent.includes('推荐方案'), '旧响应不得写入推荐语');

  // ---------- 3. 按当前输入（300×200）重新计算成功：展示新方案并恢复下载 ----------
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 2, '重新计算发起新请求');
  assert.strictEqual(cuttingCalls[1].body.papers[0].widthMm, 300, '重算用 300 mm 原纸');
  assert.strictEqual(cuttingCalls[1].body.papers[0].heightMm, 200, '重算用 200 mm 原纸');
  cuttingCalls[1].resolve(jsonResp(makeCuttingResp({ name: '新纸', widthMm: 300, heightMm: 200 }, 1)));
  await flush();
  assert.strictEqual(el('cutting-result').hidden, false, '新计算成功后展示新方案');
  assert.strictEqual(el('cutting-download-btn').disabled, false, '新计算成功后恢复下载');
  assert.ok(!el('cutting-result').classList.contains('stale'), '新方案不带过期标记');
  assert.strictEqual(staleBanner(), null, '新方案无过期横幅');
  assert.ok(el('cutting-status').textContent.includes('推荐方案'), '状态写入新推荐语');

  // ---------- 4. 已展示方案时把数量改为 2：标明过期并暂停下载 ----------
  editInput(el('cutting-required'), '2');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '数量变更后下载暂停');
  assert.ok(el('cutting-result').classList.contains('stale'), '已展示方案标记过期');
  assert.ok(staleBanner(), '结果区出现过期横幅');
  assert.ok(el('cutting-status').textContent.includes('已过期'), '状态提示已过期');

  // ---------- 5. 重算在途时再次改数量（2→5）：旧请求失败也不覆盖新状态 ----------
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 3, '数量变更后重新计算');
  assert.strictEqual(cuttingCalls[2].body.requiredSheets, 2, '重算用数量 2');
  editInput(el('cutting-required'), '5');
  cuttingCalls[2].resolve({ ok: false, status: 500, json: async () => ({ error: '服务器错误' }), headers: { get: () => null } });
  await flush();
  assert.ok(el('cutting-status').textContent.includes('已过期'), '旧请求失败不覆盖过期提示');
  assert.ok(!el('cutting-status').textContent.includes('服务器错误'), '旧请求失败信息不回填');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '旧请求失败后下载仍暂停');
  assert.strictEqual(el('cutting-calc-btn').disabled, false, '旧请求收尾不误禁计算按钮');

  // ---------- 6. 重算在途时新增纸张：在途响应失效（增） ----------
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 4, '再次重新计算');
  el('paper-add-btn').click();
  assert.strictEqual(paperRows().length, 4, '新增一行纸张');
  assert.ok(el('cutting-status').textContent.includes('已过期'), '新增纸张使在途响应失效');
  cuttingCalls[3].resolve(jsonResp(makeCuttingResp({ name: '旧', widthMm: 300, heightMm: 200 }, 5)));
  await flush();
  assert.strictEqual(el('cutting-result').hidden, true, '新增纸张后旧响应不回填');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '新增纸张后下载仍暂停');

  // 补全新行规格后重算成功：4 种纸张全部参与
  const newRowInputs = rowInputs(paperRows()[3]);
  editInput(newRowInputs[1], '500');
  editInput(newRowInputs[2], '350');
  editInput(newRowInputs[3], '1.2');
  editInput(newRowInputs[4], '60');
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 5, '补全新纸张后重新计算');
  assert.strictEqual(cuttingCalls[4].body.papers.length, 4, '新计算含新增纸张');
  cuttingCalls[4].resolve(jsonResp(makeCuttingResp({ name: '新', widthMm: 300, heightMm: 200 }, 5)));
  await flush();
  assert.strictEqual(el('cutting-result').hidden, false, '重算成功展示新方案');
  assert.strictEqual(el('cutting-download-btn').disabled, false, '重算成功恢复下载');

  // ---------- 7. 删除纸张：已展示方案过期并暂停下载（删） ----------
  const firstRow = paperRows()[0];
  const delBtn = firstRow.children[firstRow.children.length - 1].children[0];
  delBtn.click();
  assert.strictEqual(paperRows().length, 3, '删除一行纸张');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '删除纸张后下载暂停');
  assert.ok(staleBanner(), '删除纸张后出现过期横幅');

  // ---------- 8. 恢复默认：已展示方案保持过期（重置） ----------
  el('paper-reset-btn').click();
  assert.strictEqual(paperRows().length, 3, '重置回到 3 种默认纸张');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '重置后下载仍暂停');
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 6, '重置后重新计算');
  assert.strictEqual(cuttingCalls[5].body.papers[0].widthMm, 420, '重置后按默认 420 mm 计算');
  cuttingCalls[5].resolve(jsonResp(makeCuttingResp({ name: '默认纸', widthMm: 420, heightMm: 297 }, 5)));
  await flush();
  assert.strictEqual(el('cutting-download-btn').disabled, false, '重置重算成功后恢复下载');

  // ---------- 9. 重复计算只认最新请求 ----------
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 7, '第一次重复计算');
  editInput(el('cutting-required'), '7'); // 使前一次在途失效并恢复按钮
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 8, '第二次重复计算');
  assert.strictEqual(cuttingCalls[6].body.requiredSheets, 5, '第一次重复计算用数量 5');
  assert.strictEqual(cuttingCalls[7].body.requiredSheets, 7, '第二次重复计算用数量 7');
  cuttingCalls[6].resolve(jsonResp(makeCuttingResp({ name: '先到旧响应', widthMm: 420, heightMm: 297 }, 5)));
  await flush();
  assert.strictEqual(el('cutting-result').hidden, true, '先返回的旧请求被丢弃');
  cuttingCalls[7].resolve(jsonResp(makeCuttingResp({ name: '最新响应', widthMm: 420, heightMm: 297 }, 7)));
  await flush();
  assert.strictEqual(el('cutting-result').hidden, false, '最新请求正常展示');
  assert.strictEqual(el('cutting-download-btn').disabled, false, '最新请求成功后恢复下载');

  // ---------- 10. 换稿：裁切卡片清空、下载停用、在途作废 ----------
  el('cutting-calc-btn').click();
  await waitFor(() => cuttingCalls.length === 9, '换稿前再发起一次计算');
  selectFile('other.pdf');
  await flush();
  assert.strictEqual(el('cutting-box').hidden, true, '换稿后裁切卡片隐藏');
  assert.strictEqual(el('cutting-download-btn').disabled, true, '换稿后下载停用');
  assert.strictEqual(el('cutting-calc-btn').disabled, false, '换稿后计算按钮复位');
  assert.strictEqual(el('cutting-required').value, '1', '换稿后数量回到默认 1');
  cuttingCalls[8].resolve(jsonResp(makeCuttingResp({ name: '换稿前旧响应', widthMm: 420, heightMm: 297 }, 7)));
  await flush();
  assert.strictEqual(el('cutting-box').hidden, true, '旧稿在途响应不回填');

  console.log('✅ 裁切输入变更竞态测试通过：纸张编辑/增删/重置与数量变更使在途响应失效，');
  console.log('   已展示方案标记过期并暂停下载，按当前输入重算成功才展示新方案并恢复下载；');
  console.log('   旧请求的成功、失败与收尾更新均不覆盖新状态，换稿与重复计算只认最新请求。');
}

main().catch((err) => {
  console.error('❌ 裁切输入变更竞态测试失败');
  console.error(err);
  process.exit(1);
});
