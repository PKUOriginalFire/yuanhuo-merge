// 上线前验证 2：增量校验的最坏情况 CPU 成本（满屏球 + 3 秒窗口）
//   生产参数：sample 0.2、minIntervalMs 5000、maxWindowMs 3000、maxChecks 200
//   这里故意用最坏窗口，算出单 worker 在极端并发下的 CPU 占比
import { Game as ClientGame } from '../web/src/game.ts';
import { Game as SimGame } from '../server/sim/game.js';

const STEP = 1000 / 60;

function playToFullBoard(seed) {
  const g = new ClientGame('endless', {}, seed, false);
  g.start();
  const snaps = [];
  let steps = 0, nextDrop = 0, drops = 0;
  for (let i = 0; i < 12000 && g.status === 'playing'; i++) {
    g.update(STEP); steps++;
    if (steps >= nextDrop) { g.setAimX(220 + ((drops * 137) % 640)); g.drop(); drops++; nextDrop = steps + 26; }
    if (steps % 60 === 0) snaps.push({ state: g.snapshot(), balls: g.snapshot().balls.length });
  }
  g.destroy();
  return snaps;
}

function replay(a, b) {
  const sim = SimGame.restore(a, {});
  const pending = b.trace.filter(e => e.t > a.elapsed && e.t <= b.elapsed);
  let i = 0, guard = 0;
  while (sim.elapsed < b.elapsed && sim.status === 'playing' && guard++ < 1000) {
    while (i < pending.length && sim.elapsed >= pending[i].t) {
      const e = pending[i];
      sim.heldLevel = e.lv; sim.setAimX(62 + e.x * 1001);
      if (!sim.drop()) { sim.destroy(); return null; }
      i++;
    }
    sim.update(STEP);
  }
  const out = sim.snapshot(); sim.destroy(); return out;
}

const samples = [];
for (const seed of [4242, 777, 99991, 31337]) samples.push(...playToFullBoard(seed));
console.log(`收集 ${samples.length} 个快照，最大球数 ${Math.max(...samples.map(s => s.balls))}`);

// 取"球最多"的那些窗口，每 3 秒一段（最坏窗口长度）
const heavy = [];
for (let i = 3; i < samples.length; i++) {
  if (samples[i].balls >= 40) heavy.push([samples[i - 3].state, samples[i].state]);
}
heavy.sort((x, y) => y[1].balls.length - x[1].balls.length);
const pick = heavy.slice(0, 40);
console.log(`重球窗口 ${pick.length} 个（窗口 3 秒，球数 ${pick[0]?.[1].balls.length}…${pick[pick.length - 1]?.[1].balls.length}）`);

const times = [];
for (const [a, b] of pick) {
  const t0 = process.hrtime.bigint();
  replay(a, b);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
times.sort((x, y) => x - y);
const p = q => times[Math.min(times.length - 1, Math.floor(q * times.length))];
console.log(`单窗口重放耗时  p50 ${p(0.5).toFixed(1)}ms  p90 ${p(0.9).toFixed(1)}ms  max ${times[times.length - 1].toFixed(1)}ms`);

// CPU 预算：单 worker 里，每个玩家最多每 5 秒触发一次（minIntervalMs），再 ×sample 0.2
const perPlayerPerSec = 0.2 / 5;
for (const players of [10, 20, 40]) {
  const cost = players * perPlayerPerSec * p(0.9);   // ms/s
  console.log(`  ${String(players).padStart(3)} 名在线玩家 → 平均 ${cost.toFixed(2)} ms/s CPU（${(cost / 10).toFixed(2)}% 单核）`);
}
console.log('');
console.log('  注：maxChecks=200 封顶，单局最多 200 × p90，即'
  + `${(200 * p(0.9) / 1000).toFixed(2)}s CPU；主流局分不到 100 次抽检。`);
