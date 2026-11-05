// 回溯审计：用**当前**规则重新判一遍库里所有"干净"对局（suspicious=0），找漏网的
//   ① 直接复用 server/validate.js 的真规则（validateRun / detectAutomatedDrops / scoreCurveFlag …）
//   ② 再算几个"规则没直接用、但能看出人味"的指标：落点跨度/种类、投放间隔规律性、分数/合成比
//   ③ 按 ip_hash 把干净对局和已知攻击者对上的，单独列出来
import { DatabaseSync } from 'node:sqlite';
import {
  validateRun, aimStats, detectAutomatedDrops, scoreCurveFlag, scoreCurveExcess,
  MAX_SCORE_PER_DROP,
} from '/opt/yuanhuo/server/validate.js';

const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });
const rows = db.prepare(`SELECT r.id, r.mode, r.score, r.max_level, r.merges, r.loop_count, r.duration_ms,
    r.drops, r.trace, r.ip_hash, r.created_at, p.nickname, p.client_id, p.id AS player_id
  FROM run r JOIN player p ON p.id = r.player_id
  WHERE r.suspicious = 0 ORDER BY r.created_at`).all();

const flaggedIps = new Set(db.prepare(`SELECT DISTINCT ip_hash FROM run WHERE suspicious = 1 AND ip_hash IS NOT NULL`).all().map(r => r.ip_hash));

function parseTrace(text) {
  if (!text) return [];
  try { const t = JSON.parse(text); return Array.isArray(t) ? t : []; } catch { return []; }
}

/** 投放间隔规律性：出现最多的间隔占比（脚本会精确到毫秒；真人散得很开） */
function intervalStats(trace) {
  if (trace.length < 8) return null;
  const gaps = [];
  for (let i = 1; i < trace.length; i++) {
    const gap = trace[i].t - trace[i - 1].t;
    if (Number.isFinite(gap) && gap > 0) gaps.push(Math.round(gap));
  }
  if (!gaps.length) return null;
  const counts = new Map();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  let modal = 0, modalGap = 0;
  for (const [gap, n] of counts) if (n > modal) { modal = n; modalGap = gap; }
  gaps.sort((a, b) => a - b);
  return {
    modalShare: modal / gaps.length, modalGap,
    minGap: gaps[0], medianGap: gaps[Math.floor(gaps.length / 2)], maxGap: gaps[gaps.length - 1],
  };
}

const findings = [];
for (const row of rows) {
  const trace = parseTrace(row.trace);
  const trusted = {
    mode: row.mode, score: row.score, maxLevel: row.max_level, merges: row.merges,
    loopCount: row.loop_count, durationMs: row.duration_ms, trace,
  };
  const reasons = [];

  // ① 当前规则重判
  const verdict = validateRun(trusted);
  if (!verdict.ok) reasons.push(...verdict.flags.slice(0, 3));
  const auto = detectAutomatedDrops(trace);
  if (auto) reasons.push(`落点机械（${auto.kind}）`);
  const curve = scoreCurveFlag(row.score, row.duration_ms);
  if (curve) reasons.push(curve);
  if (trace.length >= 40 && row.score > MAX_SCORE_PER_DROP * trace.length) {
    reasons.push(`每次投放得分 ${(row.score / trace.length).toFixed(1)}`);
  }

  // ② 人味指标
  const aim = aimStats(trace);
  const gap = intervalStats(trace);
  const scorePerMerge = row.merges > 0 ? row.score / row.merges : null;
  const curveUse = row.duration_ms > 0
    ? row.score / (1200 + 4 * (row.duration_ms / 1000)) : 0;
  const suspiciousSignals = [];
  if (aim && aim.span < 907) suspiciousSignals.push(`跨度 ${aim.span.toFixed(0)}px < 907`);
  if (aim && aim.count < 158 && trace.length >= 40) suspiciousSignals.push(`落点种类 ${aim.count} < 158`);
  if (gap && gap.modalShare > 0.5 && trace.length >= 40) suspiciousSignals.push(`间隔 ${gap.modalGap}ms 占 ${(gap.modalShare * 100).toFixed(0)}%`);
  if (scorePerMerge !== null && scorePerMerge > 8.3) suspiciousSignals.push(`分数/合成 ${scorePerMerge.toFixed(2)} > 8.3`);
  if (curveUse > 0.85) suspiciousSignals.push(`用掉曲线额度 ${(curveUse * 100).toFixed(0)}%`);
  if (row.ip_hash && flaggedIps.has(row.ip_hash)) suspiciousSignals.push('与已知攻击者同 IP');

  if (reasons.length || suspiciousSignals.length) {
    findings.push({ row, reasons, signals: suspiciousSignals, aim, gap, scorePerMerge, curveUse });
  }
}

console.log(`审计 ${rows.length} 局"干净"记录（suspicious=0）`);
console.log(`其中 ${findings.filter(f => f.reasons.length).length} 局会被**当前规则**直接标记（说明是规则上线前提交的漏网记录）`);
console.log(`另有 ${findings.filter(f => !f.reasons.length && f.signals.length).length} 局规则不判但有人味上的疑点\n`);

const hard = findings.filter(f => f.reasons.length).sort((a, b) => b.row.score - a.row.score);
if (hard.length) {
  console.log('=== 当前规则会标记的漏网记录（按分数排序）===');
  for (const f of hard.slice(0, 20)) {
    const r = f.row;
    console.log(`  #${r.id} ${r.mode} ${r.score} 分 / ${(r.duration_ms / 1000).toFixed(0)} 秒 ${r.nickname || '(无名)'} [${new Date(r.created_at).toISOString().slice(5, 16)}]`);
    console.log(`      规则: ${f.reasons.join(' | ').slice(0, 150)}`);
  }
}

const soft = findings.filter(f => !f.reasons.length && f.signals.length).sort((a, b) => b.row.score - a.row.score);
if (soft.length) {
  console.log('\n=== 规则不判、但指标可疑（供你人工看）===');
  for (const f of soft.slice(0, 15)) {
    const r = f.row;
    console.log(`  #${r.id} ${r.mode} ${r.score} 分 / ${(r.duration_ms / 1000).toFixed(0)} 秒 ${r.nickname || '(无名)'}`);
    console.log(`      ${f.signals.join(' | ')}`);
  }
}
