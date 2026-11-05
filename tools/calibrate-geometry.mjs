// 标定两个"改客户端几何"的痕迹：
//   ① 球跑出容器左右墙（改宽落球区）→ |x| 超出 [62,1063] 多远
//   ② 终局时最高那颗球的球顶离死亡线多远（改死亡线 / 加高可玩区）
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });

const LEFT = 62, RIGHT = 1063, FLOOR = 1940, DEATH = 540;
const DIAM = [90, 106, 125, 147, 173, 204, 240, 283, 333, 392, 461];
const r = lv => (DIAM[lv - 1] ?? 90) / 2;

const rows = db.prepare(`SELECT l.state, p.nickname FROM live_game l LEFT JOIN player p ON p.client_id = l.client_id`).all();
const outX = [], topAtOver = [], unitsAtOver = [];
let scanned = 0, outXruns = 0;
for (const row of rows) {
  let s; try { s = JSON.parse(row.state); } catch { continue; }
  if (!Array.isArray(s.balls) || !s.balls.length) continue;
  scanned++;
  // ① 水平越界：球心超过墙面（允许半个球身贴墙外的浮点误差 → 用半径作容差）
  let worst = 0;
  for (const b of s.balls) {
    const over = Math.max(LEFT - b.x, b.x - RIGHT);
    if (over > 0) worst = Math.max(worst, over);
  }
  if (worst > 0) { outXruns++; outX.push({ worst, nick: row.nickname || '(无名)', score: s.score }); }
  // ② 终局时最高球顶离死亡线的距离
  if (s.status === 'over') {
    const top = Math.min(...s.balls.map(b => b.y - r(b.level)));
    topAtOver.push({ top, gap: top - DEATH, nick: row.nickname || '(无名)', score: s.score, n: s.balls.length });
    unitsAtOver.push({ units: s.balls.reduce((a, b) => a + (b.level > 0 ? 2 ** (b.level - 1) : 0), 0), score: s.score, nick: row.nickname || '(无名)' });
  }
}

console.log(`扫描 ${scanned} 个有球的状态`);
console.log(`\n=== ① 球心越出左右墙（>0 即越界）===
  越界状态数: ${outXruns}`);
outX.sort((a, b) => b.worst - a.worst);
for (const o of outX.slice(0, 10)) console.log(`  越界 ${o.worst.toFixed(1)}px  ${String(o.score).padStart(6)} 分  ${o.nick}`);

const gaps = topAtOver.map(t => t.gap).sort((a, b) => a - b);
const q = p => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
console.log(`\n=== ② 终局时"最高球顶" 相对死亡线(540) 的位置：${gaps.length} 个 over 状态 ===`);
console.log(`  最低 ${q(0).toFixed(0)}  p1 ${q(0.01).toFixed(0)}  p50 ${q(0.5).toFixed(0)}  p99 ${q(0.99).toFixed(0)}  最高 ${q(1).toFixed(0)}`);
console.log('  （负数=球顶在死亡线之上，正常结束应该都略低于 0；正数=球没到线）');
console.log('  最"贴着线"的 5 个:');
for (const t of topAtOver.sort((a, b) => b.gap - a.gap).slice(0, 5)) console.log(`    gap ${t.gap.toFixed(0)}  ${t.score} 分 ${t.n} 球 ${t.nick}`);
console.log('  球堆得最高的 5 个（gap 最负）:');
for (const t of topAtOver.sort((a, b) => a.gap - b.gap).slice(0, 5)) console.log(`    gap ${t.gap.toFixed(0)}  ${t.score} 分 ${t.n} 球 ${t.nick}`);

const us = unitsAtOver.map(u => u.units).sort((a, b) => a - b);
console.log(`\n=== 终局球阵单位总量：${us.length} 个 over 状态 ===`);
console.log(`  最小 ${us[0]}  中位 ${us[Math.floor(us.length / 2)]}  p99 ${us[Math.floor(us.length * 0.99)]}  最大 ${us[us.length - 1]}`);
console.log('  最大的 5 个:');
for (const u of unitsAtOver.sort((a, b) => b.units - a.units).slice(0, 5)) console.log(`    ${u.units} 单位  ${u.score} 分  ${u.nick}`);
