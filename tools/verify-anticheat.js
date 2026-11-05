/**
 * 防作弊校验的自检脚本。
 *
 * 核心问题：服务端算的「分数上界」会不会把真人误判成作弊？
 * 验证方法：造一个**贪心最优玩家**——它把每一步能合的都合掉，
 * 拿到的是给定投放序列下的数学最大分（真人做不到这么好）。
 * 如果连它都能通过校验，真人就绝不会被误杀。
 *
 * 运行：node tools/verify-anticheat.js
 */

import { validateRun, BASE_COEF, MIN_DROP_INTERVAL_MS, DROP_COUNT_GRACE } from '../server/validate.js';
import { simulate } from './simulate.js';

// ══════════════════════════════════════════════════════════

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failed++;
};

console.log(`\n基础系数 BASE_COEF = ${BASE_COEF.toFixed(4)}  (分数 ≤ 投放总量的 ${BASE_COEF.toFixed(2)} 倍)\n`);

// ── 1. 真人（贪婪最优）必须全部通过
console.log('【1】贪心最优玩家的成绩必须通过校验（不能误杀）');
for (const mode of ['classic', 'endless']) {
  for (const n of [10, 50, 200, 500, 1000, 2000]) {
    const r = simulate(mode, n, n * 7 + mode.length);
    const v = validateRun(r);
    const headroom = v.upper > 0 ? (v.upper / Math.max(1, r.score)).toFixed(2) : '-';
    check(
      `${mode.padEnd(8)} ${String(n).padStart(4)} 球  分数 ${String(r.score).padStart(7)}  上界 ${String(Math.floor(v.upper)).padStart(7)}  余量 ×${headroom}`,
      v.ok,
      v.ok ? '' : `\n       └─ ${v.flags.join('\n       └─ ')}`,
    );
  }
}
console.log('');

// ── 1b. 手速党必须通过
//
// 这一节是为了防一次**真实事故**：服务端的投放速率下限（当时 450ms）比前端的
// 投放冷却（400ms）还紧，于是按游戏允许的最快速度连点的玩家，每一局都被判作弊。
// 玩家看到的现象只是「我玩了但榜上没我」，极难排查。
//
// 现在断言：以 400ms（= DROP.cooldownMs，前端允许的最快速度）连点必须通过。
// 这个值从 web/src/config.ts 抄过来，改那边要一起改这里。
const FRONTEND_COOLDOWN_MS = 400;
console.log(`【1b】手速党：每 ${FRONTEND_COOLDOWN_MS}ms 投一颗（前端冷却上限）必须通过`);
for (const [mode, drops] of [['classic', 200], ['endless', 300], ['classic', 600]]) {
  const r = simulate(mode, drops, 4242, FRONTEND_COOLDOWN_MS);
  const v = validateRun(r);
  const maxAllowed = Math.floor(r.durationMs / MIN_DROP_INTERVAL_MS) + DROP_COUNT_GRACE;
  check(
    `${mode.padEnd(8)} ${String(drops).padStart(4)} 球 / ${FRONTEND_COOLDOWN_MS}ms 间隔` +
    `  投放 ${r.trace.length} ≤ 上限 ${maxAllowed}`,
    v.ok,
    v.ok ? '' : `\n       └─ ${v.flags.join('\n       └─ ')}`,
  );
}
console.log('');

// ── 2. 明显的作弊必须被拦下
console.log('【2】作弊 payload 必须被标记');
const legit = simulate('classic', 100, 42);

const cheats = [
  {
    name: '只投放 3 球却报 100 万分',
    p: { ...legit, score: 1_000_000, trace: legit.trace.slice(0, 3), durationMs: 3000, merges: 2 },
  },
  {
    name: '分数刚好是上界的 3 倍',
    p: { ...legit, score: Math.floor(validateRun(legit).upper * 3) },
  },
  {
    name: '投放等级超纲（Lv9）',
    p: { ...legit, trace: [...legit.trace.slice(0, 30), { t: 31000, x: 0.5, lv: 9 }], durationMs: 35000 },
  },
  {
    name: '开局第 1 球不是 Lv1',
    p: { ...legit, trace: [{ t: 0, x: 0.5, lv: 5 }, ...legit.trace.slice(1)] },
  },
  {
    name: '合成次数 > 投放次数',
    p: { ...legit, merges: legit.trace.length + 50 },
  },
  {
    name: '投放速率不物理（10 秒投 500 球）',
    p: {
      ...legit,
      trace: Array.from({ length: 500 }, (_, i) => ({ t: i * 20, x: 0.5, lv: 1 })),
      durationMs: 10_000,
      score: 400,
    },
  },
  {
    name: '上报最高等级 Lv11 但投放量不够',
    p: { ...legit, maxLevel: 11, trace: legit.trace.slice(0, 10), durationMs: 12000, score: 50 },
  },
  {
    name: '经典模式却报了循环次数',
    p: { ...legit, mode: 'classic', loopCount: 2 },
  },
  {
    name: '缺少操作序列',
    p: { mode: 'classic', score: 999999, maxLevel: 11, merges: 10, loopCount: 0, durationMs: 60000, trace: [] },
  },
];
for (const c of cheats) {
  const v = validateRun(c.p);
  check(c.name.padEnd(30), !v.ok, v.ok ? '← 漏了！' : `→ ${v.flags[0]}`);
}
console.log('');

// ── 3. 边界：刚好卡在上界附近应该放过
console.log('【3】边界：分数刚好等于上界（×1.0）应当放过，超出容忍系数应当拦下');
{
  const v = validateRun(legit);
  const atLimit = { ...legit, score: Math.floor(v.upper) };
  const overLimit = { ...legit, score: Math.ceil(v.upper * 1.5) };
  check('刚好在上界之内', validateRun(atLimit).ok);
  check('超过上界 1.5 倍', !validateRun(overLimit).ok);
}
console.log('');

// ── 3b. 上界放大攻击必须被挡
//
// 这是一次真实事故的回归测试：trace 完全由玩家自报，攻击者喂 20000 颗 Lv5
// 就能算出 312 个完全体，靠 C(n,2) 的二次共鸣奖励刷出 660 万分，
// **而且 suspicious=0**（后台可疑记录里什么都看不到）。
// 线上真实最高分当时只有 2917。
//
// 现在有两道防线：
//   ① units 按投放次数做统计封顶（挡住"全部上报 Lv5"）
//   ② 共鸣奖励取「数学 C(n,2)」和「物理同屏上限」的较小值
console.log('【3b】上界放大攻击：全 Lv5 的伪造 trace 必须被挡');
{
  const N = 20000;
  const makeTrace = (lv) => {
    const t = Array.from({ length: N }, (_, i) => ({ t: i * 1000, x: 0.5, lv }));
    t[0] = { t: 0, x: 0.5, lv: 1 };
    t[1] = { t: 1000, x: 0.5, lv: 1 };
    t[2] = { t: 2000, x: 0.5, lv: 2 };
    t[3] = { t: 3000, x: 0.5, lv: 2 };
    t[4] = { t: 4000, x: 0.5, lv: 3 };
    return t;
  };
  const base = {
    clientId: 'x'.repeat(20), mode: 'classic', maxLevel: 11,
    merges: 19999, loopCount: 0, durationMs: 21_600_000,
  };

  const attack = { ...base, score: 6_600_000, trace: makeTrace(5) };
  const v = validateRun(attack);
  console.log(`    全 Lv5 × ${N} 颗 → 上界 ${Math.floor(v.upper).toLocaleString()}`
    + `（改之前是 6,678,427）`);
  check('660 万分的伪造被拦下', !v.ok, v.flags[0] || '');

  // 反面对照：同样条数、但等级分布正常，应该放行
  const honest = simulate('classic', N, 31337, 1000);
  const vh = validateRun(honest);
  check(`同样 ${N} 颗但等级分布正常 → 放行`, vh.ok,
    vh.ok ? '' : vh.flags.join(' | '));

  // 上界不能因此塌到误杀：要明显高于贪心最优玩家的分
  check('上界仍远高于真实可得分', v.upper > 20000,
    `上界 ${Math.floor(v.upper)}`);
}
console.log('');

// ── 4. 打印几个样本，人工看看数值合不合理
console.log('【4】样本参考');
for (const mode of ['classic', 'endless']) {
  for (const n of [100, 500, 2000]) {
    const r = simulate(mode, n, 99);
    const v = validateRun(r);
    console.log(
      `  ${mode.padEnd(8)} ${String(n).padStart(4)} 球 → 分数 ${String(r.score).padStart(8)}` +
      `  最高Lv${String(r.maxLevel).padStart(2)}  合成 ${String(r.merges).padStart(5)}` +
      `  循环 ${String(r.loopCount).padStart(3)}  用时 ${(r.durationMs / 60000).toFixed(1)}min` +
      `  上界 ${Math.floor(v.upper)}`,
    );
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);
