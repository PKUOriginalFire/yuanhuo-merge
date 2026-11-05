import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { recoverLostRuns, RECOVER_RULE } from '../server/recover.js';

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));

/** 和 db.js / sessions.js 里的真实 DDL 对齐的最小库 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE player (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT UNIQUE NOT NULL,
      nickname TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER, banned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, mode TEXT NOT NULL,
      score INTEGER NOT NULL, max_level INTEGER NOT NULL, merges INTEGER NOT NULL,
      loop_count INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL, drops INTEGER NOT NULL DEFAULT 0,
      trace TEXT, suspicious INTEGER NOT NULL DEFAULT 0, flag_reason TEXT, ip_hash TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE live_game (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, mode TEXT NOT NULL,
      resume_key TEXT NOT NULL, lease TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
      active INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER NOT NULL DEFAULT 0,
      carry REAL NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0, start_id TEXT NOT NULL,
      result TEXT, flags TEXT, protocol INTEGER NOT NULL DEFAULT 2, sim_checks INTEGER NOT NULL DEFAULT 0,
      sim_bias REAL NOT NULL DEFAULT 0, sim_at INTEGER NOT NULL DEFAULT 0);
  `);
  return db;
}

/** 一条合法对局状态：100 次投放、每次间隔 400ms、总分 200 */
function cleanState(overrides: Record<string, unknown> = {}) {
  const tutorial = [1, 1, 2, 2, 3];
  const trace = Array.from({ length: 100 }, (_, i) => ({ t: i * 400, x: 0.2 + (i % 30) * 0.025, lv: tutorial[i] ?? 1 + (i % 3) }));
  return {
    version: 1, mode: 'classic', status: 'over', score: 200, merges: 20, loopCount: 0,
    maxLevelReached: 3, elapsed: 100 * 400, trace, balls: [],
    ...overrides,
  };
}

function addPlayer(db: DatabaseSync, clientId: string, nickname: string, banned = 0) {
  return Number(db.prepare('INSERT INTO player (client_id, nickname, created_at, banned) VALUES (?,?,?,?)')
    .run(clientId, nickname, 1000, banned).lastInsertRowid);
}

function addLive(db: DatabaseSync, clientId: string, state: unknown, updatedAt: number, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO live_game (id, client_id, mode, resume_key, lease, revision, state, active,
      updated_at, started_at, abandoned, start_id, result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, clientId, (state as { mode: string }).mode, 'k', 'l', 10, JSON.stringify(state), 0,
      updatedAt, updatedAt - 40000, extra.abandoned ?? 0, 'start', extra.result ?? null);
  return id;
}

const NOW = 1_800_000_000_000;

it('recovers a finished-but-unsubmitted run only when it passes the current rules', () => {
  const db = fixture();
  const cleanClient = 'c-clean';
  const cheatClient = 'c-cheat';
  addPlayer(db, cleanClient, '真玩家');
  addPlayer(db, cheatClient, '伪造者');
  const cleanId = addLive(db, cleanClient, cleanState(), NOW - 20 * 60_000);
  // 编造：分数远超理论上界（100 次投放最多折算 ~100 单位）
  const cheatId = addLive(db, cheatClient, cleanState({ score: 99999 }), NOW - 20 * 60_000);

  const result = recoverLostRuns(db, NOW);
  expect(result.recovered).toHaveLength(1);
  expect(result.recovered[0].liveId).toBe(cleanId);
  expect(result.recovered[0].score).toBe(200);
  expect(result.recovered[0].drops).toBe(100);

  const rows = db.prepare('SELECT player_id, score, suspicious, trace FROM run').all() as { player_id: number; score: number; suspicious: number }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].score).toBe(200);
  expect(rows[0].suspicious).toBe(0);
  // 伪造那条不写库，但也没被塞进 run
  expect(rows.some(r => r.score === 99999)).toBe(false);
  expect(result.skipped.some(s => s.id === cheatId)).toBe(true);
});

it('is idempotent: a second pass does not duplicate, and a late client submit sees the stored result', () => {
  const db = fixture();
  const clientId = 'c-1';
  addPlayer(db, clientId, '真玩家');
  const liveId = addLive(db, clientId, cleanState({ score: 250 }), NOW - 20 * 60_000);

  const first = recoverLostRuns(db, NOW);
  expect(first.recovered).toHaveLength(1);
  expect((db.prepare('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(1);

  // 第二遍：live 行的 result 已经写上，SQL 条件就把它排除了
  const second = recoverLostRuns(db, NOW + 60_000);
  expect(second.recovered).toHaveLength(0);
  expect((db.prepare('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(1);

  const result = JSON.parse((db.prepare('SELECT result FROM live_game WHERE id=?').get(liveId) as { result: string }).result);
  expect(result.recovered).toBe(true);
  expect(result.runId).toBe(first.recovered[0].runId);
});

it('leaves fresh runs alone, skips banned players and empty runs', () => {
  const db = fixture();
  addPlayer(db, 'c-fresh', '刚打完');
  addPlayer(db, 'c-banned', '被封的', 1);
  addPlayer(db, 'c-empty', '空局');
  const freshId = addLive(db, 'c-fresh', cleanState(), NOW - 60_000);          // 1 分钟前才结束
  const bannedId = addLive(db, 'c-banned', cleanState(), NOW - 20 * 60_000);
  const emptyId = addLive(db, 'c-empty', cleanState({ score: 0 }), NOW - 20 * 60_000);

  const result = recoverLostRuns(db, NOW);
  expect(result.recovered).toHaveLength(0);
  // 未到 minAge 的根本不在扫描结果里
  expect(result.skipped.some(s => s.id === freshId)).toBe(false);
  expect(result.skipped.find(s => s.id === bannedId)?.why).toMatch(/封禁/);
  expect(result.skipped.find(s => s.id === emptyId)?.why).toMatch(/空对局/);
  expect((db.prepare('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(0);
});

it('does not double-insert when the normal submit already landed', () => {
  const db = fixture();
  const clientId = 'c-dup';
  const playerId = addPlayer(db, clientId, '已提交');
  // 正常提交已经写过一条完全相同的成绩（分数 + 时长一致）
  db.prepare(`INSERT INTO run (player_id, mode, score, max_level, merges, loop_count, duration_ms,
      drops, trace, suspicious, flag_reason, ip_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,NULL,NULL,?)`)
    .run(playerId, 'classic', 200, 3, 20, 0, 40000, 100, '[]', NOW - 19 * 60_000);
  const liveId = addLive(db, clientId, cleanState(), NOW - 20 * 60_000);

  const result = recoverLostRuns(db, NOW);
  expect(result.recovered).toHaveLength(0);
  expect((db.prepare('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(1);
  expect(result.skipped.find(s => s.id === liveId)?.why).toMatch(/已入库/);
  // 顺便把这行的 result 补上，避免每分钟重复扫
  expect((db.prepare('SELECT result FROM live_game WHERE id=?').get(liveId) as { result: string | null }).result).not.toBeNull();
});

it('refuses to auto-write runs whose early-game rate is faster than any real player', () => {
  // 恢复是"替玩家写库"，所以门槛比标记更严：除了分数曲线（带 1200 截距、小局永远合规），
  // 再要求每秒得分 ≤ 8（生产库真人峰值 6.95 分/秒）。
  // 实测被这条挡下的是那局 330 分 / 31 秒（10.78 分/秒）的测试账号记录。
  const db = fixture();
  addPlayer(db, 'c-smoke', '测试账号');
  // 61 次投放 / 30 秒、330 分 —— 分数曲线因为截距放行，但 11 分/秒 不属于真人
  const trace = Array.from({ length: 61 }, (_, i) => ({ t: i * 490, x: 0.17 + (i % 60) * 0.011, lv: [1, 1, 2, 2, 3][i] ?? 1 + (i % 3) }));
  const liveId = addLive(db, 'c-smoke', {
    version: 1, mode: 'endless', status: 'over', score: 330, merges: 60, loopCount: 0,
    maxLevelReached: 3, elapsed: 30_000, trace, balls: [],
  }, NOW - 20 * 60_000);

  const result = recoverLostRuns(db, NOW);
  expect(result.recovered).toHaveLength(0);
  expect(result.skipped.find(s => s.id === liveId)?.why).toMatch(/分\/秒 超过恢复门槛/);
  expect((db.prepare('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(0);
});

it('respects the batch cap so one bad hour cannot flood the leaderboard', () => {
  const db = fixture();
  for (let i = 0; i < 8; i++) {
    addPlayer(db, 'c-' + i, '玩家' + i);
    addLive(db, 'c-' + i, cleanState({ score: 200 + i }), NOW - (20 + i) * 60_000);
  }
  const result = recoverLostRuns(db, NOW, { ...RECOVER_RULE, maxRows: 3 });
  expect(result.scanned).toBe(3);
  expect(result.recovered).toHaveLength(3);
});
