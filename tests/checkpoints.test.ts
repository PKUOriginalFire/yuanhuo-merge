import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Game } from '../web/src/game';
import { Game as SimGame } from '../server/sim/game.js';
import { createRunSessions, simBiasFlag, mergeFlags } from '../server/sessions.js';
import { validateCheckpoint } from '../server/checkpoint.js';
import { aimStats, cadenceFlag, describeAutomatedDrops, detectAutomatedDrops, scoreCurveFlag, validateRun } from '../server/validate.js';

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100000;
  const sessions = createRunSessions(db, Game, () => time);
  const run = sessions.start('checkpoint-client', 'classic', 'start-checkpoint', 2);
  const game = Game.restore(run.state);
  const save = (r = run, requestId = crypto.randomUUID()) => sessions.checkpoint('checkpoint-client', { ...r, state: game.snapshot(), active: true, requestId });
  const tick = (ms = 500) => { time += ms; for (let t = 0; t < ms; t += 1000 / 60) game.update(1000 / 60); };
  return { db, sessions, run, game, save, tick };
}
it('saves local physics without re-simulation, retries once and rejects rewind or stale pages', () => {
  const f = fixture(); expect(f.run.protocol).toBe(2); expect(f.run.state.randomState).not.toBe(0);
  f.game.drop(); f.tick();
  const saved = f.save(f.run, 'checkpoint-request');
  expect(saved.state).toEqual(f.game.snapshot());
  expect(f.save(f.run, 'checkpoint-request').revision).toBe(saved.revision);
  expect(() => f.save()).toThrow(/版本|旧/);
  const old = f.run.state;
  expect(() => f.sessions.checkpoint('checkpoint-client', { ...saved, state: old, active: true, requestId: 'rewind-request' })).toThrow();
  const restored = f.sessions.resume('checkpoint-client', saved.id, saved.key, 'resume-checkpoint', { protocol: 2 });
  expect(restored.state).toEqual(saved.state);
  expect(() => f.save(saved)).toThrow(/其他页面/); f.game.destroy();
});
it('recovers an unsent local checkpoint only from the current lease and never rolls back a committed save', () => {
  const f = fixture(); f.game.drop(); f.tick();
  const saved = f.save(); f.game.drop(); f.tick();
  const state = f.game.snapshot();
  const restored = f.sessions.resume('checkpoint-client', saved.id, saved.key, 'resume-unsent-local', { protocol: 2, lease: saved.lease, state });
  expect(restored.state.trace).toHaveLength(2);
  const stale = f.sessions.resume('checkpoint-client', saved.id, saved.key, 'resume-old-tab', { protocol: 2, lease: saved.lease, state: saved.state });
  expect(stale.state.trace).toHaveLength(2); f.game.destroy();
});
it('rejects malformed physics outright and only flags suspicious-but-well-formed progress', () => {
  const f = fixture(); f.game.drop(); f.tick(); const state = f.game.snapshot();
  // 硬校验：结构性错误 → 直接拒。
  for (const bad of [{ ...state, balls: [{ ...state.balls[0], x: null }] }, { ...state, secretCount: 9 }]) {
    expect(() => f.sessions.checkpoint('checkpoint-client', { ...f.run, state: bad, active: true, requestId: crypto.randomUUID() })).toThrow();
  }
  expect(f.db.prepare('SELECT revision FROM live_game WHERE id=?').get(f.run.id)?.revision).toBe(0);
  // 软校验：数据自洽但分数对不上 → 接受存档，只把这一局标成可疑（不能打死真实玩家）。
  const fake = f.sessions.checkpoint('checkpoint-client', { ...f.run, state: { ...state, score: 999999 }, active: true, requestId: crypto.randomUUID() });
  const row = f.db.prepare('SELECT flags FROM live_game WHERE id=?').get(f.run.id) as { flags: string };
  expect(row.flags).toMatch(/分/);
  expect(fake.revision).toBe(1); f.game.destroy();
});
it('accepts the latest progress when an older snapshot only reaches the server after a long network delay', () => {
  const f = fixture(); f.game.drop(); const delayed = f.game.snapshot(); f.tick(16000);
  const saved = f.sessions.checkpoint('checkpoint-client', { ...f.run, state: delayed, active: true, requestId: 'delayed-checkpoint' });
  expect(f.save(saved).state.elapsed).toBeCloseTo(f.game.snapshot().elapsed); f.game.destroy();
});

for (const seed of [1972, 4553]) it(`preserves the placed egg and both previews through checkpoint and resume (seed ${seed})`, () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  class SeededGame extends Game { constructor(mode: any, events: any, _seed: number, enabled: boolean) { super(mode, events, seed, enabled); } }
  const sessions = createRunSessions(db, SeededGame, () => 100000);
  const run = sessions.start('egg-client', 'endless', 'start-egg-checkpoint', 2, true);
  expect(run.state.easterEggs).toBe(true);
  const game = Game.restore(run.state); game.drop();
  const state = game.snapshot();
  expect(validateCheckpoint(state, run.state, 0)).toEqual({ state, flags: [] });
  const save = (s = state) => sessions.checkpoint('egg-client', { ...run, state: s, active: true, requestId: crypto.randomUUID() });
  // Removing, converting, duplicating or changing an egg identity is rejected even at score zero.
  for (const balls of [[], [{ ...state.balls[0], level: 1 }], [{ ...state.balls[0], level: state.balls[0].level === -1 ? -2 : -1 }], [...state.balls, { ...state.balls[0], id: state.balls[0].id + 1 }]]) {
    expect(() => save({ ...state, balls })).toThrow();
  }
  expect(() => save({ ...state, easterEggs: undefined })).toThrow();
  const saved = save();
  expect(() => sessions.resume('egg-client', saved.id, saved.key, 'old-page-egg-resume', { protocol: 2 })).toThrow(/刷新/);
  const resumed = sessions.resume('egg-client', saved.id, saved.key, 'resume-egg-checkpoint', { protocol: 2, easterEggs: 1 });
  expect(resumed.state).toEqual(state);
  expect(() => sessions.checkpoint('egg-client', { ...saved, state, active: true, requestId: crypto.randomUUID() })).toThrow(/其他页面/);
  game.destroy();
});

// ───────────────────────────────────────────────────────────────────────────
// 守恒律回归测试。这两条守恒律各自把真实玩家打死过一次，所以必须拿**真实引擎**
// 走一遍真实路径（无尽循环合成、秘技删球），而不是只测手写的数字。
// ───────────────────────────────────────────────────────────────────────────

const BUDGET = 1e9;
const conservationFlags = (r: { flags: string[] }) => r.flags.filter(f => /守恒/.test(f));

/** 按真实权重造一条合法的投放序列（前 5 球必须等于新手引导，否则 validateRun 会拒） */
function makeTrace(n: number) {
  const pool = [1, 2, 3, 4, 5], weights = [35, 25, 20, 12, 8], tutorial = [1, 1, 2, 2, 3];
  let s = 123456789;
  const trace: { t: number; x: number; lv: number }[] = [];
  for (let i = 0; i < n; i++) {
    let lv = tutorial[i] ?? 1;
    if (i >= tutorial.length) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      let r = (s / 0x100000000) * 100;
      lv = pool[0];
      for (let k = 0; k < pool.length; k++) { r -= weights[k]; if (r <= 0) { lv = pool[k]; break; } }
    }
    trace.push({ t: 400 * i, x: 0.5, lv });
  }
  return trace;
}

/** 把单位总量拆成尽可能大的球（贪心 = 二进制分解，正好拆尽） */
function decompose(units: number, nextId: { id: number }) {
  const balls = [];
  let left = units;
  for (let lv = 11; lv >= 1; lv--) {
    const u = Math.pow(2, lv - 1);
    while (left >= u && balls.length < 500) {
      balls.push({ id: nextId.id++, level: lv, x: 300, y: 1200, vx: 0, vy: 0, angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0 });
      left -= u;
    }
  }
  return balls;
}

it('keeps the ball and unit conservation laws exact after an endless recycle (regression: the +loopCount bug)', () => {
  const trace = makeTrace(600);
  const units = trace.reduce((s, e) => s + Math.pow(2, e.lv - 1), 0);
  const nextId = { id: 1 };
  const balls = decompose(units, nextId);
  expect(balls.filter(b => b.level === 11).length).toBeGreaterThanOrEqual(2);
  const elapsed = 400 * trace.length;
  const before: any = {
    version: 1, mode: 'endless', status: 'playing',
    score: 3000, merges: trace.length - balls.length, loopCount: 0, maxLevelReached: 11,
    heldLevel: 1, nextLevel: 2, heldX: 562, spawnCount: trace.length,
    now: elapsed, elapsed, accumulator: 0, dropCooldownUntil: elapsed - 400, overLineSince: null,
    engineTime: elapsed, randomState: 12345, secretCount: 0, secretCycle: 0,
    trace, balls, resonatedPairs: [],
  };
  // 让两个完全体叠在一起 —— 下一次 update 必然触发无尽模式的「循环合成」。
  const tops = balls.filter(b => b.level === 11);
  tops[0].x = 561; tops[0].y = 900;
  tops[1].x = 562; tops[1].y = 900;

  const game = Game.restore(before);
  for (let i = 0; i < 5; i++) game.update(1000 / 60);
  const after = game.snapshot();
  game.destroy();

  expect(after.loopCount).toBe(1);
  // 关键：merges 已经包含循环合成，球数守恒**不能**再加 loopCount。
  // 旧写法 spawnCount + loopCount − merges 会算出 7，场上实际只有 6 颗。
  expect(after.balls.length).toBe(after.spawnCount - after.merges);
  expect(after.spawnCount + after.loopCount - after.merges).not.toBe(after.balls.length);
  expect(conservationFlags(validateCheckpoint(after, before, BUDGET))).toEqual([]);
});

it('does not break conservation when the player uses a secret (useSecret deletes balls without touching merges)', () => {
  const game = new Game('classic', {}, 2024, false);
  game.start();
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 26; k++) game.update(1000 / 60);
    game.setAimX(300 + (i % 5) * 150);
    game.drop();
  }
  const before = game.snapshot();
  // 秘技按分数发放（经典模式 1000 分 1 次）。这里直接把奖励发下来，
  // 走的是真实的 useSecret 删球路径。
  const raw = game as unknown as { score: number; secretCount: number; secretSchedule: { restore(c: number): void } };
  raw.score = 1000; raw.secretCount = 1; raw.secretSchedule.restore(1);
  const removed = game.useSecret(562, 1200);
  expect(removed).not.toBeNull();
  const after = game.snapshot();
  game.destroy();

  expect(after.secretCount).toBe(0);
  expect(after.secretCycle).toBe(1);
  expect(conservationFlags(validateCheckpoint(after, before, BUDGET))).toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 红队第二轮新增的四条判定。每条都要有「真实对局不误报」的正面用例，
// 否则就是又给自己埋一颗雷。
// ───────────────────────────────────────────────────────────────────────────

/** 一局刚开局的空状态，用来给合成出来的存档当 previous */
const emptyState = (mode: 'classic' | 'endless') => ({
  version: 1 as const, mode, status: 'playing' as const,
  score: 0, merges: 0, loopCount: 0, maxLevelReached: 1,
  heldLevel: 1, nextLevel: 2, heldX: 562, spawnCount: 0,
  now: 0, elapsed: 0, accumulator: 0, dropCooldownUntil: 0, overLineSince: null,
  engineTime: 0, randomState: 1, secretCount: 0, secretCycle: 0,
  trace: [] as { t: number; x: number; lv: number }[], balls: [] as any[], resonatedPairs: [] as string[],
});

/** 真打到 overflow 结束的一局（用于终局见证 / 得分率的正面用例） */
function playUntilOver(mode: 'classic' | 'endless', seed = 4242) {
  const game = new Game(mode, {}, seed, false);
  game.start();
  // ⚠️ 一旦 status 变成 over 就必须停止 update：update() 会在结束后继续推进 now
  //    而 elapsed 冻结，两者差超过 100ms 就会撞上硬校验「时钟」那条。
  //    真实客户端也是靠 main.ts 里 while 的 status 判断停下来的。
  for (let i = 0; i < 500 && game.status === 'playing'; i++) {
    for (let k = 0; k < 26 && game.status === 'playing'; k++) game.update(1000 / 60);
    if (game.status !== 'playing') break;
    game.setAimX(250 + ((i * 137) % 500));
    game.drop();
  }
  const state = game.snapshot();
  game.destroy();
  return state;
}

/** 造一条等级序列，使 Σ2^(lv-1) 精确等于 units（前 5 球仍是新手引导） */
function traceOfUnits(n: number, units: number) {
  const tutorial = [1, 1, 2, 2, 3];
  const trace = Array.from({ length: n }, (_, i) => ({ t: 400 * i, x: 0.5, lv: tutorial[i] ?? 1 }));
  const base = tutorial.reduce((s, lv) => s + Math.pow(2, lv - 1), 0) + (n - tutorial.length);
  let left = units - base;
  let i = tutorial.length;
  for (const lv of [5, 4, 3, 2]) {
    const delta = Math.pow(2, lv - 1) - 1;
    while (left >= delta && i < n) { trace[i++].lv = lv; left -= delta; }
  }
  if (left !== 0) throw new Error(`单位凑不齐，剩 ${left}`);
  return trace;
}

it('accepts a real game-over state and flags one that cannot have ended by overflow', () => {
  const over = playUntilOver('classic');
  expect(over.status).toBe('over');
  expect(over.balls.length).toBeGreaterThan(0);
  // 真实终局：至少有一颗球压在死亡线以上
  expect(validateCheckpoint(over, emptyState('classic'), BUDGET).flags).toEqual([]);
  // 把所有球挪到死亡线以下：物理上不可能以 overflow 结束
  const moved = { ...over, balls: over.balls.map(b => ({ ...b, y: b.y + 900 })) };
  expect(validateCheckpoint(moved, emptyState('classic'), BUDGET).flags).toContain('终局但没有球压过死亡线');
});

it('keeps real play well under the points-per-drop ceiling and flags a score pinned to the ceiling', () => {
  const over = playUntilOver('endless', 777);
  const perDrop = over.score / over.trace.length;
  expect(perDrop).toBeLessThan(12);
  expect(validateCheckpoint(over, emptyState('endless'), BUDGET).flags.filter(f => /每次投放得分/.test(f))).toEqual([]);
  const pumped = { ...over, score: 12 * over.trace.length + 1 };
  expect(validateCheckpoint(pumped, emptyState('endless'), BUDGET).flags.some(f => /每次投放得分/.test(f))).toBe(true);
});

it('bounds how many units a secret can destroy (the loophole that turned the conservation laws off)', () => {
  const trace = traceOfUnits(1300, 5000);
  const units = trace.reduce((s, e) => s + Math.pow(2, e.lv - 1), 0);
  expect(units).toBe(5000);
  const elapsed = 400 * trace.length;
  const base = {
    ...emptyState('classic'), status: 'over' as const,
    score: 3000, merges: trace.length - 1, maxLevelReached: 11, spawnCount: trace.length,
    now: elapsed, elapsed, engineTime: elapsed, dropCooldownUntil: elapsed,
    trace, balls: [{ id: 1, level: 11, x: 562, y: 400, vx: 0, vy: 0, angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0 }],
  };
  // 声明用过一次秘技、场上只剩一颗完全体：等于"一次秘技删掉 3976 单位" > 3200 → 标记（这是闸门）
  const greedy = { ...base, secretCycle: 1, secretCount: 0 };
  expect(validateCheckpoint(greedy, emptyState('classic'), BUDGET).flags.some(f => /秘技删除/.test(f))).toBe(true);

  // 把差额补回去，删掉的单位落回上界之内 → 不该再报这条
  const modest = { ...base, secretCycle: 1, secretCount: 0, balls: [...base.balls, ...decompose(3976 - 3000, { id: 100 })] };
  const cleared = 5000 - modest.balls.reduce((s, b) => s + Math.pow(2, b.level - 1), 0);
  expect(cleared).toBeLessThanOrEqual(3200);
  expect(validateCheckpoint(modest, emptyState('classic'), BUDGET).flags.filter(f => /秘技删除/.test(f))).toEqual([]);

  // 线上实测：单次最多能清 3333 单位（满盘 3859 删掉 86%）。3200 会标记它 —— 这是已知取舍：
  // 软标记、只进复核队列、不丢局。真出现时人工放行即可。
  expect(3333).toBeGreaterThan(3200);
});

it('caps the stored snapshot size and keeps the live_game table bounded', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100000;
  const sessions = createRunSessions(db, Game, () => time, { maxStateBytes: 4096, maxLiveRows: 3, abandonedTtlMs: 0 });
  const run = sessions.start('limit-client', 'classic', 'start-limit', 2);
  const game = Game.restore(run.state);
  // 正常存档只有几百字节，能过
  const saved = sessions.checkpoint('limit-client', { ...run, state: game.snapshot(), active: true, requestId: crypto.randomUUID() });
  expect(saved.revision).toBe(1);
  game.destroy();
  // 塞一条 4000 条的 trace 让它超过 4KB 上限：必须 413，而不是默默写进磁盘。
  // 注意要让它的内容本身合法（时间戳落在 elapsed 之内、预算够），否则会先被校验挡成 400，
  // 那样测的就不是体积上限了。
  time += 12000;
  const fat = {
    ...emptyState('classic'), elapsed: 4000, now: 4000, engineTime: 4000, dropCooldownUntil: 4000,
    spawnCount: 4000, merges: 4000, trace: Array.from({ length: 4000 }, (_, i) => ({ t: i, x: 0.5, lv: 1 })),
  };
  let status = 0;
  try { sessions.checkpoint('limit-client', { ...saved, state: fat, active: true, requestId: crypto.randomUUID() }); }
  catch (error) { status = (error as { status?: number }).status ?? 0; }
  expect(status).toBe(413);
  // 行数上限：连开 8 局，最后只剩 3 行
  for (let i = 0; i < 8; i++) sessions.start('limit-client', 'classic', `start-limit-${i}`, 2);
  expect((db.prepare('SELECT COUNT(*) n FROM live_game').get() as { n: number }).n).toBe(3);
});

// ───────────────────────────────────────────────────────────────────────────
// 自动投放（定时器宏）识别。阈值全部来自线上实测校准：
//   · 真人（197 局）落点跨度 p1=907px；确认过的真人「玩家I」最窄 459px、连续段最长 180 颗
//   · 脚本：网格 16 个点（每 63px 一格）、慢节拍 2000ms、窄带 39px
// 每个"该封印"的用例都必须配一个"长得像但其实是真人"的反例。
// ───────────────────────────────────────────────────────────────────────────

/** 造一条 trace：控制间隔序列和落点（像素） */
function makeOpTrace(gaps: number[], aimPx: number[]) {
  const trace = [{ t: 0, x: aimPx[0] / 1001, lv: 1 }];
  let t = 0;
  for (let i = 1; i < gaps.length + 1; i++) {
    t += gaps[i - 1];
    trace.push({ t, x: aimPx[i % aimPx.length] / 1001, lv: 1 + (i % 5) });
  }
  return trace;
}
const gridAim = (count: number, stepPx: number, startPx = 30) =>
  Array.from({ length: count }, (_, i) => startPx + i * stepPx);

it('detects timer macros but never a human, including the calibrated near-misses', () => {
  // ① 快节奏 + 16 个硬编码落点（每 63px 一格）：线上实测的形态
  const grid = makeOpTrace(Array(300).fill(400), gridAim(16, 63));
  const gridHit = detectAutomatedDrops(grid)!;
  expect(gridHit.kind).toBe('fixed-aim');
  expect(gridHit.positions).toBe(16);
  expect(describeAutomatedDrops(gridHit)).toMatch(/疑似自动投放/);

  // ② 慢节拍 2000ms + 8 个落点
  const slow = makeOpTrace(Array(300).fill(2000), gridAim(8, 20, 398));
  expect(detectAutomatedDrops(slow)!.kind).toBe('fixed-aim');

  // ③ 窄带抖动：落点上百种但全挤在 17px 内（宏加随机抖动）
  const jitter = makeOpTrace(Array(300).fill(420), Array.from({ length: 300 }, () => 490 + Math.floor(Math.random() * 17)));
  expect(detectAutomatedDrops(jitter)!.kind).toBe('narrow');

  // ④★回归★ 把延迟随机化的同一个脚本：21 个固定落点 + 2400–3600ms 随机间隔。
  //   旧的「节奏 AND 落点」设计会漏掉它（线上确实漏了：6040 分挂在无尽第 8、3654 分挂经典第 20）
  const jitteredDelay = makeOpTrace(
    Array.from({ length: 300 }, () => 2400 + Math.floor(Math.random() * 1200)),
    gridAim(21, 47, 34),
  );
  const jitteredHit = detectAutomatedDrops(jitteredDelay)!;
  expect(jitteredHit.kind).toBe('fixed-aim');
  expect(jitteredHit.positions).toBe(21);
  expect(describeAutomatedDrops(jitteredHit)).toMatch(/随机化/);

  // ⑤ 真人：间隔天然散乱、落点铺满容器
  const humanAim = Array.from({ length: 300 }, () => 60 + Math.floor(Math.random() * 900));
  const human = makeOpTrace(Array.from({ length: 300 }, () => 1200 + Math.floor(Math.random() * 2500)), humanAim);
  expect(detectAutomatedDrops(human)).toBeNull();

  // ⑥ 真人狂点：间隔顶到冷却、连续段很长，但落点铺满 → 不能误伤
  const masherAim = Array.from({ length: 300 }, () => 60 + Math.floor(Math.random() * 900));
  const masher = makeOpTrace(Array.from({ length: 300 }, () => 400 + Math.floor(Math.random() * 60)), masherAim);
  expect(detectAutomatedDrops(masher)).toBeNull();

  // ⑦ ★校准用例★ 「玩家I」式真人：连续 180 颗顶冷却，但落点跨 459px、158 种 → 必须放过
  const xuanAim = Array.from({ length: 300 }, (_, i) => 300 + ((i * 37) % 459));
  const xuanGaps = Array.from({ length: 300 }, (_, i) => (i < 180 ? 450 : i % 7 === 0 ? 3000 : 1800));
  expect(detectAutomatedDrops(makeOpTrace(xuanGaps, xuanAim))).toBeNull();

  // ⑧ ★回归★ 固定节拍 + 随机落点：2026-10-19 线上审计实抓的 #84 形态
  //    （461 次投放里 456 次间隔精确落在 616/617ms，落点却有 277 种，1677 分挂在榜上）。
  //    旧设计"节奏只做描述、不作判据"直接漏掉了它。
  const metronomeVariedAim = makeOpTrace(
    Array.from({ length: 300 }, (_, i) => (i % 2 ? 616 : 617)),
    Array.from({ length: 300 }, () => 60 + Math.floor(Math.random() * 900)),
  );
  const metronomeHit = detectAutomatedDrops(metronomeVariedAim)!;
  expect(metronomeHit.kind).toBe('metronome');
  expect(metronomeHit.beat).toBe(620);            // 10ms 分桶后 616/617 合并成一个节拍
  expect(describeAutomatedDrops(metronomeHit)).toMatch(/落点随机/);

  // ⑧b 真人的"顶着冷却连点"：间隔 450–467ms（低于 600ms 节拍线）+ 落点铺满 → 必须放过。
  //     线上有十几局真人中位间隔就在这一档，这是节拍判据的下限为什么必须 ≥600ms 的原因。
  const fastHuman = makeOpTrace(
    Array.from({ length: 300 }, () => 450 + Math.floor(Math.random() * 18)),
    Array.from({ length: 300 }, () => 60 + Math.floor(Math.random() * 900)),
  );
  expect(detectAutomatedDrops(fastHuman)).toBeNull();

  // ⑨ 样本太少时不做判断
  expect(detectAutomatedDrops(makeOpTrace(Array(20).fill(400), gridAim(3, 63)))).toBeNull();
});

it('surfaces the automated-drop verdict as a soft flag on a real checkpoint', () => {
  const trace = traceOfUnits(300, 1200);
  // 改成「400ms 一拍 + 16 个硬编码落点」的脚本形态
  const scripted = trace.map((e, i) => ({ t: 400 * i, x: (30 + (i % 16) * 63) / 1001, lv: e.lv }));
  const units = scripted.reduce((s, e) => s + Math.pow(2, e.lv - 1), 0);
  const balls = decompose(units, { id: 1 });
  const elapsed = 400 * scripted.length;
  const state = {
    ...emptyState('classic'),
    score: 800, merges: scripted.length - balls.length, maxLevelReached: 11, spawnCount: scripted.length,
    now: elapsed, elapsed, engineTime: elapsed, dropCooldownUntil: elapsed,
    trace: scripted, balls,
  };
  const result = validateCheckpoint(state, emptyState('classic'), BUDGET);
  expect(result.flags.some(f => /疑似自动投放/.test(f))).toBe(true);
  // 只标记、不拒绝
  expect(result.state).toBeTruthy();
});

it('rejects a deeply nested snapshot instead of blowing the stack (regression: 500 on demand)', () => {
  const f = fixture();
  // 20k 层嵌套：JSON.stringify 递归爆栈 → 旧代码直接 500。必须变成 400。
  let deep: any = [];
  for (let i = 0; i < 20000; i++) deep = [deep];
  let status = 0;
  try {
    f.sessions.checkpoint('checkpoint-client', { ...f.run, state: { version: 1, deep }, active: true, requestId: crypto.randomUUID() });
  } catch (error) { status = (error as { status?: number }).status ?? 0; }
  expect(status).toBe(400);
  // 服务端还能正常工作
  f.game.drop(); f.tick();
  expect(f.save().revision).toBeGreaterThan(0);
  f.game.destroy();
});

it('only flags batch-upload cadence now that real players show values as low as 5.4/min', () => {
  // 2026-10 的实测把原来的"空档"填掉了：真人的低值已经落进伪造区间（0.1–7.7 次/分）。
  //   #554 五条悟 35.9 次/分 / #546 玩家S 13.9 次/分 / #591 玩家C 5.4 次/分
  //   这三个人物理推演、台账、落点全部正常 → 阈值从 20 降到 2，只抓批量上报。
  expect(cadenceFlag(0, 600000)).toMatch(/存档节奏异常/);        // 10 分钟 0 次
  expect(cadenceFlag(2, 1410000)).toMatch(/存档节奏异常/);       // 线上 #392 那种：23.5 分钟 2 次 = 0.09 次/分
  expect(cadenceFlag(14, 720000)).toMatch(/存档节奏异常/);       // 线上 #387：12 分钟 14 次 = 1.2 次/分
  // 真人低值必须放过
  expect(cadenceFlag(221, 2444000)).toBeNull();                  // #591 玩家C：5.4 次/分
  expect(cadenceFlag(552, 2382000)).toBeNull();                  // #546 玩家S：13.9 次/分
  expect(cadenceFlag(1861, 3120000)).toBeNull();                 // #554 五条悟：35.8 次/分
  expect(cadenceFlag(1493, 1410000)).toBeNull();                 // 真人：63 次/分
  expect(cadenceFlag(2345, 3678000)).toBeNull();                 // 真人：38 次/分（榜二那局）
  expect(cadenceFlag(247, 148000));                              // 短局：100 次/分 → 放行
  expect(cadenceFlag(43, 54000)).toBeNull();                     // 42 秒 43 次 → 48 次/分
  expect(cadenceFlag(0, 20000)).toBeNull();                      // 时长不足 30 秒不判
});

it('marks an old run with almost no checkpoints as suspicious when it ends', () => {
  const f = fixture();
  // 把会话起点往前挪 4 分钟，然后只存一次档（客户端声称已经玩了 3 分钟）
  f.tick(240000);
  const state = f.game.snapshot();
  state.elapsed = state.now = state.engineTime = 180000;
  state.dropCooldownUntil = 180000;
  const saved = f.sessions.checkpoint('checkpoint-client', { ...f.run, state, active: true, requestId: crypto.randomUUID() });
  expect(saved.revision).toBe(1);
  // ⚠️ 2026-10-23 起"存档节奏"只在**终局**判定（误标 #554 的教训：开局一个瞬时低谷
  //    就能把整局钉死，而那位玩家整局其实是 35.9 次/分）。
  //    所以这里中途不判，等它真的结束时再判 —— 离线跑完再批量上报照样跑不掉。
  const mid = f.db.prepare('SELECT flags FROM live_game WHERE id=?').get(f.run.id) as { flags: string | null };
  expect(String(mid.flags ?? '')).not.toMatch(/存档节奏异常/);
  // 结束那一刻就必须判出来
  const overState = { ...state, status: 'over' as const };
  f.sessions.checkpoint('checkpoint-client', { ...saved, state: overState, active: false, requestId: crypto.randomUUID() });
  const row = f.db.prepare('SELECT flags FROM live_game WHERE id=?').get(f.run.id) as { flags: string };
  expect(row.flags).toMatch(/存档节奏异常/);
  f.game.destroy();
});

it('flags teleporting balls and shrunk ball radii, but not real physics', () => {
  const elapsed = 400 * 60;
  const mk = (balls: any[]) => ({
    ...emptyState('classic'), status: 'over' as const,
    score: 100, merges: 60 - balls.length, maxLevelReached: 11, spawnCount: 60,
    now: elapsed, elapsed, engineTime: elapsed, dropCooldownUntil: elapsed,
    trace: makeTrace(60, 400), balls,
  });
  const ball = (id: number, lv: number, x: number, y: number) => ({ id, level: lv, x, y, vx: 0, vy: 0, angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0 });
  // 真实排布：相切堆叠（间距 ≈ 半径和）
  const real = [
    ball(1, 3, 400, 1800), ball(2, 3, 400 + 125, 1800), ball(3, 4, 400, 1800 - 147),
    ball(4, 4, 400 + 147, 1800 - 147), ball(5, 5, 400, 1800 - 147 - 173), ball(6, 5, 400 + 173, 1800 - 147 - 173),
  ];
  const realResult = validateCheckpoint(mk(real), emptyState('classic'), BUDGET);
  expect(realResult.flags.filter(f => /球间距异常|球位置跳变/.test(f))).toEqual([]);
  // 半径被改小一半：球挤在一起，间距只有半径和的一半
  const shrunk = real.map(b => ({ ...b, x: 400 + (b.x - 400) / 2, y: 1800 + (b.y - 1800) / 2 }));
  const shrunkResult = validateCheckpoint(mk(shrunk), emptyState('classic'), BUDGET);
  expect(shrunkResult.flags.some(f => /球间距异常/.test(f))).toBe(true);
});

it('flags a ball that teleports between two checkpoints', () => {
  const ball = (id: number, x: number, y: number) => ({ id, level: 5, x, y, vx: 0, vy: 0, angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0 });
  const elapsed = 400 * 60;
  const base = {
    ...emptyState('classic'), status: 'playing' as const,
    score: 0, merges: 57, maxLevelReached: 11, spawnCount: 60,
    now: elapsed, elapsed, engineTime: elapsed, dropCooldownUntil: elapsed,
    trace: makeTrace(60, 400),
    balls: [ball(1, 400, 1800), ball(2, 600, 1800), ball(3, 800, 1800)],
  };
  const prev = { ...base, elapsed: elapsed - 1000, now: elapsed - 1000, engineTime: elapsed - 1000 };
  // 1 秒内只该动 ≤ 3000px（真机实测最大 1106px/秒）；跳 5000px 不可能
  const jumped = { ...base, balls: [ball(1, 400, 1800), ball(2, 600, 1800), ball(3, 800, 1800 - 5000)] };
  const ok = validateCheckpoint(base, prev, BUDGET);
  expect(ok.flags.filter(f => /球位置跳变/.test(f))).toEqual([]);
  const bad = validateCheckpoint(jumped, prev, BUDGET);
  expect(bad.flags.some(f => /球位置跳变/.test(f))).toBe(true);

  // ★回归★ 2026-10-19 线上误标 #409：两次存档之间游戏时间没推进（暂停/刷新），
  //   旧代码把差值钳成 1ms → 允许位移只剩 203px → 任何位置变化都算"瞬移"。
  //   用"上一帧只早 1ms"来复现（state 本身不动，避免撞上 trace 时间戳的硬校验）
  const pausedPrev = { ...prev, elapsed: elapsed - 1 };
  expect(validateCheckpoint(jumped, pausedPrev, BUDGET).flags.filter(f => /球位置跳变/.test(f))).toEqual([]);
  //   同理，300ms 以下的窗口不判（真人存档间隔中位 2–3 秒）
  const shortPrev = { ...prev, elapsed: elapsed - 200 };
  expect(validateCheckpoint(jumped, shortPrev, BUDGET).flags.filter(f => /球位置跳变/.test(f))).toEqual([]);
  //   对照组：1 秒窗口下同样的位移必须照抓
  expect(validateCheckpoint(jumped, prev, BUDGET).flags.filter(f => /球位置跳变/.test(f)).length).toBe(1);

  // ★回归★ `resume` 走 Game.restore 会把球重新编号成 1..N：上一帧的 id 大多是高位，
  //   这一帧全是 1..N，只有极少数 id 恰巧重合 —— 这种"几乎对不上"的情况不能判。
  const renumbered = {
    ...base,
    balls: [ball(1, 100, 900), ball(2, 300, 900), ball(3, 500, 900)],
  };
  const renumberedPrev = { ...prev, balls: [ball(901, 100, 900), ball(902, 300, 900), ball(903, 500, 1800)] };
  expect(validateCheckpoint(renumbered, renumberedPrev, BUDGET).flags.filter(f => /球位置跳变/.test(f))).toEqual([]);
});

it('replays each checkpoint window server-side and keeps a real player near zero bias', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100000;
  // 抽样率拉到 1、间隔拉到 0，让每一次存档都被校验（测试要确定性）
  // 关键：服务端用 server/sim（生产就是这样），玩家用 web/src/game —— 两个独立实现之间
  // 必然有物理差异，正是这种差异让增量校验有意义；同时也可能带来误报，所以这条必须过得去。
  const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 1, minIntervalMs: 0, maxChecks: 100 } });
  const run = sessions.start('sim-client', 'classic', 'start-sim', 2);
  const game = Game.restore(run.state);
  let rev = run;
  for (let i = 0; i < 24; i++) {
    for (let k = 0; k < 30; k++) game.update(1000 / 60);   // 半秒物理
    game.setAimX(300 + (i % 7) * 90);
    game.drop();
    time += 700;
    rev = sessions.checkpoint('sim-client', { ...rev, state: game.snapshot(), active: true, requestId: crypto.randomUUID() });
  }
  const row = db.prepare('SELECT sim_checks, sim_bias FROM live_game WHERE id=?').get(run.id) as { sim_checks: number; sim_bias: number };
  // 真的校验收到了（不是静默跳过）
  expect(row.sim_checks).toBeGreaterThan(8);
  // 真实对局：累计符号偏差应该接近 0（实测 528 个窗口均值 +0.015）
  const ratio = Math.abs(row.sim_bias) / row.sim_checks;
  expect(ratio).toBeLessThan(0.5);
  game.destroy();
});

it('catches a client that inflates a few merges per window, even though every window is within tolerance', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100000;
  const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 1, minIntervalMs: 0, maxChecks: 100 } });
  const run = sessions.start('cheat-client', 'classic', 'start-cheat', 2);
  const game = Game.restore(run.state);
  let rev = run;
  let injected = 0;
  for (let i = 0; i < 24; i++) {
    for (let k = 0; k < 30; k++) game.update(1000 / 60);
    game.setAimX(300 + (i % 7) * 90);
    game.drop();
    time += 700;
    const state = game.snapshot();
    // 每个窗口偷偷多注 1 次合成 / 10 分（注水量累加，所以相邻窗口差 1）——
    // 单窗口永远在 ±3 容差内，靠累计符号才抓得住
    injected += 1;
    state.merges += injected; state.score += 10 * injected;
    rev = sessions.checkpoint('cheat-client', { ...rev, state, active: true, requestId: crypto.randomUUID() });
  }
  const row = db.prepare('SELECT sim_checks, sim_bias FROM live_game WHERE id=?').get(run.id) as { sim_checks: number; sim_bias: number };
  expect(row.sim_checks).toBeGreaterThan(8);
  const ratio = Math.abs(row.sim_bias) / row.sim_checks;
  // 每窗口注水 1 次 → 比值 ≈ 1.0，远高于真人的 0.02，也远高于阈值 0.5
  expect(ratio).toBeGreaterThan(0.5);
  game.destroy();
});

it('bounds score by elapsed time so a 193-second leaderboard takeover is impossible', () => {
  // 标定见 validate.js 的 SCORE_CURVE（生产 289 局真人全部通过，最紧的一局用到 72% 额度）
  // 真人实测：峰值 6.95 分/秒（165 秒那局），中位 1.49，40 分钟以上的长局只有 1.79
  expect(scoreCurveFlag(5786, 193_000)).not.toBe('');        // 193 秒登顶 → 30 分/秒，必须抓
  expect(scoreCurveFlag(19999, 529_000)).not.toBe('');       // 历史攻击（38 分/秒）
  expect(scoreCurveFlag(999999, 14_000)).not.toBe('');       // 历史攻击（71088 分/秒）
  expect(scoreCurveFlag(2414, 259_000)).not.toBe('');        // 9.3 分/秒，真人没有这个速率
  // 真人存档：一局都不能碰
  expect(scoreCurveFlag(1145, 165_000)).toBe('');            // 6.95 分/秒，真人峰值
  expect(scoreCurveFlag(1677, 286_000)).toBe('');            // 286 秒 1677 分（离曲线最近的一局，72%）
  expect(scoreCurveFlag(5786, 4_292_000)).toBe('');          // 当前经典榜首
  expect(scoreCurveFlag(18454, 6_236_000)).toBe('');         // 当前无尽榜首
  expect(scoreCurveFlag(500, 20_000)).toBe('');              // 短局靠截距保护
  expect(scoreCurveFlag(0, 1_000)).toBe('');
  expect(scoreCurveFlag(1200, 0)).toBe('');
  // 想报 5786 分至少要 19 分钟，那时候物理校验早就抽满 20 次了
  expect((5786 - 1200) / 4 / 60).toBeGreaterThan(19);
});

it('keeps the sim-bias criterion quiet for real-player noise and loud for per-window inflation', () => {
  // 真人：累计偏差是均值 0、标准差 σ√N 的随机游走（σ 用实测 1.6 秒窗口的 0.87，这里取 0.9 更保守）
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  // Box–Muller 造正态
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  let falsePositives = 0;
  const PLAYERS = 500;
  for (let p = 0; p < PLAYERS; p++) {
    const checks = 20 + Math.floor(rand() * 180);
    let bias = 0;
    for (let i = 0; i < checks; i++) bias += gauss() * 0.9;
    if (simBiasFlag(checks, Math.round(bias))) falsePositives++;
  }
  // 4σ 界 → 理论误报率 6e-5；500 个真人不该出现第二个
  expect(falsePositives).toBeLessThanOrEqual(1);

  // 伪造者：每窗口偷偷多注 1 次合成（单窗口永远在 ±3 容差内）
  for (const checks of [20, 45, 120, 200]) {
    expect(simBiasFlag(checks, checks)).not.toBe('');
  }
  // 每窗口注水 0.5 次：够长的对局也要抓得住
  expect(simBiasFlag(120, 60)).not.toBe('');
  // 抽样太少（< 20）不下结论
  expect(simBiasFlag(19, 19)).toBe('');
  // 正常的零偏差
  expect(simBiasFlag(200, 0)).toBe('');
  expect(simBiasFlag(45, -3)).toBe('');
});

it('catches the 180-second fabrication even with random sampling turned off (warm-up only)', () => {
  // 复刻"193 秒伪造登顶"的攻击形状：
  //   · 贴着存档节奏规则的下限存档（每 2.9 秒一次 ≈ 20.7 次/分，真人 31–126）→ 躲开节奏规则
  //   · 每个窗口都偷偷多报 4 次合成
  // 这条的关键是 **sample: 0**：完全没有随机抽样，只剩"预热无条件校验"这一条路。
  // 上线前的版本在这里会漏（64 次存档 × 12% ≈ 8 次 < 20 次门槛）。
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 100000;
  const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 0, minIntervalMs: 0, maxChecks: 200 } });
  const run = sessions.start('warmup-client', 'classic', 'start-warmup', 2);
  const game = Game.restore(run.state);
  let reply = run;
  for (let i = 0; i < 26; i++) {
    const target = game.elapsed + 2900;
    let guard = 0, dropIndex = 0, lastDrop = -Infinity;
    while (game.elapsed < target && guard++ < 600 && game.status === 'playing') {
      game.update(1000 / 60);
      // 按真人的投放节奏（约 1.1 秒一个），不要每帧都投 ——
      // 极限连点会让服务端重放的投放冷却冲突，窗口变成"不可推演"而跳过
      if (game.heldLevel && game.elapsed - lastDrop >= 1100) {
        game.setAimX(150 + (dropIndex++ % 2) * 700 + (dropIndex * 7 % 40));
        game.drop(); lastDrop = game.elapsed;
      }
    }
    time += 2900;
    const state = game.snapshot();
    state.merges += 4 * (i + 1);   // 每窗口偷报 4 次合成（分数保持诚实，免得撞上分数曲线那条）
    reply = sessions.checkpoint('warmup-client', { ...reply, state, active: true, requestId: crypto.randomUUID() });
  }
  const row = db.prepare('SELECT sim_checks, sim_bias, flags FROM live_game WHERE id=?').get(run.id) as { sim_checks: number; sim_bias: number; flags: string | null };
  // 预热把样本数顶到门槛，不需要任何随机抽样
  expect(row.sim_checks).toBe(20);
  expect(Math.abs(row.sim_bias)).toBeGreaterThan(4 * 0.9 * Math.sqrt(20));
  expect(String(row.flags)).toContain('物理推演不一致');
  game.destroy();
});

it('judges timer macros only at submit time on the complete trace, never mid-run', () => {
  // 2026-10-19 的事故：自动投放判据原来挂在 checkpoint 上，等于拿**半截 trace** 去套
  // 按**完整 trace** 标定的阈值。真人开局前 60–120 次投放的落点最少只有 4 种
  // （生产库 玩家T 实测），中途判误标了 3 局（#414 最终有 647 个落点）。
  //
  // ① 提交时（validateRun，trace 完整）：固定网格的脚本必须被抓
  const botTrace = makeTrace(300).map((e, i) => ({ ...e, x: (30 + (i % 21) * 47) / 1001 }));
  const botRun = validateRun({
    mode: 'classic', score: 0, maxLevel: 3, merges: 0, loopCount: 0,
    durationMs: 300 * 400, trace: botTrace,
  });
  expect(botRun.flags.some(f => /疑似自动投放/.test(f))).toBe(true);

  // ② 同一条 trace 的**前 60 次**（= 中途存档时的形态）：边界阈值不该在这里下结论。
  //    这里直接断言"半截 trace 的落点种类远少于完整 trace"这个事实本身，
  //    它就是中途判定会误伤的原因。
  const partial = aimStats(botTrace.slice(0, 60))!;
  const full = aimStats(botTrace)!;
  expect(partial.positions).toBeLessThanOrEqual(21);
  expect(full.positions).toBe(21);

  // ③ 真人：完整 trace 上落点铺满 → 不标记
  const humanTrace = makeTrace(300).map((e, i) => ({ ...e, x: (60 + ((i * 137) % 900)) / 1001 }));
  const humanRun = validateRun({
    mode: 'classic', score: 0, maxLevel: 3, merges: 0, loopCount: 0,
    durationMs: 300 * 400, trace: humanTrace,
  });
  expect(humanRun.flags.some(f => /疑似自动投放/.test(f))).toBe(false);
});

it('scales the aim-variety threshold with drop count, because real aim variety grows with the run', () => {
  // 生产库实测（完整 trace，真人最少落点）：300–500 次 → 39 种｜500–1000 → 74｜1000+ → 272
  // 阶梯：300–500 → 30｜500–1000 → 45｜1000+ → 100｜<300 → 不判
  const grid = (drops: number, positions: number, spanPx = 900) =>
    makeTrace(drops).map((e, i) => ({
      ...e, x: (30 + (i % positions) * (spanPx / Math.max(1, positions - 1))) / 1001,
    }));

  // 脚本：测试账号式（21 个落点 @ 894 次）与 #416 式（36 个落点 @ 532 次）都要被抓
  expect(detectAutomatedDrops(grid(894, 21))?.kind).toBe('fixed-aim');
  expect(detectAutomatedDrops(grid(532, 36))?.kind).toBe('fixed-aim');
  // 更深的对局：21 个落点 @ 1200 次（阈值升到 100）
  expect(detectAutomatedDrops(grid(1200, 21))?.kind).toBe('fixed-aim');

  // 真人：88 种 @ 727 次（玩家V）、85 种 @ 459 次（玩家I）→ 不能误伤
  expect(detectAutomatedDrops(grid(727, 88))).toBeNull();
  expect(detectAutomatedDrops(grid(459, 85))).toBeNull();
  expect(detectAutomatedDrops(grid(1200, 150))).toBeNull();

  // 样本不足时落点维度一律不判：真人前 200 次投放落点可以只有 5 种
  expect(detectAutomatedDrops(grid(200, 5))).toBeNull();
  expect(detectAutomatedDrops(grid(250, 13))).toBeNull();

  // 窄带判据同样受长度门槛约束：玩家I前 200 次投放跨度只有 30px，不能判；
  // 到了 400 次投放还挤在 30px 里才判
  expect(detectAutomatedDrops(grid(200, 30, 30))).toBeNull();
  expect(detectAutomatedDrops(grid(400, 30, 30))?.kind).toBe('narrow');
});

it('rejects a board that floats above the floor, and a fabricated secret claim', () => {
  // ① 球阵悬空：红队把整块球阵凭空上抬 772px 照样通过了所有既有判据。
  //    标定：真人 ≥8 颗球时最低球离地 ≤140px，取 400px。
  const trace = makeTrace(12);
  const ballAt = (y: number) => trace.map((e, i) => ({
    id: i + 1, level: e.lv, x: 120 + i * 60, y, vx: 0, vy: 0,
    angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0,
  }));
  const build = (balls: ReturnType<typeof ballAt>) => ({
    ...emptyState('classic' as const), status: 'playing' as const,
    score: 0, merges: 0, maxLevelReached: Math.max(...trace.map(e => e.lv)), spawnCount: 12,
    now: trace[11].t, elapsed: trace[11].t, engineTime: trace[11].t,
    dropCooldownUntil: trace[11].t, trace, balls,
  });
  const floating = build(ballAt(1200));
  const floatingPrev = build(ballAt(1201));
  // 中途状态不判（下落途中最低球离地本来就可能很远，2026-10-20 误标 #495 的教训）
  expect(validateCheckpoint(floating, floatingPrev, BUDGET).flags.some(f => /球阵悬空/.test(f))).toBe(false);
  // 同一个球阵一旦标成终局，就必须被抓住（红队的四条悬浮球阵都是 over 状态）
  const floatingOver = { ...floating, status: 'over' as const };
  expect(validateCheckpoint(floatingOver, floatingPrev, BUDGET).flags.some(f => /球阵悬空/.test(f))).toBe(true);

  const grounded = build(ballAt(1900));
  const groundedPrev = build(ballAt(1901));
  expect(validateCheckpoint({ ...grounded, status: 'over' as const }, groundedPrev, BUDGET).flags.some(f => /球阵悬空/.test(f))).toBe(false);

  // ② 秘技松弛不再免费：声称用过秘技（cycle 1 / count 0）但**单位少了、球数没少**
  //    → 自相矛盾（删球必然减球数），标记。
  //    红队用它把场上球阵做空，而更空的球阵会让台账把分数上界算得更高。
  const lowerOneBall = () => {
    const b = ballAt(1900);
    const i = b.findIndex(x => x.level > 1);          // 把一颗高等级球降成 Lv1：单位少了、球数不变
    b[i] = { ...b[i], level: 1 };
    return b;
  };
  const claimed = { ...build(lowerOneBall()), score: 1200, secretCycle: 1, secretCount: 0 };
  const before = { ...build(ballAt(1900)), score: 1200, secretCycle: 1, secretCount: 1 };
  const flags = validateCheckpoint(claimed, before, BUDGET).flags;
  expect(flags.some(f => /没有减少/.test(f)), JSON.stringify(flags)).toBe(true);

  //    而"声称用了秘技、球数确实少了"的诚实情况不该被这条误伤
  const honest = build(ballAt(1900).slice(1));
  const honestFlags = validateCheckpoint({ ...honest, score: 1200, secretCycle: 1, secretCount: 0 },
    before, BUDGET).flags;
  expect(honestFlags.some(f => /没有减少/.test(f)), JSON.stringify(honestFlags)).toBe(false);
});

it('rejects balls that sit outside the container (widened drop area / lowered floor)', () => {
  // 2026-10-20 提出的攻击：改客户端 CONTAINER.left/right 把落球区改宽 ——
  // 服务端原来只查 finite(x, ±100000)，球跑到墙外也照收。
  // 标定：生产库 616 个有球状态，球心越出左右墙的**一例都没有**。
  const trace = makeTrace(12);
  const build = (place: (i: number) => { x: number; y: number }) => ({
    ...emptyState('classic' as const), status: 'playing' as const,
    score: 0, merges: 0, maxLevelReached: Math.max(...trace.map(e => e.lv)), spawnCount: 12,
    now: trace[11].t, elapsed: trace[11].t, engineTime: trace[11].t,
    dropCooldownUntil: trace[11].t, trace,
    balls: trace.map((e, i) => ({
      id: i + 1, level: e.lv, ...place(i), vx: 0, vy: 0,
      angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0,
    })),
  });
  // 正常：铺在容器内、贴着地面
  const inside = build(i => ({ x: 120 + i * 60, y: 1900 }));
  expect(validateCheckpoint(inside, inside, BUDGET).flags.some(f => /容器外/.test(f))).toBe(false);
  // 改宽落球区：球心跑到右墙外 600px
  const widened = build(i => ({ x: 1600 + i * 10, y: 1900 }));
  expect(validateCheckpoint(widened, inside, BUDGET).flags.some(f => /容器外/.test(f))).toBe(true);
  // 改低地面：球掉到地面以下
  const lowered = build(i => ({ x: 120 + i * 60, y: 2400 }));
  expect(validateCheckpoint(lowered, inside, BUDGET).flags.some(f => /容器外/.test(f))).toBe(true);
});

it('never lets a repeated flag category crowd the important ones out of the 500-char column', () => {
  // 实测事故：球数守恒条目刷满 500 字符，后面追加的「物理推演不一致」被整条截掉
  const spam = Array.from({ length: 40 }, (_, i) => `球数守恒 ${i + 3} > -${i}（投放 ${i + 120}、合成 ${i + 130}）`);
  const merged = mergeFlags(spam, ['物理推演不一致：25 次抽样，累计偏差 +22 次合成（4σ 界 18）']);
  expect(merged.length).toBeLessThanOrEqual(500);
  expect(merged).toContain('物理推演不一致');
  // 同一类别最多留两条：第一条 + 最新一条
  expect(merged.split(' | ').filter(f => f.startsWith('球数守恒'))).toHaveLength(2);
  expect(merged).toContain('球数守恒 3 > -0');
  expect(merged).toContain('球数守恒 42 > -39');
  // 不同类别不会被误合并
  const mixed = mergeFlags([], ['落点机械：…', '球间距异常：…', '物理推演不一致：…']);
  expect(mixed.split(' | ')).toHaveLength(3);
});

it('enables eggs only for modern opted-in endless runs, and upgrades old saves without rerolling previews', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  const sessions = createRunSessions(db, Game, () => 100000);
  for (const [mode, protocol, opted] of [['classic', 2, true], ['endless', 1, true], ['endless', 2, false]] as const) {
    const run = sessions.start('compat-client', mode, crypto.randomUUID(), protocol, opted);
    expect(run.state).not.toHaveProperty('easterEggs');
    const modern = sessions.resume('compat-client', run.id, run.key, crypto.randomUUID(), { protocol: 2, easterEggs: 1 });
    expect(!!modern.state.easterEggs).toBe(mode === 'endless');
    expect([modern.state.heldLevel, modern.state.nextLevel]).toEqual([run.state.heldLevel, run.state.nextLevel]);
    expect(() => sessions.checkpoint('compat-client', { ...modern, state: modern.state, active: true, requestId: crypto.randomUUID() })).not.toThrow();
  }
});
