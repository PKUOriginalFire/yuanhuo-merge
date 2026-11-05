// 上线前验证：增量校验在"生产同构"下的余量
//   服务端 Game = server/sim（生产就是这样），玩家 Game = web/src/game（真实客户端物理）
//   跑多个种子、两种节奏，统计 累计偏差/校验次数 的分布
import { DatabaseSync } from 'node:sqlite';
import { Game as ClientGame } from '../web/src/game.ts';
import { Game as SimGame } from '../server/sim/game.js';
import { createRunSessions } from '../server/sessions.js';

const STEP = 1000 / 60;

function oneRun(clientId, seed, dropEverySteps, jitter) {
  const db = new DatabaseSync(':memory:');
  let time = 100000;
  const sessions = createRunSessions(db, SimGame, () => time, { sim: { sample: 1, minIntervalMs: 0, maxChecks: 400 } });
  const startId = `start-${seed}-${dropEverySteps}-${jitter}`;
  const run = sessions.start(clientId, 'classic', startId, 2);
  const game = ClientGame.restore(run.state);
  let rev = run, steps = 0, drops = 0, nextDrop = dropEverySteps;
  for (let i = 0; i < 90 && game.status === 'playing'; i++) {
    // 每次存档前走 1 秒物理（带抖动，模拟真实帧率波动）
    const target = steps + 60;
    while (steps < target) {
      game.update(jitter ? 16.0 + Math.random() * 1.4 : STEP);
      steps++;
      if (steps >= nextDrop) { game.setAimX(220 + ((drops * 137) % 640)); game.drop(); drops++; nextDrop = steps + dropEverySteps; }
    }
    time += 1000;
    rev = sessions.checkpoint(clientId, { ...rev, state: game.snapshot(), active: true, requestId: crypto.randomUUID() });
  }
  const row = db.prepare('SELECT sim_checks, sim_bias FROM live_game WHERE id=?').get(run.id) as { sim_checks: number; sim_bias: number };
  game.destroy(); db.close();
  return { checks: row.sim_checks, bias: row.sim_bias, ratio: row.sim_checks ? Math.abs(row.sim_bias) / row.sim_checks : 0, drops };
}

const configs = [
  [26, false, '稳定 26 步一投，恒定帧长'],
  [26, true, '稳定 26 步一投，帧长抖动'],
  [45, true, '慢节奏 45 步一投，帧长抖动'],
  [18, true, '快节奏 18 步一投，帧长抖动'],
];

const all = [];
for (const [drop, jitter, label] of configs) {
  const rows = [];
  for (const seed of [4242, 777, 99991, 31337, 5150]) rows.push(oneRun(`c-${seed}-${drop}`, seed, drop as number, jitter as boolean));
  const ratios = rows.map(r => r.ratio);
  const checks = rows.map(r => r.checks);
  const biases = rows.map(r => r.bias);
  all.push(...rows);
  console.log(`${label}`);
  console.log(`  校验次数 ${checks.join('/')}  累计偏差 ${biases.join('/')}  比值 ${ratios.map(r => r.toFixed(3)).join('/')}  最大 ${Math.max(...ratios).toFixed(3)}`);
}

const worst = Math.max(...all.map(r => r.ratio));
const med = all.map(r => r.ratio).sort((a, b) => a - b)[Math.floor(all.length / 2)];
const totalChecks = all.reduce((a, b) => a + b.checks, 0);
console.log('');
console.log(`总计 ${all.length} 局 / ${totalChecks} 次抽样校验`);
console.log(`  比值 中位数 ${med.toFixed(3)}   最差 ${worst.toFixed(3)}   阈值 0.5`);
console.log(`  余量 ${(0.5 / Math.max(worst, 1e-6)).toFixed(1)}×`);
