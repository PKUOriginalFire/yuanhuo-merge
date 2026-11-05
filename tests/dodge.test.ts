import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Game as ClientGame } from '../web/src/game';
import { Game as SimGame } from '../server/sim/game.js';
import { createRunSessions, dodgeFlag, DODGE_RULE } from '../server/sessions.js';

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));

it('flags a client whose saves are mostly wider than the replay window', () => {
  // 纯函数：8 次以上存档里，宽窗口(>3 秒)占一半 → 判定在躲物理推演
  expect(dodgeFlag({ writes: 60, wide: 60, spanMs: 540_000 })).toMatch(/疑似规避物理推演/);
  expect(dodgeFlag({ writes: 60, wide: 40, spanMs: 540_000 })).toMatch(/疑似规避物理推演/);   // 67%
  // 真人：存档密集，宽窗口只来自网络失败
  expect(dodgeFlag({ writes: 300, wide: 2, spanMs: 600_000 })).toBe('');
  expect(dodgeFlag({ writes: 60, wide: 0, spanMs: 120_000 })).toBe('');
  // 样本不足不下结论
  expect(dodgeFlag({ writes: 5, wide: 5, spanMs: 45_000 })).toBe('');
  // 存档次数少但跨度长 → 速率判据接住（真人 31–126 次/分）
  expect(dodgeFlag({ writes: 20, wide: 0, spanMs: 300_000 })).toMatch(/存档间隔过长/);
  // 短跨度不套速率判据（避免刚开局就误判）
  expect(dodgeFlag({ writes: 8, wide: 0, spanMs: 60_000 })).toBe('');
});

it('reproduces the red-team bypass and closes it: 60 saves 9s apart, resume spam inflating revision', async () => {
  // 2026-10-19 红队实测：增量校验只认 ≤3 秒窗口，而 cadenceFlag 用 revision，
  // resume 每次也 +1 —— 于是 60 次真 checkpoint（间隔 9 秒）之间插 259 次 resume，
  // 节奏算出来 22 次/分过关，sim_checks 恒为 0，4597 分毫无标记地上榜。
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100_000;
  const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 0, minIntervalMs: 0, maxChecks: 200 } });
  const run = sessions.start('dodge-client', 'classic', 'start-dodge', 2);
  let reply = run;
  const base = JSON.parse(JSON.stringify(run.state));
  let elapsed = 0;
  for (let i = 0; i < 60; i++) {
    elapsed += 9000;                                  // 窗口 9 秒 → 重放一定被跳过
    time += 9000;
    const state = { ...base, elapsed, now: elapsed, engineTime: elapsed, dropCooldownUntil: elapsed };
    reply = sessions.checkpoint('dodge-client', { ...reply, state, active: true, requestId: crypto.randomUUID() });
    // 每次真存档之间插 4 次 resume（各用不同 claimId），把 revision 刷上去
    for (let k = 0; k < 4; k++) {
      reply = sessions.resume('dodge-client', reply.id, reply.key, crypto.randomUUID(), { protocol: 2 });
    }
  }
  // 规避推演是"整局平均"性质的判据，只在终局判 → 补一个 over 存档再断言
  elapsed += 100;
  time += 2000;
  const overState = { ...base, elapsed, now: elapsed, engineTime: elapsed, dropCooldownUntil: elapsed, status: 'over' as const };
  reply = sessions.checkpoint('dodge-client', { ...reply, state: overState, active: false, requestId: crypto.randomUUID() });
  const row = db.prepare('SELECT revision, sim_checks, state_writes, wide_writes, flags FROM live_game WHERE id=?')
    .get(run.id) as { revision: number; sim_checks: number; state_writes: number; wide_writes: number; flags: string | null };
  // 攻击特征还原成功：物理推演基本没跑（60 个 9 秒窗口全部跳过），revision 被 resume 刷到 300
  expect(row.sim_checks).toBeLessThan(5);
  expect(row.state_writes).toBe(61);
  expect(row.revision).toBeGreaterThan(250);
  // 旧判据（用 revision 算节奏）确实放过了它
  const perMinute = (row.revision * 60000) / elapsed;
  expect(perMinute).toBeGreaterThan(DODGE_RULE.minPerMinute);
  // 新判据抓住了
  expect(String(row.flags)).toContain('疑似规避物理推演');
});

it('flags a client that keeps playing long after the server saw the board over the death line', () => {
  // 治"改高死亡线"：服务端自己按 540 记"最后没压线的时刻"。
  // 真人数据（424 个终局状态）：压线时长 2000–2500ms，一个例外都没有；阈值取 5000ms。
  const run = (holdMs: number) => {
    const db = new DatabaseSync(':memory:'); dbs.push(db);
    let time = 100_000;
    const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 0, minIntervalMs: 0 } });
    const started = sessions.start('line-' + holdMs, 'classic', 'start-line-' + holdMs, 2);
    const base = JSON.parse(JSON.stringify(started.state));
    const snap = (elapsed: number, over: boolean, balls: unknown[]) => ({
      ...base, elapsed, now: elapsed, engineTime: elapsed, dropCooldownUntil: elapsed,
      status: over ? 'over' : 'playing', balls,
    });
    const overBall = [{ id: 1, level: 1, x: 500, y: 500, vx: 0, vy: 0, angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0 }];
    let reply = started;
    for (let i = 1; i <= 5; i++) {                       // 前 5 次存档：场上空着，line_clear_at 推进到 8000
      time += 2000;
      reply = sessions.checkpoint('line-' + holdMs, { ...reply, state: snap(i * 1600, false, []), active: true, requestId: crypto.randomUUID() });
    }
    time += holdMs;
    sessions.checkpoint('line-' + holdMs, { ...reply, state: snap(8000 + holdMs, true, overBall), active: true, requestId: crypto.randomUUID() });
    return db.prepare('SELECT line_hold_ms, flags FROM live_game WHERE id=?').get(started.id) as { line_hold_ms: number; flags: string | null };
  };

  // ① 压线后还继续玩 90 秒 → 必抓（真人实测最多 2.5 秒，阈值 5 秒）
  const long = run(90_000);
  expect(String(long.flags)).toContain('压线后迟迟不结束');

  // ② 正常结束（压线后 3 秒）不能误报 —— 指标也在 3 秒附近
  const normal = run(3000);
  expect(normal.line_hold_ms).toBeGreaterThan(2_000);
  expect(normal.line_hold_ms).toBeLessThan(6_000);
  expect(String(normal.flags ?? '')).not.toContain('压线后迟迟不结束');

  // ③ 存档稀疏的真人（#546 玩家S）实测到过 5.5 秒 → 阈值 10 秒必须放过
  expect(String(run(6_000).flags ?? '')).not.toContain('压线后迟迟不结束');
  // ④ 再翻一倍（12 秒）就该抓
  expect(String(run(12_000).flags)).toContain('压线后迟迟不结束');
});


it('keeps a real player quiet: 2-second saves with real physics', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100_000;
  const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 0, minIntervalMs: 0, maxChecks: 200 } });
  const run = sessions.start('real-client', 'classic', 'start-real', 2);
  const game = ClientGame.restore(run.state);
  let reply = run;
  for (let i = 0; i < 80; i++) {
    // 每 2 秒一次存档（真客户端 saveProgress 的节奏），中间放 1 颗球
    const target = game.elapsed + 2000;
    let guard = 0;
    while (game.elapsed < target && guard++ < 400 && game.status === 'playing') {
      game.update(1000 / 60);
      if (game.heldLevel && game.elapsed - (game.elapsed - 990) >= 0) { game.setAimX(120 + (i % 9) * 90); game.drop(); break; }
    }
    time += 2000;
    reply = sessions.checkpoint('real-client', { ...reply, state: game.snapshot(), active: true, requestId: crypto.randomUUID() });
  }
  const row = db.prepare('SELECT state_writes, wide_writes, flags FROM live_game WHERE id=?')
    .get(run.id) as { state_writes: number; wide_writes: number; flags: string | null };
  expect(row.state_writes).toBeGreaterThan(50);
  expect(row.wide_writes).toBe(0);                                  // 窗口都是 2 秒
  expect(String(row.flags ?? '')).not.toContain('疑似规避物理推演');
  expect(String(row.flags ?? '')).not.toContain('存档间隔过长');
  game.destroy();
});
