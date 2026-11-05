// 标定"压线持续时长"：真人终局时 elapsed - overLineSince 到底是多少
//   客户端的规则：压线连续 deathGraceMs(2000) 就判负，所以这个值理论上应该 ≈2000
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });

const rows = db.prepare(`SELECT l.state, p.nickname FROM live_game l LEFT JOIN player p ON p.client_id = l.client_id`).all();
const vals = [];
let missing = 0;
for (const r of rows) {
  let s; try { s = JSON.parse(r.state); } catch { continue; }
  if (s.status !== 'over') continue;
  if (!Number.isFinite(s.overLineSince)) { missing++; continue; }
  vals.push({ ms: s.elapsed - s.overLineSince, score: s.score, nick: r.nickname || '(无名)', elapsed: s.elapsed });
}
vals.sort((a, b) => a.ms - b.ms);
const p = q => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))].ms;
console.log(`终局状态 ${vals.length} 个可算（另有 ${missing} 个 overLineSince 为 null）`);
if (vals.length) {
  console.log(`  压线持续时长 elapsed−overLineSince：min ${vals[0].ms.toFixed(0)}  p1 ${p(0.01).toFixed(0)}  p50 ${p(0.5).toFixed(0)}  p99 ${p(0.99).toFixed(0)}  max ${vals[vals.length - 1].ms.toFixed(0)} ms`);
  console.log('  最长的 10 个:');
  for (const v of vals.slice(-10).reverse()) {
    console.log(`    ${v.ms.toFixed(0)}ms  ${String(v.score).padStart(6)} 分 / ${(v.elapsed / 1000).toFixed(0)} 秒  ${v.nick}`);
  }
  console.log('  最短的 5 个:');
  for (const v of vals.slice(0, 5)) console.log(`    ${v.ms.toFixed(0)}ms  ${String(v.score).padStart(6)} 分  ${v.nick}`);
  // 分布桶
  const buckets = {};
  for (const v of vals) {
    const k = v.ms < 1500 ? '<1.5s' : v.ms < 2500 ? '1.5-2.5s' : v.ms < 5000 ? '2.5-5s' : v.ms < 20000 ? '5-20s' : '>20s';
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  console.log('  分布:', JSON.stringify(buckets));
}
