/**
 * 导出「合成大元火」上线以来的运营数据聚合（口径已清洗）。
 *
 *   node tools/export-analytics.mjs [输出路径]
 *
 * 零依赖、只读库。三个表各自的语义：
 *   live_game  每一次「开过的局」（含中途放弃、含灾难性长局）—— 反映真实打开次数
 *   run        每一次「完赛并成功提交」—— 反映有效对局
 *   player     每个 clientId 一行 —— created_at 反映新增
 *
 * 清洗规则：
 *   1. 只统计 BOOTSTRAP_DATE 之后（上线前有 26 个开发测试账号，无开局）
 *   2. 均分/峰值分剔除 suspicious=1（10-18 混进过 999999 的伪造局）
 *   3. 完成率按「当日开局 / 当日完赛」给，但跨天会 >100%，仅作参考
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = process.env.DB_PATH || '/opt/yuanhuo/server/data/yuanhuo.db';
const BOOTSTRAP_DATE = process.env.FROM_DATE || '2026-10-17';
const db = new DatabaseSync(DB, { readOnly: true });

const TZ = 'Asia/Shanghai';
const dk = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ms)));
const hr = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(Number(ms))));
const wd = (dateStr) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(dateStr + 'T12:00:00+08:00').getDay()];

const players = db.prepare('select id, client_id, nickname, created_at, last_seen_at, banned from player').all();
const runs = db.prepare('select id, player_id, mode, score, max_level, merges, loop_count, duration_ms, drops, suspicious, created_at from run').all();
const games = db.prepare('select id, client_id, mode, started_at, updated_at, abandoned, revision, active from live_game where started_at > 0').all();

const inRange = (ms) => dk(ms) >= BOOTSTRAP_DATE;

// ── 日序列 ────────────────────────────────────────────────
const maxMs = Math.max(...games.map(g => g.started_at), ...runs.map(r => r.created_at));
const dayList = [];
for (let t = Date.parse(BOOTSTRAP_DATE + 'T00:00:00+08:00'); t <= maxMs; t += 86400000) dayList.push(dk(t));

// 首次开局日（新用户口径 B，比 player 行更贴近"真的来玩了"）
const firstGameMs = new Map();
for (const g of games) if (!firstGameMs.has(g.client_id) || g.started_at < firstGameMs.get(g.client_id)) firstGameMs.set(g.client_id, g.started_at);
const newByFirstGame = new Map();
for (const [, ms] of firstGameMs) newByFirstGame.set(dk(ms), (newByFirstGame.get(dk(ms)) || 0) + 1);

// 幽灵账号：提交过的局全部被判作弊 —— 刷分脚本的一次性 clientId。
// 它们会污染"新增用户"曲线，且天然次日留存为 0，必须单独拆出来。
const pidByClient = new Map(players.map(p => [p.client_id, p.id]));
const runStat = new Map();
for (const r of runs) {
  const s = runStat.get(r.player_id) || { total: 0, susp: 0 };
  s.total++; if (r.suspicious) s.susp++;
  runStat.set(r.player_id, s);
}
const phantomClients = new Set();
for (const [cid, ms] of firstGameMs) {
  const s = runStat.get(pidByClient.get(cid));
  if (s && s.total > 0 && s.susp === s.total) phantomClients.add(cid);
}
const phantomByDay = new Map();
for (const cid of phantomClients) phantomByDay.set(dk(firstGameMs.get(cid)), (phantomByDay.get(dk(firstGameMs.get(cid))) || 0) + 1);

const mk = () => ({ started: 0, classic: 0, endless: 0, submitted: 0, suspicious: 0, newPlayers: 0, scoreSum: 0, scoreMax: 0, cleanScoreSum: 0, cleanScoreMax: 0, cleanN: 0, durSum: 0, dropsSum: 0, mergesSum: 0, clients: new Set(), submitPids: new Set() });
const daily = new Map(dayList.map(d => [d, mk()]));

for (const g of games) {
  if (!inRange(g.started_at)) continue;
  const d = daily.get(dk(g.started_at)); if (!d) continue;
  d.started++; d.clients.add(g.client_id);
  if (g.mode === 'classic') d.classic++; else d.endless++;
}
for (const r of runs) {
  if (!inRange(r.created_at)) continue;
  const d = daily.get(dk(r.created_at)); if (!d) continue;
  d.submitted++; d.submitPids.add(r.player_id);
  d.durSum += r.duration_ms; d.dropsSum += r.drops; d.mergesSum += r.merges;
  if (r.suspicious) { d.suspicious++; continue; }
  d.cleanN++; d.cleanScoreSum += r.score; d.cleanScoreMax = Math.max(d.cleanScoreMax, r.score);
}
for (const p of players) { if (!inRange(p.created_at)) continue; const d = daily.get(dk(p.created_at)); if (d) d.newPlayers++; }

let cum = (players.filter(p => dk(p.created_at) < BOOTSTRAP_DATE)).length;
const dailyOut = dayList.map(date => {
  const x = daily.get(date);
  cum += x.newPlayers;
  return {
    date, weekday: wd(date),
    started: x.started, submitted: x.submitted,
    classic: x.classic, endless: x.endless,
    newPlayers: x.newPlayers, newByFirstGame: newByFirstGame.get(date) || 0,
    newPhantom: phantomByDay.get(date) || 0,
    activeClients: x.clients.size, activePlayers: x.submitPids.size,
    suspicious: x.suspicious,
    avgScoreClean: x.cleanN ? Math.round(x.cleanScoreSum / x.cleanN) : 0,
    maxScoreClean: x.cleanScoreMax,
    avgDurationMin: x.submitted ? +(x.durSum / x.submitted / 60000).toFixed(1) : 0,
    avgDrops: x.submitted ? Math.round(x.dropsSum / x.submitted) : 0,
    cumPlayers: cum,
  };
});

// ── 时段 ─────────────────────────────────────────────────
const hourlyOf = (list, ts, mode) => {
  const out = Array.from({ length: 24 }, () => ({ started: 0, submitted: 0, clients: new Set() }));
  for (const g of list) {
    if (mode && g.mode !== mode) continue;
    const h = hr(ts(g)); if (!inRange(ts(g))) continue;
    out[h].started++; out[h].clients.add(g.client_id);
  }
  return out;
};
const hAll = hourlyOf(games, g => g.started_at);
const hClassic = hourlyOf(games, g => g.started_at, 'classic');
const hEndless = hourlyOf(games, g => g.started_at, 'endless');
for (const r of runs) { if (!inRange(r.created_at)) continue; hAll[hr(r.created_at)].submitted++; }
const hourlyOut = hAll.map((x, h) => ({ hour: h, started: x.started, submitted: x.submitted, clients: x.clients.size, classic: hClassic[h].started, endless: hEndless[h].started }));

// ── 热力图 ───────────────────────────────────────────────
const heat = new Map();
for (const g of games) { if (!inRange(g.started_at)) continue; const k = `${dk(g.started_at)}|${hr(g.started_at)}`; heat.set(k, (heat.get(k) || 0) + 1); }
const heatmapOut = [];
for (const date of dayList) for (let h = 0; h < 24; h++) heatmapOut.push({ date, hour: h, n: heat.get(`${date}|${h}`) || 0 });

// ── 分布 ─────────────────────────────────────────────────
const bucket = (values, edges, label) => {
  const out = edges.slice(0, -1).map((e, i) => ({ label: label(e, edges[i + 1]), n: 0 }));
  for (const v of values) {
    let i = edges.findIndex((e, k) => k < edges.length - 1 && v >= e && v < edges[k + 1]);
    if (i < 0) i = edges.length - 2;
    out[i].n++;
  }
  return out;
};
const clean = runs.filter(r => !r.suspicious && inRange(r.created_at));
const scoreBuckets = bucket(clean.map(r => r.score), [0, 500, 1000, 2000, 3000, 5000, 8000, 12000, 1e9], (a, b) => b >= 1e9 ? `${a}+` : `${a}–${b}`);
const durationBuckets = bucket(clean.map(r => r.duration_ms / 1000), [0, 60, 180, 300, 600, 1200, 2400, 7200, 1e9], (a, b) => {
  const f = (s) => s >= 3600 ? `${+(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
  return b >= 1e9 ? `${f(a)}+` : `${f(a)}–${f(b)}`;
});
const dropsBuckets = bucket(clean.map(r => r.drops), [0, 50, 100, 200, 400, 800, 1600, 3200, 1e9], (a, b) => b >= 1e9 ? `${a}+` : `${a}–${b}`);

const perClient = new Map();
for (const g of games) { if (!inRange(g.started_at)) continue; perClient.set(g.client_id, (perClient.get(g.client_id) || 0) + 1); }
const playsValues = [...perClient.values()];
const playsPerPlayer = bucket(playsValues, [1, 2, 3, 4, 6, 11, 21, 51, 1e9], (a, b) => b >= 1e9 ? `${a}+` : (b - a === 1 ? `${a}` : `${a}–${b - 1}`));

// ── 留存 ─────────────────────────────────────────────────
const daysBy = new Map();
for (const g of games) { if (!daysBy.has(g.client_id)) daysBy.set(g.client_id, new Set()); daysBy.get(g.client_id).add(dk(g.started_at)); }
const cohortOf = new Map();
for (const [cid, ms] of firstGameMs) cohortOf.set(cid, dk(ms));
const retention = dayList.map((cohort, i) => {
  const members = [...cohortOf.entries()].filter(([, c]) => c === cohort).map(([cid]) => cid);
  const at = (off) => {
    const target = dayList[i + off];
    if (!target) return null;
    return +(members.filter(cid => daysBy.get(cid)?.has(target)).length / members.length * 100).toFixed(1);
  };
  return { cohort, size: members.length, d1: at(1), d3: at(3), d7: at(7) };
});

// ── 汇总 ─────────────────────────────────────────────────
const gIn = games.filter(g => inRange(g.started_at));
const rIn = runs.filter(r => inRange(r.created_at));
const cleanAll = rIn.filter(r => !r.suspicious);
const durs = cleanAll.map(r => r.duration_ms / 1000).sort((a, b) => a - b);
const pick = (p) => durs.length ? durs[Math.floor(durs.length * p)] : 0;
const peak = [...hourlyOut].sort((a, b) => b.started - a.started).slice(0, 3).map(h => h.hour);

const summary = {
  rangeStart: dayList[0], rangeEnd: dayList[dayList.length - 1], days: dayList.length,
  started: gIn.length, submitted: rIn.length,
  completionRate: +(rIn.length / gIn.length * 100).toFixed(1),
  players: players.length, namedPlayers: players.filter(p => p.nickname).length,
  uniqueClients: perClient.size,
  onceOnly: playsValues.filter(v => v === 1).length,
  onceOnlyRate: +(playsValues.filter(v => v === 1).length / playsValues.length * 100).toFixed(1),
  classic: gIn.filter(g => g.mode === 'classic').length,
  endless: gIn.filter(g => g.mode === 'endless').length,
  suspicious: rIn.filter(r => r.suspicious).length,
  suspRate: +(rIn.filter(r => r.suspicious).length / rIn.length * 100).toFixed(1),
  phantomClients: phantomClients.size,
  phantomRate: +(phantomClients.size / perClient.size * 100).toFixed(1),
  playHoursInGame: +(rIn.reduce((s, r) => s + r.duration_ms, 0) / 3600000).toFixed(1),
  durationMin: pick(0.5) / 60, durationP90: pick(0.9) / 60,
  bestScore: { classic: Math.max(0, ...cleanAll.filter(r => r.mode === 'classic').map(r => r.score)), endless: Math.max(0, ...cleanAll.filter(r => r.mode === 'endless').map(r => r.score)) },
  peakHours: peak,
};

writeFileSync(process.argv[2] || '/tmp/analytics.json', JSON.stringify({ generatedAt: new Date().toISOString(), summary, daily: dailyOut, hourly: hourlyOut, heatmap: heatmapOut, scoreBuckets, durationBuckets, dropsBuckets, playsPerPlayer, retention }, null, 1));
console.log('written', process.argv[2]);
console.log(JSON.stringify(summary, null, 1));
