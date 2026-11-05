/**
 * 生成截止时的最终榜单（双榜去重）+ 服务端要读的 final-board.json。
 *   node tools/finalize-leaderboard.mjs [输出 json]
 *
 * 去重口径（重要）：
 *   身份 = 昵称（trim 后精确匹配），不是 clientId。
 *   原因：一个人可能用两个浏览器/换设备，占了两个账号；按 clientId 去重挡不住
 *   （实测「玩家G」就是两个账号分别拿了经典#4 和无尽#4）。
 *   没起昵称的按 clientId 单独计，避免所有匿名玩家被合成一个。
 *
 * 跨榜：一人只留一个榜，归到名次更「高」的那个。
 *   名次相同时用百分位比较（名次 / 该榜总人数），百分位更靠前的那个榜胜出。
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = process.env.DB_PATH || '/opt/yuanhuo/server/data/yuanhuo.db';
const db = new DatabaseSync(DB, { readOnly: true });

/**
 * 截止时刻：只统计 created_at < CUTOFF 的提交。
 *   node tools/finalize-leaderboard.mjs <out.json> [CUTOFF]
 *   CUTOFF 可以是毫秒时间戳，也可以是 '2026-10-31T12:00:00+08:00' 这种字符串；
 *   不传 = 不设截止（统计全部）。
 */
const raw = process.argv[3] || process.env.CUTOFF || '';
const CUTOFF = raw
  ? (Number.isFinite(Number(raw)) && Number(raw) > 1e11 ? Number(raw) : Date.parse(raw))
  : 0;
if (raw && !CUTOFF) { console.error('CUTOFF 解析失败: ' + raw); process.exit(1); }
if (CUTOFF) {
  console.log('截止时刻:', new Date(CUTOFF).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), '=', CUTOFF);
}

const rowsAll = db.prepare(`
  SELECT r.player_id, p.nickname, p.client_id, r.mode, r.score, r.max_level,
         r.merges, r.loop_count, r.duration_ms, r.drops, r.created_at
  FROM run r JOIN player p ON p.id = r.player_id
  WHERE r.suspicious = 0 AND p.banned = 0
  ORDER BY r.mode, r.score DESC, r.created_at ASC
`).all();

const rows = CUTOFF ? rowsAll.filter(r => Number(r.created_at) < CUTOFF) : rowsAll;
const dropped = rowsAll.length - rows.length;
console.log(`计分局：${rows.length} 局${dropped ? `（截止后剔除 ${dropped} 局）` : ''}`);

// 身份键：有昵称用昵称，没昵称用 clientId
const ident = (r) => {
  const nick = String(r.nickname || '').trim();
  return nick ? 'n:' + nick : 'c:' + r.client_id;
};

// 每个人每模式只留最高分（同分取更早）
const best = new Map();
for (const r of rows) {
  const k = r.mode + '|' + ident(r);
  if (!best.has(k)) best.set(k, r);
}

const board = (mode) => [...best.values()]
  .filter(r => r.mode === mode)
  .sort((a, b) => b.score - a.score || a.created_at - b.created_at)
  .map((r, i) => ({
    ...r,
    key: ident(r),
    nickname: String(r.nickname || '').trim(),
    tag: r.client_id.slice(0, 4),
    rank: i + 1,
    accounts: [...new Set(rows.filter(x => ident(x) === ident(r) && x.mode === mode).map(x => x.client_id.slice(0, 4)))],
  }));

const classic = board('classic');
const endless = board('endless');

const show = (list, label, n) => {
  console.log(`\n===== ${label}（去重前 ${list.length} 人上榜）前 ${n} =====`);
  for (const r of list.slice(0, n)) {
    console.log(`  #${String(r.rank).padStart(2)}  ${String(r.score).padStart(6)} 分  「${r.nickname || '（未命名）'}」 .${r.tag}` +
      (r.accounts.length > 1 ? `  [合并账号 ${r.accounts.join('/')}]` : ''));
  }
};
show(classic, '经典', 16);
show(endless, '无尽', 16);

// ── 跨榜去重 ─────────────────────────────────────────────
const cMap = new Map(classic.map(r => [r.key, r]));
const eMap = new Map(endless.map(r => [r.key, r]));
const shared = [...cMap.keys()].filter(k => eMap.has(k)).map(k => {
  const c = cMap.get(k), e = eMap.get(k);
  const cRank = c.rank, eRank = e.rank;
  const cPct = cRank / classic.length, ePct = eRank / endless.length;
  const toClassic = cRank < eRank || (cRank === eRank && cPct <= ePct);
  return {
    key: k, nickname: c.nickname || e.nickname || '（未命名）', tag: c.tag,
    cRank, cScore: c.score, cPct: +(cPct * 100).toFixed(1),
    eRank, eScore: e.score, ePct: +(ePct * 100).toFixed(1),
    to: toClassic ? 'classic' : 'endless',
    tied: cRank === eRank,
  };
}).sort((a, b) => Math.min(a.cRank, a.eRank) - Math.min(b.cRank, b.eRank));

console.log(`\n===== 双榜都上榜：${shared.length} 人 =====`);
console.log('  （只列前 12；→ 表示最终归到哪个榜）');
for (const s of shared.slice(0, 12)) {
  console.log(`  「${s.nickname}」.${s.tag}  经典#${s.cRank}(${s.cScore}, 前${s.cPct}%) / 无尽#${s.eRank}(${s.eScore}, 前${s.ePct}%)` +
    `${s.tied ? '  ⚠名次相同→按百分位' : ''}  → ${s.to === 'classic' ? '经典' : '无尽'}`);
}
const tiedList = shared.filter(s => s.tied);
if (tiedList.length) console.log(`  名次相同的：${tiedList.map(t => `「${t.tied ? t.nickname : ''}」`).join(' ')}`);

const dropClassic = new Set(shared.filter(s => s.to === 'endless').map(s => s.key));
const dropEndless = new Set(shared.filter(s => s.to === 'classic').map(s => s.key));

const reRank = (list, drop) => list.filter(r => !drop.has(r.key)).map((r, i) => ({ ...r, finalRank: i + 1 }));
const finalClassic = reRank(classic, dropClassic);
const finalEndless = reRank(endless, dropEndless);

console.log(`\n===== 去重结果 =====`);
console.log(`  经典：${classic.length} → ${finalClassic.length} 人`);
console.log(`  无尽：${endless.length} → ${finalEndless.length} 人`);

// ── 输出 ────────────────────────────────────────────────
const toRow = (r) => ({
  rank: r.finalRank,
  nickname: r.nickname || '匿名元火人',
  tag: r.tag,
  score: r.score,
  maxLevel: r.max_level,
  at: r.created_at,
  // 以下仅给报告用，服务端忽略
  merges: r.merges,
  loopCount: r.loop_count,
  durationMin: +(r.duration_ms / 60000).toFixed(1),
  drops: r.drops,
  originalRank: r.rank,
  accounts: r.accounts,
});

const out = {
  generatedAt: new Date().toISOString(),
  cutoff: CUTOFF || null,
  cutoffLocal: CUTOFF ? new Date(CUTOFF).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : null,
  rule: '每人每模式取最高分；身份按昵称合并（无昵称按账号）；同一人只出现在一个榜，归到名次更高的那个；名次相同时比较百分位。',
  players: { classic: classic.length, endless: endless.length, moved: shared.length },
  classic: finalClassic.map(toRow),
  endless: finalEndless.map(toRow),
  moved: shared.map(s => ({ nickname: s.nickname, tag: s.tag, cRank: s.cRank, eRank: s.eRank, to: s.to, tied: s.tied })),
};

console.log(`\n===== 最终双榜前十 =====`);
for (const [mode, label] of [['classic', '经典'], ['endless', '无尽']]) {
  console.log(`\n【${label}】`);
  for (const r of out[mode].slice(0, 10)) {
    const moved = r.originalRank !== r.rank ? `  (原#${r.originalRank})` : '';
    console.log(`  ${String(r.rank).padStart(2)}.  ${String(r.score).padStart(6)} 分  「${r.nickname}」 .${r.tag}${moved}`);
  }
}

writeFileSync(process.argv[2] || '/tmp/final-board.json', JSON.stringify(out, null, 1));
console.log('\nwritten', process.argv[2] || '/tmp/final-board.json');
