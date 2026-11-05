/**
 * 抽取安全/反作弊侧的真实统计，供报告使用。
 *   node tools/export-security-stats.mjs [输出路径]
 *
 * flag_reason 是自由文本（每条 reason 用 | 分隔），这里按「信号来源」归成 17 类，
 * 分类顺序 = 报告里表格的顺序。审计追认、红队标注这类人工加的标签单独计数。
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = process.env.DB_PATH || '/opt/yuanhuo/server/data/yuanhuo.db';
const db = new DatabaseSync(DB, { readOnly: true });
const dk = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ms)));
const FROM = '2026-10-17';

const runs = db.prepare('select id, player_id, mode, score, max_level, merges, loop_count, duration_ms, drops, suspicious, flag_reason, created_at from run').all().filter(r => dk(r.created_at) >= FROM);
const games = db.prepare('select client_id, started_at from live_game where started_at > 0').all().filter(g => dk(g.started_at) >= FROM);
const live = db.prepare("select id, client_id, mode, revision, state_writes, wide_writes, sim_checks, sim_bias, sim_attempts, sim_cooldown, line_hold_ms, flags, length(state) bytes from live_game where flags is not null and flags != ''").all();

const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ── 每日 ────────────────────────────────────────────────
const dayList = [];
const maxMs = Math.max(...runs.map(r => r.created_at));
for (let t = Date.parse(FROM + 'T00:00:00+08:00'); t <= maxMs; t += 86400000) dayList.push(dk(t));
const byDay = new Map(dayList.map(d => [d, { total: 0, flagged: 0 }]));
for (const r of runs) { const d = byDay.get(dk(r.created_at)); if (!d) continue; d.total++; if (r.suspicious) d.flagged++; }
const daily = dayList.map(d => ({ date: d, total: byDay.get(d).total, flagged: byDay.get(d).flagged, rate: +(byDay.get(d).flagged / Math.max(1, byDay.get(d).total) * 100).toFixed(1) }));

// ── 判据归类 ────────────────────────────────────────────
const GROUPS = [
  ['落点 / 节拍（自动投放）', /自动投放/],
  ['终局没有球压过死亡线', /终局但没有球压过死亡线/],
  ['终局球间距异常（改球半径）', /终局球间距异常/],
  ['球数守恒', /球数守恒/],
  ['单位守恒', /单位守恒/],
  ['合成 / 循环次数超过台账上界', /(合成|循环)\s*\d+\s*次(超过台账上界|多于合成|，但只投放)/],
  ['分数超过台账上界', /分数\s*\d+\s*超过台账上界/],
  ['分数超过理论上界', /超过理论上界/],
  ['每次投放得分超经验上界', /每次投放得分/],
  ['球等级序列不符', /第\s*\d+\s*球应为等级/],
  ['最高等级与单位数不符', /上报最高等级/],
  ['投放间隔过密（<390ms）', /投放间隔\s*\d+\s*处/],
  ['存档节奏异常 / 存档间隔过长', /存档节奏异常|存档间隔过长/],
  ['规避物理推演', /规避物理推演/],
  ['物理推演不一致（4σ）', /物理推演不一致/],
  ['分数增长过快（曲线超包络）', /分数增长过快|分数增长/],
  ['球阵悬空', /球阵悬空/],
  ['其他结构性', /对局时长非法|缺少操作序列|球位置跳变|超出时长允许|压线后迟迟不结束/],
];
const groupHits = new Map(GROUPS.map(([k]) => [k, 0]));
const manualTags = { 授权渗透测试: 0, 红队靶场: 0, 审计追认: 0, 阶梯阈值判定: 0, 管理员复核: 0 };
let multiReason = 0;
const unmatched = new Map();
for (const r of runs) {
  if (!r.suspicious || !r.flag_reason) continue;
  const reasons = r.flag_reason.split('|').map(s => s.trim()).filter(Boolean);
  if (reasons.length > 1) multiReason++;
  let hit = false;
  for (const [name, re] of GROUPS) if (reasons.some(s => re.test(s))) { groupHits.set(name, groupHits.get(name) + 1); hit = true; }
  if (reasons.some(s => /授权渗透测试/.test(s))) manualTags.授权渗透测试++;
  if (reasons.some(s => /红队靶场/.test(s))) manualTags.红队靶场++;
  if (reasons.some(s => /审计追认/.test(s))) manualTags.审计追认++;
  if (reasons.some(s => /阶梯阈值判定/.test(s))) manualTags.阶梯阈值判定++;
  if (reasons.some(s => /复核/.test(s))) manualTags.管理员复核++;
  if (!hit) for (const s of reasons) unmatched.set(s.slice(0, 60), (unmatched.get(s.slice(0, 60)) || 0) + 1);
}
const rules = [...groupHits.entries()].filter(([, n]) => n > 0).map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n);

// ── 画像 ────────────────────────────────────────────────
const clean = runs.filter(r => !r.suspicious), dirty = runs.filter(r => r.suspicious);
const mk = (set) => ({
  n: set.length,
  scoreMed: q(set.map(r => r.score), .5),
  scoreP90: q(set.map(r => r.score), .9),
  dropsMed: q(set.map(r => r.drops), .5),
  durMedMin: +(q(set.map(r => r.duration_ms), .5) / 60000).toFixed(1),
  scorePerDropMed: +q(set.map(r => r.score / Math.max(1, r.drops)), .5).toFixed(2),
  scorePerDropMax: +Math.max(...set.map(r => r.score / Math.max(1, r.drops))).toFixed(2),
});

// ── 玩家维度 ────────────────────────────────────────────
const byPid = new Map();
for (const r of runs) { const s = byPid.get(r.player_id) || { n: 0, bad: 0, maxScore: 0 }; s.n++; if (r.suspicious) { s.bad++; s.maxScore = Math.max(s.maxScore, r.score); } byPid.set(r.player_id, s); }
const cheaters = [...byPid.entries()].filter(([, v]) => v.bad > 0);
const repeat = cheaters.filter(([, v]) => v.bad > 1).map(([pid, v]) => ({ playerId: pid, submissions: v.bad, maxScore: v.maxScore })).sort((a, b) => b.submissions - a.submissions);

// ── 散点（分数 vs 落球）──────────────────────────────────
const scatter = runs.filter(r => r.drops > 0 && r.score > 0).map(r => ({ d: r.drops, s: r.score, bad: r.suspicious ? 1 : 0 }));

// ── live_game 防御信号 ──────────────────────────────────
const sim = live.filter(x => (x.sim_attempts ?? 0) > 0);
const writes = live.filter(x => (x.state_writes ?? 0) > 0);

const out = {
  generatedAt: new Date().toISOString(),
  range: { from: FROM, to: dayList[dayList.length - 1], days: dayList.length },
  daily,
  totals: {
    submitted: runs.length, flagged: dirty.length, clean: clean.length,
    flagRate: +(dirty.length / runs.length * 100).toFixed(1),
    allPlayers: byPid.size, flaggedPlayers: cheaters.length,
    playerFlagRate: +(cheaters.length / byPid.size * 100).toFixed(1),
    repeatCheaters: repeat.length,
    multiReasonRuns: multiReason,
    liveFlagged: live.length,
  },
  rules, manualTags,
  unmatchedReasons: [...unmatched.entries()].slice(0, 6),
  profile: { clean: mk(clean), dirty: mk(dirty) },
  repeatCheaters: repeat.slice(0, 8),
  scatter,
  simStats: {
    sessions: sim.length,
    checksAvg: +avg(sim.map(x => x.sim_checks ?? 0)).toFixed(0),
    attemptsAvg: +avg(sim.map(x => x.sim_attempts ?? 0)).toFixed(0),
    cooldownRatioAvgPct: +(avg(sim.map(x => (x.sim_cooldown ?? 0) / Math.max(1, x.sim_attempts ?? 1))) * 100).toFixed(1),
    stateWritesAvg: +avg(writes.map(x => x.state_writes ?? 0)).toFixed(0),
    wideWritesAvg: +avg(writes.map(x => x.wide_writes ?? 0)).toFixed(1),
    wideRatioAvgPct: +(avg(writes.map(x => (x.wide_writes ?? 0) / Math.max(1, x.state_writes ?? 1))) * 100).toFixed(1),
  },
};

writeFileSync(process.argv[2] || '/tmp/security-stats.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ totals: out.totals, rules: out.rules, manualTags: out.manualTags, unmatched: out.unmatchedReasons, profile: out.profile }, null, 1));
