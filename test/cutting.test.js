'use strict';

// 批量裁切下料纯函数测试：印张数校验、矩形分割搜索（对拍网格暴力解）、
// 贯通裁切树几何有效性、原纸方向枚举、尾张余量与废料、推荐排序与不可行原因。
const assert = require('assert');
const {
  PT_PER_MM,
  MAX_REQUIRED_SHEETS,
  MAX_ITEMS_PER_SHEET,
  FIT_EPSILON_MM,
  parseRequiredSheets,
  solveGuillotine,
  positionTree,
  buildCuttingPlan,
} = require('../lib/cutting');

const PANEL_A4 = { width: 595.2756, height: 841.8898, orientation: 'portrait' };
const planA4 = {
  sheets: [{ sheet: 1 }, { sheet: 2 }],
  sourceCount: 8, paddedCount: 0, totalCount: 8, blanks: 0,
  panel: PANEL_A4,
  sheet: { width: 595.2756 * 2, height: 841.8898 },
};
const P = (name, widthMm, heightMm) => ({
  name, widthMm, heightMm, pricePerSheet: 0, setupFee: 0,
});

// ---------- 1. 所需印张数校验 ----------

assert.strictEqual(parseRequiredSheets(1), 1);
assert.strictEqual(parseRequiredSheets(' 42 '), 42);
assert.strictEqual(parseRequiredSheets(MAX_REQUIRED_SHEETS), MAX_REQUIRED_SHEETS);
for (const bad of [0, -1, 1.5, 'abc', '', ' ', null, undefined, true, '1e3', 1.0001, MAX_REQUIRED_SHEETS + 1]) {
  assert.throws(() => parseRequiredSheets(bad), /所需印张数必须是/, `应拒绝 ${JSON.stringify(bad)}`);
}

// ---------- 2. 分割搜索：与整数网格暴力 guillotine 解对拍 ----------

function bruteGuillotine(W, H, a, b, memo) {
  const key = `${W}x${H}`;
  if (memo.has(key)) return memo.get(key);
  const fit1 = W >= a && H >= b;
  const fit2 = W >= b && H >= a;
  if (!fit1 && !fit2) { memo.set(key, 0); return 0; }
  let best = 1;
  for (const d of [a, b]) {
    for (let k = 1; k * d < W; k += 1) {
      if (k * d <= W / 2) {
        best = Math.max(best,
          bruteGuillotine(k * d, H, a, b, memo) + bruteGuillotine(W - k * d, H, a, b, memo));
      }
    }
    for (let k = 1; k * d < H; k += 1) {
      if (k * d <= H / 2) {
        best = Math.max(best,
          bruteGuillotine(W, k * d, a, b, memo) + bruteGuillotine(W, H - k * d, a, b, memo));
      }
    }
  }
  memo.set(key, best);
  return best;
}

for (let W = 1; W <= 18; W += 1) {
  for (let H = 1; H <= 18; H += 1) {
    for (let a = 2; a <= 7; a += 1) {
      for (let b = 2; b <= 7; b += 1) {
        const got = solveGuillotine(W, H, a, b, new Map(), { states: 0 });
        const ref = bruteGuillotine(W, H, a, b, new Map());
        assert.strictEqual(
          got.count, ref,
          `W=${W},H=${H},a=${a},b=${b} 搜索产出 ${got.count} ≠ 暴力解 ${ref}`,
        );
      }
    }
  }
}

// ---------- 3. 裁切树：叶节点铺满根矩形，坐标无重叠、不越界、切线贯通 ----------

function flattenLeaves(node, x = 0, y = 0, out = []) {
  if (node.kind === 'leaf') {
    out.push({ x, y, w: node.width, h: node.height, used: node.used, rotated: node.rotated });
    return out;
  }
  if (node.direction === 'v') {
    flattenLeaves(node.first, x, y, out);
    flattenLeaves(node.second, x + node.offset, y, out);
  } else {
    flattenLeaves(node.first, x, y, out);
    flattenLeaves(node.second, x, y + node.offset, out);
  }
  return out;
}

/**
 * 递归收集「裁切线 + 其所在矩形边界」：后续刀只贯通当前子条而非整张原纸。
 */
function flattenCuts(node, x = 0, y = 0, out = []) {
  if (node.kind === 'leaf') return out;
  if (node.direction === 'v') {
    out.push({
      direction: 'v',
      x1: x + node.offset, y1: y, x2: x + node.offset, y2: y + node.height,
    });
    flattenCuts(node.first, x, y, out);
    flattenCuts(node.second, x + node.offset, y, out);
  } else {
    out.push({
      direction: 'h',
      x1: x, y1: y + node.offset, x2: x + node.width, y2: y + node.offset,
    });
    flattenCuts(node.first, x, y, out);
    flattenCuts(node.second, x, y + node.offset, out);
  }
  return out;
}

function validateTree(W, H, a, b) {
  const result = solveGuillotine(W, H, a, b, new Map(), { states: 0 });
  const leaves = flattenLeaves(result.tree);

  // 叶节点无缝铺满根矩形（面积守恒）
  const area = leaves.reduce((sum, l) => sum + l.w * l.h, 0);
  assert.ok(Math.abs(area - W * H) < 1e-6, `叶面积 ${area} ≠ 根面积 ${W * H}`);

  // 占用叶即成品：叶矩形与印张尺寸一致（不再出现「印张小于所在料件」的漏刀叶）
  for (const l of leaves) {
    if (l.used) {
      const iw = l.rotated ? b : a;
      const ih = l.rotated ? a : b;
      assert.ok(Math.abs(l.w - iw) < FIT_EPSILON_MM
        && Math.abs(l.h - ih) < FIT_EPSILON_MM,
        `占用叶尺寸 ${l.w}×${l.h} 与印张 ${iw}×${ih} 不一致（边料未分离）`);
    } else {
      assert.ok(l.w > FIT_EPSILON_MM && l.h > FIT_EPSILON_MM, '出现零尺寸废料叶');
    }
  }

  const out = { items: [], cuts: [], wasteRegions: [] };
  const positioned = positionTree(result.tree, 0, 0, out);
  assert.strictEqual(out.items.length, result.count);

  // 每个印张尺寸为 a×b 或 b×a，且不越界
  for (const it of out.items) {
    const dw = it.rotated ? Math.abs(it.widthMm - b) : Math.abs(it.widthMm - a);
    const dh = it.rotated ? Math.abs(it.heightMm - a) : Math.abs(it.heightMm - b);
    assert.ok(dw < 1e-6 && dh < 1e-6, '印张尺寸与方向不一致');
    assert.ok(it.xMm >= -1e-6 && it.yMm >= -1e-6
      && it.xMm + it.widthMm <= W + 1e-6 && it.yMm + it.heightMm <= H + 1e-6, '印张越界');
  }
  // 两两不重叠（严格分离，非面积估算/重叠摆放）
  for (let i = 0; i < out.items.length; i += 1) {
    for (let j = i + 1; j < out.items.length; j += 1) {
      const p = out.items[i];
      const q = out.items[j];
      const overlap = p.xMm < q.xMm + q.widthMm - 1e-6
        && q.xMm < p.xMm + p.widthMm - 1e-6
        && p.yMm < q.yMm + q.heightMm - 1e-6
        && q.yMm < p.yMm + p.heightMm - 1e-6;
      assert.ok(!overlap, `印张 ${i} 与 ${j} 重叠`);
    }
  }
  // 每条裁切线都贯通其所在矩形（首刀贯通整张原纸，其后贯通当前子条）
  const allCuts = flattenCuts(result.tree);
  assert.strictEqual(allCuts.length, out.cuts.length, '裁切线数量一致');
  for (const cut of allCuts) {
    if (cut.direction === 'v') {
      assert.ok(Math.abs(cut.x1 - cut.x2) < 1e-9, '竖切线不直');
      assert.ok(cut.x1 > 0 && cut.x1 < W, '竖切线不在矩形内部');
    } else {
      assert.ok(Math.abs(cut.y1 - cut.y2) < 1e-9, '横切线不直');
      assert.ok(cut.y1 > 0 && cut.y1 < H, '横切线不在矩形内部');
    }
  }

  // 刀线按序可执行：从整张原纸开始，每刀都切在当前存在的料件上、贯通该料件，
  // 切完把该料件替换成两条子料件；任何一刀引用不存在的料件即为顺序不可执行。
  const keyOfRect = (r) => [r.x, r.y, r.w, r.h]
    .map((v) => Math.round((v + Number.EPSILON) * 100) / 100).join('x');
  const pieces = new Map([[keyOfRect({ x: 0, y: 0, w: W, h: H }), 1]]);
  const consumePiece = (r, idx) => {
    const key = keyOfRect(r);
    const n = pieces.get(key) || 0;
    assert.ok(n > 0, `第 ${idx + 1} 步引用了不存在的料件 ${key}（刀序/最终料件不一致）`);
    if (n === 1) pieces.delete(key);
    else pieces.set(key, n - 1);
  };
  const addPiece = (r) => {
    const key = keyOfRect(r);
    pieces.set(key, (pieces.get(key) || 0) + 1);
  };
  out.cuts.forEach((cut, idx) => {
    const piece = {
      x: cut.pieceXMm, y: cut.pieceYMm, w: cut.pieceWidthMm, h: cut.pieceHeightMm,
    };
    consumePiece(piece, idx);
    if (cut.direction === 'v') {
      assert.ok(Math.abs(cut.x1Mm - cut.x2Mm) < 1e-9, '竖切线不直');
      assert.ok(Math.abs(cut.y1Mm - piece.y) < 0.01
        && Math.abs(cut.y2Mm - (piece.y + piece.h)) < 0.01, '竖切线未贯通料件');
      const offset = cut.x1Mm - piece.x;
      assert.ok(offset > 0.01 && offset < piece.w - 0.01, '竖切线不在料件内部');
      addPiece({ x: piece.x, y: piece.y, w: offset, h: piece.h });
      addPiece({ x: cut.x1Mm, y: piece.y, w: piece.x + piece.w - cut.x1Mm, h: piece.h });
    } else {
      assert.ok(Math.abs(cut.y1Mm - cut.y2Mm) < 1e-9, '横切线不直');
      assert.ok(Math.abs(cut.x1Mm - piece.x) < 0.01
        && Math.abs(cut.x2Mm - (piece.x + piece.w)) < 0.01, '横切线未贯通料件');
      const offset = cut.y1Mm - piece.y;
      assert.ok(offset > 0.01 && offset < piece.h - 0.01, '横切线不在料件内部');
      addPiece({ x: piece.x, y: piece.y, w: piece.w, h: offset });
      addPiece({ x: piece.x, y: cut.y1Mm, w: piece.w, h: piece.y + piece.h - cut.y1Mm });
    }
  });
  // 全部刀完成后剩余料件恰好 = 印张 + 废料区域（items/cuts/wasteRegions 一致）
  const finalPieces = [
    ...out.items.map((it) => ({ x: it.xMm, y: it.yMm, w: it.widthMm, h: it.heightMm })),
    ...out.wasteRegions.map((r) => ({ x: r.xMm, y: r.yMm, w: r.widthMm, h: r.heightMm })),
  ];
  for (const r of finalPieces) consumePiece(r, out.cuts.length);
  assert.strictEqual(pieces.size, 0, '裁切后料件与印张/废料区域不一致');

  // 定位树的叶节点与 items/wasteRegions 一一对应（tree 与展平结果同源）
  const treeLeaves = [];
  const walkPositioned = (node) => {
    if (node.kind === 'leaf') {
      treeLeaves.push(node);
      return;
    }
    walkPositioned(node.first);
    walkPositioned(node.second);
  };
  walkPositioned(positioned);
  assert.strictEqual(treeLeaves.length, out.items.length + out.wasteRegions.length,
    'tree 叶节点数 ≠ 印张数 + 废料区域数');
  assert.strictEqual(treeLeaves.filter((l) => l.used).length, out.items.length);
  assert.strictEqual(treeLeaves.filter((l) => !l.used).length, out.wasteRegions.length);

  return result;
}

for (const [W, H, a, b] of [
  [100, 100, 40, 30], [250, 180, 100, 60], [300, 300, 200, 100],
  [500, 300, 300, 200], [889, 1194, 420, 297], [1000, 707, 420, 297],
]) {
  validateTree(W, H, a, b);
}

// 放不下：0 产出，整矩形为废料叶
const none = solveGuillotine(100, 50, 200, 30, new Map(), { states: 0 });
assert.strictEqual(none.count, 0);
assert.strictEqual(none.tree.kind, 'leaf');
assert.strictEqual(none.tree.used, false);

// 恰好放下：叶节点直接为 1 个印张，零裁切
const exact = solveGuillotine(420, 297, 420, 297, new Map(), { states: 0 });
assert.strictEqual(exact.count, 1);
assert.strictEqual(exact.tree.kind, 'leaf');

// 经典排布：600×800 内放 300×200 恰好 8 个
assert.strictEqual(solveGuillotine(600, 800, 300, 200, new Map(), { states: 0 }).count, 8);

// ---------- 3b. 边料分离（漏刀修复）：印张小于料件时必须下贯通刀分离边料 ----------

// 漏刀回归：350×250 原纸裁 300×200 印张——过去报告可行却 0 刀、叶覆盖整张原纸
{
  const r = solveGuillotine(350, 250, 300, 200, new Map(), { states: 0 });
  assert.strictEqual(r.count, 1);
  const out = { items: [], cuts: [], wasteRegions: [] };
  positionTree(r.tree, 0, 0, out);
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.cuts.length, 2, 'L 形边料需要横、竖两刀贯通分离');
  // 先序即刀序：先在整张原纸上横切，再在 350×200 料件上竖切
  assert.deepStrictEqual(
    out.cuts.map((c) => `${c.direction}@${c.pieceWidthMm}x${c.pieceHeightMm}`),
    ['h@350x250', 'v@350x200'],
  );
  const [hc, vc] = out.cuts;
  assert.strictEqual(hc.y1Mm, 200);
  assert.strictEqual(hc.x1Mm, 0); assert.strictEqual(hc.x2Mm, 350);
  assert.strictEqual(vc.x1Mm, 300); assert.strictEqual(vc.y1Mm, 0);
  assert.strictEqual(vc.y2Mm, 200);
  // 边料被显式标为废料区域：350×50 整条下边料 + 50×200 右边料，铺满原纸
  assert.strictEqual(out.wasteRegions.length, 2);
  const wasteArea = out.wasteRegions.reduce((s, w) => s + w.widthMm * w.heightMm, 0);
  assert.ok(Math.abs(wasteArea - (350 * 250 - 300 * 200)) < 0.01);
  const covered = out.items.concat(out.wasteRegions)
    .reduce((s, r) => s + r.widthMm * r.heightMm, 0);
  assert.ok(Math.abs(covered - 350 * 250) < 0.01, '印张 + 边料应无缝铺满原纸');
  // 占用叶不再覆盖整张原纸
  assert.strictEqual(r.tree.kind, 'cut');
}

// 仅单侧留边：350×200 料件放 300×200 → 1 条竖切线即可
{
  const r = solveGuillotine(350, 200, 300, 200, new Map(), { states: 0 });
  assert.strictEqual(r.count, 1);
  const out = { items: [], cuts: [], wasteRegions: [] };
  positionTree(r.tree, 0, 0, out);
  assert.strictEqual(out.cuts.length, 1);
  assert.strictEqual(out.cuts[0].direction, 'v');
  assert.strictEqual(out.cuts[0].x1Mm, 300);
  assert.strictEqual(out.wasteRegions.length, 1);
  assert.ok(Math.abs(out.wasteRegions[0].widthMm - 50) < 1e-6);
  assert.ok(Math.abs(out.wasteRegions[0].heightMm - 200) < 1e-6);
}

// 仅下侧留边：300×250 料件放 300×200 → 1 条横切线即可
{
  const r = solveGuillotine(300, 250, 300, 200, new Map(), { states: 0 });
  const out = { items: [], cuts: [], wasteRegions: [] };
  positionTree(r.tree, 0, 0, out);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(out.cuts.length, 1);
  assert.strictEqual(out.cuts[0].direction, 'h');
  assert.strictEqual(out.cuts[0].y1Mm, 200);
  assert.strictEqual(out.wasteRegions.length, 1);
}

// 恰好贴边：不增加多余刀线，也没有废料区域
{
  const exactOut = { items: [], cuts: [], wasteRegions: [] };
  const exactTree = solveGuillotine(300, 200, 300, 200, new Map(), { states: 0 }).tree;
  positionTree(exactTree, 0, 0, exactOut);
  assert.strictEqual(exactTree.kind, 'leaf');
  assert.strictEqual(exactOut.cuts.length, 0);
  assert.strictEqual(exactOut.wasteRegions.length, 0);
}

// 旋转印张留边：250×300 料件放 300×200 印张只能旋转为 200×300，
// 恰好占满高度，仅右条 50mm 废料 → 1 条竖切线
{
  const rotRect = solveGuillotine(250, 300, 300, 200, new Map(), { states: 0 });
  assert.strictEqual(rotRect.count, 1);
  const out = { items: [], cuts: [], wasteRegions: [] };
  positionTree(rotRect.tree, 0, 0, out);
  assert.strictEqual(out.items[0].rotated, true);
  assert.strictEqual(out.items[0].widthMm, 200);
  assert.strictEqual(out.items[0].heightMm, 300);
  assert.strictEqual(out.cuts.length, 1);
  assert.strictEqual(out.cuts[0].direction, 'v');
  assert.strictEqual(out.cuts[0].x1Mm, 200);
  assert.strictEqual(out.wasteRegions[0].widthMm, 50);
  assert.strictEqual(out.wasteRegions[0].heightMm, 300);
}

// ---------- 4. buildCuttingPlan：整体方案、尾张与废料 ----------

const cut = buildCuttingPlan(planA4, [
  P('A3', 420, 297),         // 恰好 1 个
  P('大度对开', 889, 1194),  // 8 个（420 两列 × 297 四行）
  P('A4 太小', 297, 210),    // 不可行
], 100);
assert.strictEqual(cut.kind, 'sheet-cutting-plan');
assert.strictEqual(cut.schemaVersion, 1);
assert.strictEqual(cut.feasible, true);
assert.strictEqual(cut.requiredSheets, 100);

const a3 = cut.options[0];
assert.strictEqual(a3.feasible, true);
assert.strictEqual(a3.yieldsPerSheet, 1);
assert.strictEqual(a3.sheetsRequired, 100);
assert.strictEqual(a3.lastSheet.isLastSheetPartial, false);
assert.strictEqual(a3.lastSheet.exact, true);
assert.strictEqual(a3.lastSheet.spareCapacity, 0);
assert.strictEqual(a3.waste.perSheetAreaMm2, 0); // 恰好铺满，废料严格为 0
assert.strictEqual(a3.waste.totalAreaMm2, 0);
assert.strictEqual(a3.utilizationPercent, 100);
assert.strictEqual(a3.cutting.cutCount, 0);
assert.strictEqual(a3.cutting.items.length, 1);

const big = cut.options[1];
assert.strictEqual(big.yieldsPerSheet, 8);
assert.strictEqual(big.sheetsRequired, 13); // ceil(100/8)
assert.strictEqual(big.lastSheet.fullSheets, 12);
assert.strictEqual(big.lastSheet.lastSheetYield, 4);
assert.strictEqual(big.lastSheet.spareCapacity, 4);
assert.strictEqual(big.lastSheet.isLastSheetPartial, true);
// 8 个 420×297 = 840×1188 条带铺满可行条带；889×1194 原纸周边有余料
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const perSheetWaste = 889 * 1194 - 8 * 420 * 297;
assert.ok(Math.abs(big.waste.perSheetAreaMm2 - round2(perSheetWaste)) < 1,
  `单张废料 ${big.waste.perSheetAreaMm2} ≈ ${round2(perSheetWaste)}`);
assert.ok(big.waste.lastSheetAreaMm2 > big.waste.perSheetAreaMm2, '尾张废料含 4 个空位');
// 总废料 = 12 张满排废料 + 1 张尾张废料（尾张只裁 4 个）
const expectedTotal = 12 * big.waste.perSheetAreaMm2 + big.waste.lastSheetAreaMm2;
assert.ok(Math.abs(big.waste.totalAreaMm2 - round2(expectedTotal)) < 1,
  `总废料 ${big.waste.totalAreaMm2} ≈ ${round2(expectedTotal)}`);
assert.strictEqual(big.cutting.items.length, 8);

// 整除时无尾张：总废料 = 每张常规废料 × 张数
const exactRun = buildCuttingPlan(planA4, [P('大度对开', 889, 1194)], 16);
const big16 = exactRun.options[0];
assert.strictEqual(big16.sheetsRequired, 2);
assert.strictEqual(big16.lastSheet.isLastSheetPartial, false);
assert.strictEqual(big16.lastSheet.lastSheetYield, 0);
assert.ok(Math.abs(big16.waste.totalAreaMm2 - 2 * big16.waste.perSheetAreaMm2) < 0.01);

// 漏刀回归（API 同口径）：350×250 原纸裁 300×200 印张，报告可行且必须给出
// 分离印张与边料的贯通刀线，边料标为废料；items/cuts/tree/wasteRegions 一致
const plan300 = {
  sheets: [{ sheet: 1 }],
  sourceCount: 4, paddedCount: 0, totalCount: 4, blanks: 0,
  panel: { width: 150 * PT_PER_MM, height: 200 * PT_PER_MM, orientation: 'portrait' },
  sheet: { width: 300 * PT_PER_MM, height: 200 * PT_PER_MM },
};
const trimPlan = buildCuttingPlan(plan300, [P('留边原纸', 350, 250)], 1);
const trimOpt = trimPlan.options[0];
assert.strictEqual(trimOpt.feasible, true);
assert.strictEqual(trimOpt.yieldsPerSheet, 1);
assert.strictEqual(trimOpt.cutting.cutCount, 2);
assert.strictEqual(trimOpt.cutting.items.length, 1);
assert.ok(trimOpt.cutting.wasteRegions.length >= 2, 'L 形边料应拆为废料区域');
// 废料区域面积合计 = 单张废料 = 原纸面积 − 印张面积
const trimWaste = trimOpt.cutting.wasteRegions
  .reduce((s, r) => s + r.widthMm * r.heightMm, 0);
assert.ok(Math.abs(trimWaste - trimOpt.waste.perSheetAreaMm2) < 0.5,
  `废料区域合计 ${trimWaste} ≠ 单张废料 ${trimOpt.waste.perSheetAreaMm2}`);
assert.ok(Math.abs(trimOpt.waste.perSheetAreaMm2 - (350 * 250 - 300 * 200)) < 0.5);
// 印张 + 废料区域无缝铺满原纸（坐标一致、不重不漏）
const tiled = trimOpt.cutting.items.concat(trimOpt.cutting.wasteRegions)
  .reduce((s, r) => s + r.widthMm * r.heightMm, 0);
assert.ok(Math.abs(tiled - 350 * 250) < 0.5);
// tree 中的废料叶与 wasteRegions 数量一致
const countLeaves = (node, used) => {
  if (node.kind === 'leaf') return node.used === used ? 1 : 0;
  return countLeaves(node.first, used) + countLeaves(node.second, used);
};
assert.strictEqual(countLeaves(trimOpt.cutting.tree, false),
  trimOpt.cutting.wasteRegions.length);
assert.strictEqual(countLeaves(trimOpt.cutting.tree, true),
  trimOpt.cutting.items.length);
// cutCount 与 cuts/tree 一致
let treeCutCount = 0;
(function countCuts(node) {
  if (node.kind !== 'cut') return;
  treeCutCount += 1;
  countCuts(node.first);
  countCuts(node.second);
}(trimOpt.cutting.tree));
assert.strictEqual(treeCutCount, trimOpt.cutting.cutCount);
assert.strictEqual(trimOpt.cutting.cuts.length, trimOpt.cutting.cutCount);
// JSON 可序列化（导出与网页同源）
JSON.parse(JSON.stringify(trimOpt));

// 恰好贴边：同尺寸原纸 0 刀、0 废料区域
const flushPlan = buildCuttingPlan(plan300, [P('恰好', 300, 200)], 1);
const flushOpt = flushPlan.options[0];
assert.strictEqual(flushOpt.feasible, true);
assert.strictEqual(flushOpt.cutting.cutCount, 0);
assert.strictEqual(flushOpt.cutting.wasteRegions.length, 0);
assert.strictEqual(flushOpt.waste.perSheetAreaMm2, 0);

// ---------- 5. 推荐排序：所需原纸张数 → 总废料面积 ----------

const ranked = buildCuttingPlan(planA4, [
  P('大但废料多', 600, 1000),  // 4 个 → 25 张
  P('大度对开', 889, 1194),   // 8 个 → 13 张
  P('A3', 420, 297),         // 1 个 → 100 张
], 100);
const feasible = ranked.options.filter((o) => o.feasible);
// options 保持维护顺序；推荐项由 recommended 指定（按张数、废料排序）
assert.strictEqual(ranked.recommended.name, '大度对开');
const rec = ranked.options.find((o) => o.index === ranked.recommended.index);
assert.strictEqual(rec.yieldsPerSheet, 8);
assert.strictEqual(rec.sheetsRequired, 13);
assert.ok(rec.sheetsRequired < feasible.find((o) => o.name === '大但废料多').sheetsRequired);

// 所需张数相同（单张产出相同）时按总废料面积升序：
// 841×1190 与 880×1188 都出 8 个，但前者废料更少
const tie = buildCuttingPlan(planA4, [
  P('大纸 A 废料多', 880, 1188),
  P('大纸 B 废料少', 841, 1188),
], 8);
const t0 = tie.options.find((o) => o.name === '大纸 A 废料多');
const t1 = tie.options.find((o) => o.name === '大纸 B 废料少');
assert.strictEqual(t0.yieldsPerSheet, t1.yieldsPerSheet);
assert.strictEqual(t0.sheetsRequired, t1.sheetsRequired);
assert.ok(t1.waste.totalAreaMm2 < t0.waste.totalAreaMm2,
  `废料排序 ${t1.waste.totalAreaMm2} 应 < ${t0.waste.totalAreaMm2}`);
assert.strictEqual(tie.recommended.name, '大纸 B 废料少');

// ---------- 6. 旋转：竖放原纸与混合朝向排布 ----------

// 297×420 的「竖 A3」原纸：纸张保持原向、印张旋转 90°（297×420）即可放下；
// 纸张旋转 90°（420×297）时印张原向放入——两方向产出相同，优先纸张原向
const portrait = buildCuttingPlan(planA4, [P('竖 A3', 297, 420)], 3);
assert.strictEqual(portrait.feasible, true);
assert.strictEqual(portrait.options[0].yieldsPerSheet, 1);
assert.strictEqual(portrait.options[0].placement.orientation, 'as_is');
assert.strictEqual(portrait.options[0].placement.rotated, false);
assert.strictEqual(portrait.options[0].placement.rotatedItemCount, 1);

// 纸张旋转 90° 与原向产出相同：420×594 横 A2 与 594×420 竖 A2 都出 2 个，
// 横纸选原向；这保证两个方向都被枚举（结果与整体旋转对称）
const bothDirs = buildCuttingPlan(planA4, [
  P('横 A2', 594, 420),
  P('竖 A2', 420, 594),
], 3);
for (const o of bothDirs.options) {
  assert.strictEqual(o.feasible, true);
  assert.strictEqual(o.yieldsPerSheet, 2);
  assert.strictEqual(o.placement.orientation, 'as_is');
}

// 窄纸 300×400：纸张原向与旋转 90° 后两个朝向都放不下（两个朝向都缺
// 420 那条边）——不可行并给出两方向不足量，原因不混淆
const narrow = buildCuttingPlan(planA4, [P('窄纸 300×400', 300, 400)], 3);
assert.strictEqual(narrow.feasible, false);
assert.strictEqual(narrow.reasonCode, 'no_fitting_paper');
assert.match(narrow.reason, /300 × 400/);

// 同一朝向内混合旋转：500×300 内放 300×200，左侧原向 1 个 +
// 右侧 200×300 条带内印张旋转 90° 再出 1 个 → 共 2 个（面积上界也是 2）
const plan300x200 = {
  sheets: [{ sheet: 1 }],
  sourceCount: 4, paddedCount: 0, totalCount: 4, blanks: 0,
  panel: { width: 150 * PT_PER_MM, height: 200 * PT_PER_MM, orientation: 'portrait' },
  sheet: { width: 300 * PT_PER_MM, height: 200 * PT_PER_MM },
};
const mixed = buildCuttingPlan(plan300x200, [P('混合朝向原纸', 500, 300)], 1);
const m = mixed.options[0];
assert.strictEqual(m.yieldsPerSheet, 2);
assert.ok(m.placement.rotatedItemCount >= 1, '混合朝向方案应包含旋转印张');

// ---------- 7. 不可行：明确原因（两个方向的不足量） ----------

const noFit = buildCuttingPlan(planA4, [P('A4', 297, 210)], 10);
assert.strictEqual(noFit.feasible, false);
assert.strictEqual(noFit.recommended, null);
assert.strictEqual(noFit.reasonCode, 'no_fitting_paper');
assert.match(noFit.reason, /420/);
assert.match(noFit.reason, /A4/);
const opt = noFit.options[0];
assert.strictEqual(opt.feasible, false);
assert.strictEqual(opt.reasons.length, 2);
const asIs = opt.reasons.find((r) => r.orientation === 'as_is');
const rotated = opt.reasons.find((r) => r.orientation === 'rotated_90');
assert.ok(asIs.shortageWidthMm > 0 && asIs.shortageHeightMm > 0);
assert.match(asIs.message, /宽度不足/);
assert.match(rotated.message, /宽度不足/);

// ---------- 8. 非法入参 ----------

assert.throws(() => buildCuttingPlan(null, [P('A3', 420, 297)], 1), /plan/);
assert.throws(() => buildCuttingPlan(planA4, [], 1), /至少维护一种/);
assert.throws(() => buildCuttingPlan(planA4, [P('坏', 0, 100)], 1), /宽必须是大于 0/);
assert.throws(() => buildCuttingPlan(planA4, [P('A3', 420, 297)], 0), /所需印张数/);
assert.throws(() => buildCuttingPlan(planA4, [P('A3', 420, 297)], 1.2), /所需印张数/);
assert.throws(
  () => buildCuttingPlan(planA4, Array(9).fill(P('x', 420, 297)), 1),
  /最多维护 8 种/,
);

// ---------- 9. 规模上限 ----------

const huge = buildCuttingPlan({
  sheets: [{ sheet: 1 }],
  sourceCount: 4, paddedCount: 0, totalCount: 4, blanks: 0,
  panel: { width: 100, height: 100, orientation: 'square' },
  sheet: { width: 200, height: 100 }, // 极小印张（pt）
}, [P('巨型原纸', 100000, 100000)], 1);
// 面积上界超过 MAX_ITEMS_PER_SHEET：该规格不给出方案
assert.strictEqual(huge.feasible, false);
assert.strictEqual(MAX_ITEMS_PER_SHEET > 0, true);
assert.ok(FIT_EPSILON_MM > 0);

// ---------- 10. 结构稳定性（JSON 可序列化、外部消费字段齐全） ----------

const json = JSON.parse(JSON.stringify(cut));
assert.strictEqual(json.kind, 'sheet-cutting-plan');
assert.strictEqual(typeof json.generatedAt, 'string');
assert.ok(json.layout.sheet.widthMm > 0 && json.layout.sheet.heightMm > 0);
for (const o of json.options) {
  if (o.feasible) {
    assert.ok(Number.isInteger(o.yieldsPerSheet) && o.yieldsPerSheet > 0);
    assert.ok(Number.isInteger(o.sheetsRequired) && o.sheetsRequired > 0);
    assert.ok(Array.isArray(o.cutting.items) && o.cutting.items.length === o.yieldsPerSheet);
    assert.ok(Array.isArray(o.cutting.cuts));
    assert.ok(o.cutting.tree && typeof o.cutting.tree.kind === 'string');
    assert.ok(o.waste.totalAreaMm2 >= 0);
  } else {
    assert.strictEqual(o.yieldsPerSheet, undefined);
  }
}

// pt↔mm 换算自检
assert.ok(Math.abs(PT_PER_MM - 72 / 25.4) < 1e-12);

console.log('✅ 批量裁切下料纯函数测试通过：印张数校验、记忆化矩形分割搜索（网格暴力对拍）、');
console.log('   贯通裁切树（铺满/无重叠/不越界/切线贯通）、原纸方向枚举与混合旋转、');
console.log('   单张产出/所需原纸/尾张余量/废料面积、推荐排序、不可行原因与规模上限');
