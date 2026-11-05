// 离线校验"分数随时间增长曲线"：拿生产库每一局的历史数据过一遍新规则
//   · 274 局真人必须全部通过（否则是误杀）
//   · 53 局已标记的可疑局，看看这条能额外抓到多少
//   · 再算"想报 X 分至少要打多久"（攻击成本）
// 用法：node verify-score-curve.mjs [validate.js 的路径] [数据库路径]
const validatePath = process.argv[2] ?? '/opt/yuanhuo/server/validate.js';
const dbPath = process.argv[3] ?? '/opt/yuanhuo/server/data/yuanhuo.db';

const { scoreCurveFlag, scoreCurveExcess, SCORE_CURVE } = await import(validatePath);
const { DatabaseSync } = await import('node:sqlite');

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(`SELECT r.mode, r.score, r.duration_ms, r.suspicious, r.flag_reason, p.nickname
  FROM run r JOIN player p ON p.id = r.player_id`).all();

const real = rows.filter(r => !r.suspicious && r.duration_ms >= 5000 && r.score > 0);
const flagged = rows.filter(r => r.suspicious);

console.log(`规则: 分数 <= ${SCORE_CURVE.intercept} + ${SCORE_CURVE.perSecond} * 秒`);
console.log(`\n=== 真人（${real.length} 局）误杀检查 ===`);
const hits = real.filter(r => scoreCurveFlag(r.score, r.duration_ms));
console.log(`  触发新规则: ${hits.length} 局`);
for (const r of hits.slice(0, 10)) {
  console.log(`    ${r.nickname || '(无名)'} ${r.mode} ${r.score} 分 / ${(r.duration_ms / 1000).toFixed(0)} 秒`);
}
const margins = real
  .map(r => ({ ...r, ratio: r.score / (SCORE_CURVE.intercept + SCORE_CURVE.perSecond * (r.duration_ms / 1000)) }))
  .sort((a, b) => b.ratio - a.ratio);
console.log('  离曲线最近的 5 局（100% 就是刚好压线）:');
for (const r of margins.slice(0, 5)) {
  console.log(`    ${(r.ratio * 100).toFixed(0)}%  ${r.score} 分 / ${(r.duration_ms / 1000).toFixed(0)} 秒  ${r.nickname || '(无名)'}`);
}

console.log(`\n=== 已标记的可疑局（${flagged.length} 条）===`);
const extra = flagged.filter(r => scoreCurveExcess(r.score, r.duration_ms) > 0);
console.log(`  新规则能额外抓到: ${extra.length} 条`);
for (const r of extra.slice(0, 8)) {
  console.log(`    ${r.nickname || '(无名)'} ${r.mode} ${r.score} 分 / ${(r.duration_ms / 1000).toFixed(0)} 秒 = ${(r.score / (r.duration_ms / 1000)).toFixed(1)}/秒`);
}

console.log('\n=== 攻击成本：想报 X 分至少要打多久 ===');
for (const target of [2000, 3000, 4000, 5786, 8000, 18454]) {
  const need = (target - SCORE_CURVE.intercept) / SCORE_CURVE.perSecond;
  console.log(`  ${String(target).padStart(5)} 分 → 至少 ${(need / 60).toFixed(1)} 分钟`);
}
