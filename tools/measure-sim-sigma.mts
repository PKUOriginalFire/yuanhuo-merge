// 上线前验证 3：把判据从"比值 0.5"换成随机游走 4σ 界，先量 σ 随窗口长度的变化
//   σ(n) 是单窗口 "重放合成数 − 客户端合成数" 的标准差。
//   真玩家累计偏差 ≈ 均值 0、标准差 σ√n 的随机游走；
//   每窗口注水 k 次的伪造者累计偏差 ≈ k·n（线性增长）。
//   判据：|累计偏差| > 4·σ·√n  → 真人误报 p ≈ 6e-5，注水 k≥… 直接被抓。
import { Game as ClientGame } from '../web/src/game.ts';
import { Game as SimGame } from '../server/sim/game.js';

const STEP = 1000 / 60;

function play(seed, steps) {
  const g = new ClientGame('classic', {}, seed, false);
  g.start();
  const snaps = [];
  let n = 0, nextDrop = 0, drops = 0;
  for (let i = 0; i < 20000 && g.status === 'playing'; i++) {
    g.update(16.0 + Math.random() * 1.4); n++;
    if (n >= nextDrop) { g.setAimX(220 + ((drops * 137) % 640)); g.drop(); drops++; nextDrop = n + 26; }
    if (n % steps === 0) snaps.push(g.snapshot());
  }
  snaps.push(g.snapshot());
  g.destroy();
  return snaps;
}

function replay(a, b) {
  const sim = SimGame.restore(a, {});
  const pending = b.trace.filter(e => e.t > a.elapsed && e.t <= b.elapsed);
  let i = 0, guard = 0;
  while (sim.elapsed < b.elapsed && sim.status === 'playing' && guard++ < 2000) {
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

const SEEDS = [4242, 777, 99991, 31337, 5150, 2024, 8888, 13];

for (const [label, steps, ms] of [
  ['1.0 秒窗口', 60, 1000],
  ['1.6 秒窗口', 96, 1600],
  ['2.5 秒窗口', 150, 2500],
] as const) {
  const dm = [];
  let skipped = 0, ms2 = 0;
  for (const seed of SEEDS) {
    const snaps = play(seed, steps);
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1], b = snaps[i];
      if (b.elapsed - a.elapsed <= 0) continue;
      const t0 = process.hrtime.bigint();
      let sim;
      try { sim = replay(a, b); } catch { skipped++; continue; }
      ms2 += Number(process.hrtime.bigint() - t0) / 1e6;
      if (!sim) { skipped++; continue; }
      dm.push(sim.merges - b.merges);
    }
  }
  const n = dm.length;
  const mean = dm.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(dm.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  console.log(`=== ${label}（${n} 个窗口，跳过 ${skipped}，平均 ${(ms2 / Math.max(n + skipped, 1)).toFixed(1)}ms）`);
  console.log(`  σ = ${sd.toFixed(3)}   均值 = ${mean.toFixed(3)}   范围 ${Math.min(...dm)} … ${Math.max(...dm)}`);
  // 4σ 界在不同抽样次数下能不能过真人、能不能抓注水
  for (const checks of [20, 40, 80]) {
    const bound = 4 * sd * Math.sqrt(checks);
    console.log(`  ${String(checks).padStart(3)} 次抽样 → 界 ${bound.toFixed(1)}；`
      + `注水 +0.5/窗口=${(0.5 * checks).toFixed(0)}，+1/窗口=${checks} → `
      + `${0.5 * checks > bound ? '都抓' : (checks > bound ? '只抓 +1' : '都抓不住')}`);
  }
  console.log('');
}
