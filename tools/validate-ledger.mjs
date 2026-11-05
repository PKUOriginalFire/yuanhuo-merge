// 台账判据上线前验证：拿生产库里**所有真实状态**（live_game 有 balls + trace）过一遍
//   ① 真人误杀必须为 0
//   ② 顺便量出比现行 units 上界紧多少倍
import { DatabaseSync } from 'node:sqlite';
import { ledgerFlag, validateRun } from '/opt/yuanhuo/server/validate.js';

const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });
const rows = db.prepare(`SELECT l.state, l.updated_at, l.client_id, p.nickname FROM live_game l
  LEFT JOIN player p ON p.client_id = l.client_id`).all();

const stats = { total: 0, checked: 0, flagged: 0, notOver: 0 };
const flagged = [];
const ratios = [];

for (const r of rows) {
  stats.total++;
  let s;
  try { s = JSON.parse(r.state); } catch { continue; }
  if (!Array.isArray(s.balls) || !Array.isArray(s.trace) || !(s.score > 0)) continue;
  if (!Number.isInteger(s.merges)) continue;
  stats.checked++;
  const flag = ledgerFlag({
    mode: s.mode, trace: s.trace, balls: s.balls, merges: s.merges,
    score: s.score, loopCount: s.loopCount ?? 0,
  });
  // 现行 units 上界（对照）
  const verdict = validateRun({
    mode: s.mode, score: s.score, maxLevel: s.maxLevelReached ?? 1, merges: s.merges,
    loopCount: s.loopCount ?? 0, durationMs: Math.round(s.elapsed ?? 1), trace: s.trace,
  });
  if (verdict.upper > 0 && s.score > 0) ratios.push(verdict.upper / Math.max(1, s.score));
  if (flag) {
    stats.flagged++;
    flagged.push({ score: s.score, status: s.status, merges: s.merges, mode: s.mode, flag, nick: r.nickname });
  }
}

console.log(`扫描 ${stats.total} 条在途记录，其中有 score/balls/trace 的 ${stats.checked} 条`);
console.log(`台账判据命中: ${stats.flagged} 条`);
for (const f of flagged.sort((a, b) => b.score - a.score).slice(0, 15)) {
  console.log(`  ${String(f.score).padStart(6)} 分 ${String(f.mode).padEnd(7)} ${f.status.padEnd(7)} ${f.nick || '(无名)'}`);
  console.log(`      ${f.flag.slice(0, 170)}`);
}
ratios.sort((a, b) => a - b);
if (ratios.length) {
  const p = q => ratios[Math.min(ratios.length - 1, Math.floor(q * ratios.length))];
  console.log(`\n现行 units 上界 / 实际分数 的倍数：p10 ${p(0.1).toFixed(2)}  中位 ${p(0.5).toFixed(2)}  p90 ${p(0.9).toFixed(2)}  最大 ${ratios[ratios.length - 1].toFixed(2)}`);
  console.log('（倍数越大说明现行判据余量越松；台账判据把余量压到 1.0 上下）');
}
