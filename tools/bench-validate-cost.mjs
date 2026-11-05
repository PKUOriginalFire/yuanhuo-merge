// 定位成本：校验本身 vs JSON 解析/序列化 vs 数据库写入
import { validateCheckpoint } from '../server/checkpoint.js';

const TUTORIAL = [1, 1, 2, 2, 3];
function makeState(n) {
  const trace = [];
  for (let i = 0; i < n; i++) {
    let lv = TUTORIAL[i] ?? 1;
    if (i >= TUTORIAL.length) lv = 1 + ((i * 2654435761) % 5);
    trace.push({ t: 400 * i, x: Number((0.03 + ((i * 7919) % 940) / 1001).toFixed(4)), lv });
  }
  const units = trace.reduce((s, e) => s + 2 ** (e.lv - 1), 0);
  const balls = [];
  let left = units, id = 1;
  for (let lv = 11; lv >= 1 && balls.length < 512; lv--) {
    const u = 2 ** (lv - 1);
    while (left >= u && balls.length < 512) {
      balls.push({ id: id++, level: lv, x: 100 + (id % 800), y: 1000, vx: 0, vy: 0, angle: 0, angularVelocity: 0, deltaTime: 16.666, bornAt: 0 });
      left -= u;
    }
  }
  const elapsed = 400 * (n - 1) + 1000;
  return {
    version: 1, mode: 'endless', status: 'over',
    score: 0, merges: n - balls.length, loopCount: 0, maxLevelReached: 11,
    heldLevel: 1, nextLevel: 2, heldX: 562, spawnCount: n,
    now: elapsed, elapsed, accumulator: 0, dropCooldownUntil: elapsed, overLineSince: null,
    engineTime: elapsed, randomState: 12345, secretCount: 0, secretCycle: 0,
    trace, balls, resonatedPairs: [],
  };
}
const zero = {
  version: 1, mode: 'endless', status: 'playing', score: 0, merges: 0, loopCount: 0, maxLevelReached: 1,
  heldLevel: 1, nextLevel: 2, heldX: 562, spawnCount: 0, now: 0, elapsed: 0, accumulator: 0,
  dropCooldownUntil: 0, overLineSince: null, engineTime: 0, randomState: 1, secretCount: 0, secretCycle: 0,
  trace: [], balls: [], resonatedPairs: [],
};

console.log('trace 条数   请求体   校验耗时   校验+序列化   备注');
for (const n of [500, 2000, 8000, 20000]) {
  const state = makeState(n);
  const bytes = JSON.stringify(state).length;
  const prev = JSON.parse(JSON.stringify(zero));
  // 冷路径：走完整校验（playing → over 的分支）
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) validateCheckpoint(state, prev, 1e9);
  const cold = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  // 热路径：上一次已经是 over（真实对局大部分时间走这条）
  const prevOver = JSON.parse(JSON.stringify(state));
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) validateCheckpoint(state, prevOver, 1e9);
  const hot = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  // 纯 JSON 往返（parse + stringify）
  const json = JSON.stringify(state);
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) JSON.stringify(JSON.parse(json));
  const jsonCost = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  console.log(`${String(n).padStart(9)}  ${(bytes / 1024).toFixed(0).padStart(6)}KB  ${cold.toFixed(2).padStart(7)}ms  ${hot.toFixed(2).padStart(10)}ms  ${hot.toFixed(2).padStart(10)}ms  JSON 往返 ${jsonCost.toFixed(2)}ms`);
}
