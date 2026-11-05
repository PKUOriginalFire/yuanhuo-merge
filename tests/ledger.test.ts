import { expect, it } from 'vitest';
import { Game } from '../web/src/game';
import { ledgerFlag } from '../server/validate.js';
import { validateCheckpoint } from '../server/checkpoint.js';

/** 用真客户端打一局，返回终局快照 */
function play(mode: string, seed: number, maxDrops: number) {
  const g = new Game(mode as 'classic' | 'endless', {}, seed, false);
  g.start();
  let steps = 0, nextDrop = 0, drops = 0;
  while (steps < 20000 && g.status === 'playing' && drops < maxDrops) {
    g.update(1000 / 60); steps++;
    if (steps >= nextDrop) { g.setAimX(200 + ((drops * 137) % 700)); g.drop(); drops++; nextDrop = steps + 30; }
  }
  const snapshot = g.snapshot();
  g.destroy();
  return snapshot;
}

it('accepts real games exactly: the ball ledger is an equality, not a heuristic', () => {
  // 本地六个真实对局：上报的分数/合成数**精确等于**台账上界（比值 1.00）
  for (const mode of ['classic', 'endless'] as const) {
    for (const seed of [4242, 777, 99991]) {
      const s = play(mode, seed, 150);
      const flag = ledgerFlag({
        mode: s.mode, trace: s.trace, balls: s.balls, merges: s.merges,
        score: s.score, loopCount: s.loopCount,
      });
      expect(flag, `${mode}/${seed}: ${flag}`).toBe('');
    }
  }
}, 30_000);

it('only judges the ledger on the final state, because a mid-run board is transient', () => {
  // 2026-10-20 线上事故：玩家D 的 9362 分无尽局（落点 348 种、物理推演偏差 −4）被台账误毙。
  // 原因是把台账挂在了每次中途存档上 —— 无尽模式循环刚吃掉两个完全体、回收的 Lv1 球
  // 还没参与合成的那一刻，上界会被瞬时压低，分数看着就"超界"了。
  // 分数是单调的：终局能过 ⇒ 中途那次是假警报。所以只在 status === 'over' 时判。
  const s = play('endless', 4242, 150);
  const inflated = { ...s, score: s.score + 5000 };
  const base = {
    version: 1, mode: 'endless', merges: s.merges, maxLevelReached: s.maxLevelReached,
    spawnCount: s.spawnCount, now: s.elapsed, elapsed: s.elapsed, engineTime: s.elapsed,
    dropCooldownUntil: s.elapsed, trace: s.trace, balls: s.balls,
    heldLevel: 1, nextLevel: 1, heldX: 562, accumulator: 0, overLineSince: null,
    randomState: 1, secretCount: 0, secretCycle: 0, loopCount: s.loopCount, resonatedPairs: [],
  };
  const playing = validateCheckpoint({ ...base, score: inflated.score, status: 'playing' }, base, 1e9);
  expect(playing.flags.some(f => /台账上界/.test(f))).toBe(false);
  // 同一个状态一旦标成终局，就必须被抓住
  const over = validateCheckpoint({ ...base, score: inflated.score, status: 'over' }, base, 1e9);
  expect(over.flags.some(f => /台账上界/.test(f))).toBe(true);
});

it('catches every fabrication shape the red team used, from trace + board alone', () => {
  const s = play('classic', 4242, 150);
  const base = {
    mode: s.mode, trace: s.trace, balls: s.balls, merges: s.merges,
    score: s.score, loopCount: s.loopCount,
  };
  // ① 分数注水（红队-2 的形态：merges 自洽、分数翻倍）
  expect(ledgerFlag({ ...base, score: s.score * 2 })).toMatch(/分数 .* 超过台账上界/);
  // ② 合成数注水
  expect(ledgerFlag({ ...base, merges: s.merges + 10, score: s.score + 100 })).toMatch(/合成 .* 超过台账上界/);
  // ③ 空场伪造：清空球阵会把上界抬高，所以必须同时注水分数才构成攻击（红队/测试脚本 的形态）
  expect(ledgerFlag({ ...base, balls: [], score: s.score * 3 })).toMatch(/分数 .* 超过台账上界/);
  //    只清空球阵、不改分数 → 不构成越界（上界本身变宽了）
  expect(ledgerFlag({ ...base, balls: [] })).toBe('');
  // ④ 谎报循环次数（无尽模式）：M[11] 被 loopCount 初始化，上界只会更宽，
  //    所以这条不再由台账负责 —— 由单位守恒抓（谎报 1 次循环 = 凭空少 2047 单位）。
  const endless = play('endless', 777, 150);
  expect(ledgerFlag({
    mode: 'endless', trace: endless.trace, balls: endless.balls, merges: endless.merges,
    score: endless.score, loopCount: endless.loopCount + 3,
  })).toBe('');
  // ⑤ 极短对局不因取整抖动误标
  expect(ledgerFlag({
    mode: 'classic', trace: [{ t: 0, x: 0.5, lv: 1 }], balls: [], merges: 0, score: 0, loopCount: 0,
  })).toBe('');
});

it('bootstraps endless recycles from loopCount, because the recycle chain is self-referential', () => {
  // 2026-10-22 线上误判 #533（玩家S，无尽 4475 分）的真实数字回归。
  // 无尽模式的回收把两个完全体变回一个 Lv1 球，那个球又能继续合成 ——
  // 从 M[11]=0 起手迭代不出"能回收几次"，整条链系统性少算一次循环，
  // 差值恒为 565 分（Σ(k+1) k=1..10 = 65 分 + 500 循环奖励）与 11 次合成。
  const trace: { t: number; x: number; lv: number }[] = [];
  let t = 0;
  for (const [lv, n] of [[1, 315], [2, 236], [3, 212], [4, 130], [5, 66]] as const) {
    for (let i = 0; i < n; i++) { t += 400; trace.push({ t, x: 0.5, lv }); }
  }
  const balls = Object.entries({ 1: 4, 2: 4, 3: 6, 4: 4, 5: 3, 6: 1, 7: 2, 8: 3, 9: 2, 10: 1 })
    .flatMap(([lv, n]) => Array.from({ length: Number(n) }, (_, i) => ({ id: i + 1, level: Number(lv), x: 300, y: 1200 })));
  const base = { mode: 'endless', trace, balls, merges: 929, score: 4475 };
  // 用 loopCount=1 起手：真人上报值**精确等于**台账（等式成立，不再少算一次循环）
  expect(ledgerFlag({ ...base, loopCount: 1 })).toBe('');
  // 真注水仍然必须抓
  expect(ledgerFlag({ ...base, loopCount: 1, score: 9000 })).toMatch(/分数 .* 超过台账上界/);
});
