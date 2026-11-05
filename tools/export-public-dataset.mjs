/**
 * 生成可公开的匿名游玩数据集。
 *   node tools/export-public-dataset.mjs [输出 json]
 *
 * 脱敏规则：
 *   - 玩家身份全部替换成 p0001 / p0002 …（按首次提交时间排序，与真实 id 无关）
 *   - 昵称、clientId、ip_hash、trace 一律不导出
 *   - 时间统一成 ISO 字符串（Asia/Shanghai 无时区歧义，直接给 UTC ISO）
 *   - 排行榜名次保留分数与统计量，昵称换成匿名编号
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = process.env.DB_PATH || '/opt/yuanhuo/server/data/yuanhuo.db';
const db = new DatabaseSync(DB, { readOnly: true });
const iso = (ms) => new Date(Number(ms)).toISOString();

const runs = db.prepare(`
  select r.player_id, r.mode, r.score, r.max_level, r.merges, r.loop_count,
         r.duration_ms, r.drops, r.suspicious, r.created_at
  from run r join player p on p.id = r.player_id
  where p.banned = 0
  order by r.created_at asc
`).all();

// 匿名编号：按首次提交时间分配
const ref = new Map();
let seq = 0;
for (const r of runs) {
  if (!ref.has(r.player_id)) ref.set(r.player_id, 'p' + String(++seq).padStart(4, '0'));
}

const outRuns = runs.map(r => ({
  player: ref.get(r.player_id),
  mode: r.mode,
  score: Number(r.score),
  maxLevel: Number(r.max_level),
  merges: Number(r.merges),
  loopCount: Number(r.loop_count),
  durationMs: Number(r.duration_ms),
  drops: Number(r.drops),
  flagged: Number(r.suspicious) === 1,
  submittedAt: iso(r.created_at),
}));

// 每人每模式最高分（与排行榜同一口径），再跨榜去重
const ident = new Map();   // playerId -> anon
for (const [pid, a] of ref) ident.set(pid, a);
const bestByMode = { classic: new Map(), endless: new Map() };
for (const r of runs) {
  if (r.suspicious) continue;
  const m = bestByMode[r.mode];
  const cur = m.get(r.player_id);
  if (!cur || r.score > cur.score || (r.score === cur.score && r.created_at < cur.created_at)) {
    m.set(r.player_id, { score: Number(r.score), maxLevel: Number(r.max_level), merges: Number(r.merges), createdAt: Number(r.created_at) });
  }
}
const board = (mode) => [...bestByMode[mode].entries()]
  .map(([pid, v]) => ({ player: ident.get(pid), ...v }))
  .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
  .map((v, i) => ({ rank: i + 1, ...v }));

const classic = board('classic');
const endless = board('endless');
const cKeys = new Set(classic.map(r => r.player));
const eKeys = new Set(endless.map(r => r.player));
const both = [...cKeys].filter(k => eKeys.has(k));
const cRank = new Map(classic.map(r => [r.player, r.rank]));
const eRank = new Map(endless.map(r => [r.player, r.rank]));
const dropC = new Set(both.filter(k => eRank.get(k) < cRank.get(k)).map(k => k));
const dropE = new Set(both.filter(k => cRank.get(k) <= eRank.get(k)).map(k => k));
const final = (list, drop) => list.filter(r => !drop.has(r.player)).map((r, i) => ({ ...r, finalRank: i + 1, createdAt: undefined }));

outRuns.sort((a, b) => a.submittedAt < b.submittedAt ? -1 : 1);

const out = {
  generatedAt: new Date().toISOString(),
  source: '合成大元火（元火动漫社）线上比赛全量提交记录',
  period: { from: outRuns[0]?.submittedAt, to: outRuns[outRuns.length - 1]?.submittedAt },
  privacy: '玩家身份已替换为匿名编号（p0001…，按首次提交时间排序）。不含昵称、设备标识、IP 或操作序列。',
  counts: {
    submissions: outRuns.length,
    players: seq,
    flagged: outRuns.filter(r => r.flagged).length,
    classic: outRuns.filter(r => r.mode === 'classic').length,
    endless: outRuns.filter(r => r.mode === 'endless').length,
  },
  runs: outRuns,
  board: {
    classic: final(classic, dropC),
    endless: final(endless, dropE),
    rule: '每人每模式取最高分；同一人只出现在一个榜（归到名次更高的那个，名次相同比百分位）。',
  },
};
out.board.classic = out.board.classic.slice(0, 100);
out.board.endless = out.board.endless.slice(0, 100);

writeFileSync(process.argv[2] || '/tmp/public-dataset.json', JSON.stringify(out, null, 1));
console.log('counts:', JSON.stringify(out.counts));
console.log('period:', out.period.from, '→', out.period.to);
console.log('board sizes:', out.board.classic.length, '/', out.board.endless.length);
console.log('bytes:', JSON.stringify(out).length);
