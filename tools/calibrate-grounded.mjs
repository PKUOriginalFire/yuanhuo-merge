// 标定「终局球阵是否落地」：真实 over 状态里最低那颗球的 y 分布
//   （红队 run A 把整块球阵凭空上抬 772px 没被抓，就是因为没有判据要求"接地"）
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });

const CONTAINER_BOTTOM = 1940;   // web/src/config.ts CONTAINER
const rows = db.prepare(`SELECT l.state, p.nickname FROM live_game l LEFT JOIN player p ON p.client_id = l.client_id`).all();

const lows = [], highs = [];
for (const r of rows) {
  let s; try { s = JSON.parse(r.state); } catch { continue; }
  if (!Array.isArray(s.balls) || s.balls.length < 3) continue;
  const byY = [...s.balls].sort((a, b) => b.y - a.y);   // y 越大越靠下
  const lowest = byY[0].y;                              // 最低那颗球的球心
  const gap = CONTAINER_BOTTOM - lowest;                // 球心离容器底部的距离（球的半径算在内）
  const top = Math.min(...s.balls.map(b => b.y));
  lows.push({ gap, lowest, top, n: s.balls.length, status: s.status, nick: r.nickname || '(无名)', score: s.score });
  highs.push(gap);
}
highs.sort((a, b) => a - b);
const p = q => highs[Math.min(highs.length - 1, Math.floor(q * highs.length))];
console.log(`有 ≥3 颗球的状态 ${highs.length} 条`);
console.log(`球心离底部距离 gap：min ${highs[0]?.toFixed(0)}  p1 ${p(0.01)?.toFixed(0)}  p50 ${p(0.5)?.toFixed(0)}  p99 ${p(0.99)?.toFixed(0)}  max ${highs[highs.length - 1]?.toFixed(0)}`);
console.log('（gap ≈ 最大球半径或更小 → 球确实压在底面上）');
console.log('\ngap 最大的 12 条（最像"悬空"的）：');
for (const x of lows.sort((a, b) => b.gap - a.gap).slice(0, 12)) {
  console.log(`  gap ${String(x.gap.toFixed(0)).padStart(5)}px  最低球 y=${x.lowest.toFixed(0)}  最高球 y=${x.top.toFixed(0)}  ${String(x.n).padStart(3)} 球  ${String(x.status).padEnd(7)} ${String(x.score).padStart(6)} 分  ${x.nick}`);
}
// 分级统计：gap 分布
const buckets = [0, 30, 60, 120, 250, 500, 1e9];
const hist = {};
for (const g of highs) {
  const b = buckets.findIndex(v => g < v);
  const key = b === 0 ? '<30' : `<${buckets[b]}`;
  hist[key] = (hist[key] ?? 0) + 1;
}
console.log('\ngap 分布:', JSON.stringify(hist));
