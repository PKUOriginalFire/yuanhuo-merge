/**
 * 数据层 —— node:sqlite（Node 22.5+ 内置），不需要编译原生模块。
 *
 * 两台表：player（匿名身份+签名）、run（每一局）。
 * 单文件数据库，放 server/data/yuanhuo.db，备份就是复制这一个文件。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(HERE, 'data', 'yuanhuo.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  -- 多进程（server/cluster.js 起多个 worker）时会并发写同一个库文件。
  -- 没有 busy_timeout 的话，第二个写入者会直接抛 SQLITE_BUSY，
  -- 表现就是玩家存档随机 500。5 秒足够排队。
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS player (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id    TEXT    UNIQUE NOT NULL,
    nickname     TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    banned       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS run (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    mode        TEXT    NOT NULL,
    score       INTEGER NOT NULL,
    max_level   INTEGER NOT NULL,
    merges      INTEGER NOT NULL,
    loop_count  INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    drops       INTEGER NOT NULL DEFAULT 0,
    trace       TEXT,
    suspicious  INTEGER NOT NULL DEFAULT 0,
    flag_reason TEXT,
    ip_hash     TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_run_mode_score ON run(mode, score DESC);
  CREATE INDEX IF NOT EXISTS idx_run_player     ON run(player_id, mode);
  CREATE INDEX IF NOT EXISTS idx_run_created    ON run(created_at DESC);
  -- /api/stats 里有 COUNT(*) WHERE suspicious=1，没索引就是全表扫描。
  -- 单线程 Node 里一个慢查询会阻塞所有请求。
  CREATE INDEX IF NOT EXISTS idx_run_suspicious ON run(suspicious);

  -- 签名改动历史，方便事后追责（改签名不影响已提交的成绩归属）
  CREATE TABLE IF NOT EXISTS nickname_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    nickname   TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// ────────────────────────────────────────── player

const Q = {
  playerByClient: db.prepare('SELECT * FROM player WHERE client_id = ?'),
  playerById: db.prepare('SELECT * FROM player WHERE id = ?'),
  insertPlayer: db.prepare(
    'INSERT INTO player (client_id, nickname, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ),
  touchPlayer: db.prepare('UPDATE player SET last_seen_at = ? WHERE id = ?'),
  setNickname: db.prepare('UPDATE player SET nickname = ?, last_seen_at = ? WHERE id = ?'),
  logNickname: db.prepare(
    'INSERT INTO nickname_log (player_id, nickname, created_at) VALUES (?, ?, ?)',
  ),
  countNickname: db.prepare(
    'SELECT COUNT(*) AS n FROM player WHERE nickname = ? AND id != ? AND banned = 0',
  ),

  insertRun: db.prepare(`
    INSERT INTO run (player_id, mode, score, max_level, merges, loop_count,
                     duration_ms, drops, trace, suspicious, flag_reason, ip_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  /**
   * 排行榜：每个玩家只取自己在该模式的最高分。
   * 同分时"更早达成"的排前面 —— 经典模式有分数天花板，同分会很多，这个 tiebreak 必须有。
   */
  leaderboard: db.prepare(`
    SELECT nickname, tag, score, max_level, at FROM (
      SELECT p.nickname                                   AS nickname,
             substr(p.client_id, 1, 4)                    AS tag,
             r.score                                      AS score,
             r.max_level                                  AS max_level,
             r.created_at                                 AS at,
             ROW_NUMBER() OVER (
               PARTITION BY r.player_id
               ORDER BY r.score DESC, r.created_at ASC
             )                                            AS rn
      FROM run r
      JOIN player p ON p.id = r.player_id
      WHERE r.mode = ? AND r.suspicious = 0 AND p.banned = 0
    )
    WHERE rn = 1
    ORDER BY score DESC, at ASC
    LIMIT ?
  `),

  /** 某玩家在某模式的最高分（未上榜时用来算"差多少"） */
  playerBest: db.prepare(
    'SELECT MAX(score) AS best FROM run WHERE player_id = ? AND mode = ? AND suspicious = 0',
  ),

  /** 名次：比我分高的玩家数 + 1 */
  rankOf: db.prepare(`
    WITH best AS (
      SELECT player_id, MAX(score) AS score, MIN(created_at) AS at
      FROM run
      WHERE mode = ? AND suspicious = 0
      GROUP BY player_id
    )
    SELECT COUNT(*) + 1 AS rank
    FROM best
    WHERE score > ? OR (score = ? AND at < ?)
  `),

  /** 这个玩家的这条成绩能不能进前 N（用于决定弹不弹签名框） */
  totalPlayers: db.prepare(
    'SELECT COUNT(DISTINCT player_id) AS n FROM run WHERE mode = ? AND suspicious = 0',
  ),

  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM player)                       AS players,
      (SELECT COUNT(*) FROM run)                          AS runs,
      (SELECT COUNT(*) FROM run WHERE suspicious = 1)     AS flagged,
      (SELECT COALESCE(MAX(score), 0) FROM run WHERE mode = 'classic' AND suspicious = 0) AS best_classic,
      (SELECT COALESCE(MAX(score), 0) FROM run WHERE mode = 'endless' AND suspicious = 0) AS best_endless
  `),

  /** 后台用：列出可疑记录 */
  flaggedRuns: db.prepare(`
    SELECT r.id, r.mode, r.score, r.max_level, r.drops, r.duration_ms,
           r.flag_reason, r.created_at, p.nickname, substr(p.client_id, 1, 8) AS cid
    FROM run r JOIN player p ON p.id = r.player_id
    WHERE r.suspicious = 1
    ORDER BY r.created_at DESC
    LIMIT ?
  `),
  clearFlag: db.prepare('UPDATE run SET suspicious = 0, flag_reason = NULL WHERE id = ?'),
  setBan: db.prepare('UPDATE player SET banned = ? WHERE id = (SELECT player_id FROM run WHERE id = ?)'),
};

export function getOrCreatePlayer(clientId) {
  const now = Date.now();
  let p = Q.playerByClient.get(clientId);
  if (!p) {
    const r = Q.insertPlayer.run(clientId, '', now, now);
    p = Q.playerById.get(Number(r.lastInsertRowid));
  } else {
    Q.touchPlayer.run(now, p.id);
  }
  return p;
}

export function setNickname(playerId, nickname) {
  const now = Date.now();
  Q.setNickname.run(nickname, now, playerId);
  Q.logNickname.run(playerId, nickname, now);
}

/** 重名检查：允许重名，但会提示；这里只统计同名人数给前端做提示 */
export function nicknameTaken(nickname, playerId) {
  const r = Q.countNickname.get(nickname, playerId);
  return r ? Number(r.n) : 0;
}

export function insertRun(row) {
  const r = Q.insertRun.run(
    row.playerId, row.mode, row.score, row.maxLevel, row.merges, row.loopCount,
    row.durationMs, row.drops, row.trace,
    row.suspicious ? 1 : 0, row.flagReason || null, row.ipHash || null, Date.now(),
  );
  return Number(r.lastInsertRowid);
}

export function leaderboard(mode, limit) {
  return Q.leaderboard.all(mode, limit).map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname || '匿名元火人',
    tag: r.tag || 'anon',
    score: Number(r.score),
    maxLevel: Number(r.max_level),
    at: Number(r.at),
  }));
}

export function rankOf(mode, score, createdAt) {
  const r = Q.rankOf.get(mode, score, score, createdAt);
  return r ? Number(r.rank) : null;
}

export function playerBest(playerId, mode) {
  const r = Q.playerBest.get(playerId, mode);
  return r && r.best != null ? Number(r.best) : 0;
}

export function totalPlayers(mode) {
  const r = Q.totalPlayers.get(mode);
  return r ? Number(r.n) : 0;
}

export function stats() {
  return Q.stats.get();
}

export function flaggedRuns(limit = 100) {
  return Q.flaggedRuns.all(limit);
}

export function clearFlag(runId) {
  Q.clearFlag.run(runId);
}

export function setBan(runId, banned) {
  Q.setBan.run(banned ? 1 : 0, runId);
}

export { DB_PATH };
