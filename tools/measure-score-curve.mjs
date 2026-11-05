// 标定"分数随时间的增长曲线"：真人每秒能拿多少分？
//   数据源：生产库 run 表（score 与 duration_ms 都是服务端校验过的字段）
//   输出：各时长段的分数上包络、每秒得分分布，为定"分数 ≤ A + B·秒"提供依据
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });
const rows = db.prepare(`SELECT r.mode, r.score, r.duration_ms, r.merges, r.drops, r.suspicious, p.nickname
  FROM run r JOIN player p ON p.id = r.player_id`).all();

const legit = rows.filter(r => !r.suspicious && r.duration_ms >= 20000 && r.score > 0);
console.log(`总对局 ${rows.length}，其中可疑 ${rows.filter(r => r.suspicious).length}，参与标定 ${legit.length}`);

for (const mode of ['classic', 'endless']) {
  const set = legit.filter(r => r.mode === mode);
  if (!set.length) continue;
  const rate = set.map(r => ({ ...r, ps: r.score / (r.duration_ms / 1000) })).sort((a, b) => b.ps - a.ps);
  const q = p => rate[Math.min(rate.length - 1, Math.floor(p * rate.length))].ps;
  console.log(`\n=== ${mode}（${set.length} 局）每秒得分：max ${rate[0].ps.toFixed(2)}  p99 ${q(0.01).toFixed(2)}  p90 ${q(0.1).toFixed(2)}  中位 ${q(0.5).toFixed(2)}`);
  console.log('  每秒得分最高的 8 局：');
  for (const r of rate.slice(0, 8)) {
    console.log(`    ${r.score.toString().padStart(6)} 分 / ${(r.duration_ms / 1000).toFixed(0).padStart(5)} 秒 = ${r.ps.toFixed(2)}/秒  (合成 ${r.merges}, 投放 ${r.drops})  ${r.nickname}`);
  }
  // 时长分段的分数上包络
  console.log('  各时长段的最高分：');
  for (const [lo, hi] of [[20, 60], [60, 180], [180, 300], [300, 600], [600, 1200], [1200, 2400], [2400, 1e9]]) {
    const bucket = set.filter(r => r.duration_ms / 1000 >= lo && r.duration_ms / 1000 < hi);
    if (!bucket.length) continue;
    const best = bucket.reduce((a, b) => (b.score > a.score ? b : a));
    const bestRate = Math.max(...bucket.map(r => r.score / (r.duration_ms / 1000)));
    console.log(`    ${String(lo).padStart(4)}-${String(hi === 1e9 ? '∞' : hi).padStart(4)} 秒: ${bucket.length} 局，最高 ${best.score}（${(best.duration_ms / 1000).toFixed(0)} 秒），该段最高速率 ${bestRate.toFixed(2)}/秒`);
  }
  // 拟合：score = A + B·秒，取"上包络"——对每个 B 求 max(score − B·T)
  console.log('  线性包络 score ≤ A + B·T 的候选：');
  for (const B of [2, 3, 4, 5, 6]) {
    let worst = -Infinity;
    for (const r of set) {
      const excess = r.score - B * (r.duration_ms / 1000);
      if (excess > worst) worst = excess;
    }
    console.log(`    B=${B}/秒 → 真人最大截距 A=${worst.toFixed(0)}（即 score ≤ ${worst.toFixed(0)} + ${B}·T 覆盖全部真人）`);
  }
}
