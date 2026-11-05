import { DatabaseSync } from 'node:sqlite';
import { validateRun, scoreCurveFlag } from './validate.js';

/**
 * 兜底抢救："已经打完(over)但从未提交成功(result IS NULL)"的对局。
 *
 * 为什么需要这个：客户端提交成绩失败时**只会在结果页提示一句，没有重试**，
 * 玩家的完整对局数据只留在 `live_game` 里，随后被下一局顶成 abandoned，
 * 一旦 tab 关掉就永久丢失。2026-10-19 就是 `/api/run/submit` 的
 * `client_max_body_size 64k` 把 79KB 的提交包挡掉（413），
 * 丢掉了一局无尽 13527 分（本可上第 2 名）。那次是人工从 `live_game` 里救回来的。
 *
 * 兜底原则：
 *  · 只写"当前规则下完全干净"的成绩（`validateRun` 无 flags + 分数曲线正常 + 分数 > 0 + 有 trace）
 *  · 有任何 flags 就**不写**，只在日志里留一条，等人工判断（绝不替人下结论）
 *  · 幂等：先按 (player_id, mode, score, duration_ms) 查重；
 *    写成功后把 `live_game.result` 填成一个"已恢复"的结果，
 *    这样客户端事后补交会直接拿到这个结果（不会重复入库），兜底本身也不会重复执行
 *  · 结束不满 `minAgeMs` 的局不动手 —— 给客户端正常提交留时间
 */
export const RECOVER_RULE = {
  minAgeMs: 10 * 60 * 1000,       // 结束后至少 10 分钟还没提交才动手
  maxAgeMs: 14 * 86400 * 1000,    // 超过 14 天的行交给清库逻辑，不管
  maxRows: 50,                    // 单次最多抢救多少局
  traceLimit: 20000,              // 和后端 TRACE_VERIFY_MAX 一致
  traceStoreMax: 200_000,         // 和后端 TRACE_STORE_MAX 一致
  /**
   * 恢复专用的严格门槛：每秒得分 > 8 就不救。
   *
   * 比 `scoreCurveFlag`（1200 + 4×秒，带截距）严得多 —— 截距让小局永远合规，
   * 而自动写库比"标记"更不可逆，所以这里只认"短局里也像真人"的成绩。
   * 标定：生产库真人峰值 6.95 分/秒（165 秒那局）、中位 1.5；8 有 1.15 倍余量。
   * 实测挡下的例子：一局 330 分 / 31 秒（10.78 分/秒）的测试账号记录。
   */
  maxScorePerSecond: 8,
};

/**
 * 扫一遍并抢救。返回 { scanned, recovered, skipped }，只读不改数据库结构。
 * @param {DatabaseSync} db
 * @param {number} now
 * @param {typeof RECOVER_RULE} rule
 */
export function recoverLostRuns(db, now = Date.now(), rule = RECOVER_RULE) {
  const candidates = db.prepare(`SELECT l.id, l.client_id, l.mode AS lmode, l.updated_at, l.abandoned,
      l.sim_checks, l.sim_bias, l.state, p.id AS player_id, p.nickname, p.banned
    FROM live_game l JOIN player p ON p.client_id = l.client_id
    WHERE json_extract(l.state,'$.status') = 'over'
      AND l.result IS NULL
      AND l.updated_at <= ?
      AND l.updated_at >= ?
    ORDER BY l.updated_at ASC
    LIMIT ?`).all(now - rule.minAgeMs, now - rule.maxAgeMs, rule.maxRows);

  const recovered = [];
  const skipped = [];
  for (const row of candidates) {
    let state;
    try { state = JSON.parse(row.state); } catch { skipped.push({ id: row.id, why: 'state 解析失败' }); continue; }
    const trace = Array.isArray(state.trace) ? state.trace : [];

    if (row.banned) { skipped.push({ id: row.id, why: '玩家已被封禁', score: state.score }); continue; }
    if (!(state.score > 0) || !trace.length) { skipped.push({ id: row.id, why: '空对局', score: state.score }); continue; }
    if (!Number.isFinite(state.elapsed) || state.elapsed <= 0) { skipped.push({ id: row.id, why: 'elapsed 非法' }); continue; }

    const durationMs = Math.round(state.elapsed);
    const dup = db.prepare('SELECT id FROM run WHERE player_id=? AND mode=? AND score=? AND duration_ms=?')
      .get(row.player_id, state.mode, state.score, durationMs);
    if (dup) {
      // 已经入库过（正常提交或之前救过）—— 把 live 行补上 result，免得每次都被扫出来
      markResult(db, row.id, { ok: true, rank: null, improved: false, promptSignature: false, recovered: true, runId: dup.id });
      skipped.push({ id: row.id, why: `已入库 run#${dup.id}`, score: state.score });
      continue;
    }

    const verdict = validateRun({
      mode: state.mode, score: state.score, maxLevel: state.maxLevelReached, merges: state.merges,
      loopCount: state.loopCount, durationMs, trace,
    });
    if (verdict.flags.length) {
      skipped.push({ id: row.id, why: '校验有标记，转人工：' + verdict.flags.join(' | ').slice(0, 160), score: state.score });
      continue;
    }
    const curve = scoreCurveFlag(state.score, state.elapsed);
    if (curve) { skipped.push({ id: row.id, why: '分数曲线：' + curve, score: state.score }); continue; }
    const perSecond = state.score / (state.elapsed / 1000);
    if (perSecond > rule.maxScorePerSecond) {
      skipped.push({
        id: row.id, score: state.score,
        why: `${perSecond.toFixed(2)} 分/秒 超过恢复门槛 ${rule.maxScorePerSecond}（真人峰值 6.95）`,
      });
      continue;
    }

    const stored = trace.slice(0, rule.traceLimit);
    const traceStr = JSON.stringify(stored).slice(0, rule.traceStoreMax);
    const info = db.prepare(`INSERT INTO run (player_id, mode, score, max_level, merges, loop_count,
        duration_ms, drops, trace, suspicious, flag_reason, ip_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`).run(
      row.player_id, state.mode, state.score, state.maxLevelReached, state.merges, state.loopCount,
      durationMs, stored.length, traceStr, row.updated_at,   // created_at 用结束时间，榜单时间才对
    );
    const runId = Number(info.lastInsertRowid);
    markResult(db, row.id, { ok: true, rank: null, improved: false, promptSignature: false, recovered: true, runId });
    recovered.push({
      runId, liveId: row.id, nickname: row.nickname, mode: state.mode, score: state.score,
      durationMs, drops: stored.length, abandoned: row.abandoned, simChecks: row.sim_checks, simBias: row.sim_bias,
    });
  }
  return { scanned: candidates.length, recovered, skipped };
}

function markResult(db, liveId, payload) {
  db.prepare('UPDATE live_game SET result=? WHERE id=? AND result IS NULL').run(JSON.stringify(payload), liveId);
}
