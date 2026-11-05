import {
  MAX_CLEARED_UNITS_PER_SECRET, MAX_SCORE_PER_DROP, MOTION_RULE, PACKING_RULE, GROUND_RULE, CONTAINER_RULE, MAX_RUN_MS,
  ballDiameter, DEATH_LINE_SLACK, DEATH_LINE_Y, FLOOR_Y, CONTAINER_LEFT, CONTAINER_RIGHT,
  isEasterEggLevel, ledgerFlag, scoreCurveFlag, validateRun,
} from './validate.js';

/**
 * 两次投放的最小合法间隔（毫秒）。
 *
 * ⚠️⚠️ 这个值必须**等于或小于**前端的投放冷却（`web/src/config.ts` 的 `DROP.cooldownMs = 400`），
 *      否则按游戏允许的最快速度连点的玩家会被判成作弊。
 *      线上 217 局真实对局实测：最短间隔 min = 400ms、p1 = 400ms，**一局都没有低于 400**。
 *      所以取 400 是零误伤，同时把 [390, 400) 这条缝焊死
 *      （红队就是靠 395ms 让服务端重放的 `drop()` 全部冷却冲突、静默跳过）。
 */
const MIN_DROP_GAP_MS = 400;

/**
 * 本地物理 + 服务端健全性检查（协议 2）。这不是重放证明，只是一道廉价的一致性关卡。
 *
 * ⚠️ 两类校验，失败时的处置必须不同：
 *
 *  · **硬校验** —— 结构/类型/取值范围、单调性、与墙上时间的一致性、终局不可变。
 *    真实客户端永远满足这些条件；一旦不满足，数据本身不可信（会让服务器存下畸形状态、
 *    或者把进度倒回去），所以直接 400。
 *
 *  · **软校验** —— 守恒律、validateRun、投放间隔指纹。
 *    这些是**启发式判定，不是证明**。它们已经两次把真实玩家打死：
 *      1) 球数守恒多写了 `+loopCount`（merges 已含循环合成）→ 无尽模式造出两个
 *         完全体之后，此后每一次存档都 400，整局报废；
 *      2) 秘技 `useSecret()` 会直接删球，不改 merges、不改 trace → 用一次秘技
 *         就撞破球数守恒和单位守恒。
 *    启发式的代价**只能是"进人工复核"**，不能是"报废玩家的对局"。
 *    所以这里不拒绝，只把原因记进 flags，由上层落到 run.suspicious，
 *    提交时不上榜、留给 /api/admin/flagged 复核。
 *
 * ⚠️ 硬校验失败时，`fail()` 的文案是**给日志看的**，不是给玩家看的 ——
 *    sessions.js 会把它吞成统一的 400 文案，只写进 console.warn。
 *    上一次"无尽模式循环后永久 400"就是因为日志里只有一句固定文案，
 *    排查花了几个小时。每条 fail 都必须自报家门。
 *
 * 返回 { state: 清洗后的状态, flags: 可疑原因（空数组 = 干净） }。
 */
export function validateCheckpoint(state, previous, elapsedBudget) {
  const fail = reason => { throw new Error(reason); };
  const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const integer = (v, min, max) => Number.isInteger(v) && finite(v, min, max);
  const flags = [];
  const soft = reason => { flags.push(reason); };

  if (!state || state.version !== 1 || state.mode !== previous.mode || !['playing', 'over'].includes(state.status)) fail('结构: 版本/模式/状态非法');
  if ((state.easterEggs !== undefined && state.easterEggs !== true)
    || !!state.easterEggs !== !!previous.easterEggs || (state.easterEggs && state.mode !== 'endless')) fail('结构: 彩蛋标记不一致');
  const egg = level => state.easterEggs === true && isEasterEggLevel(level);
  const droppable = level => integer(level, 1, 5) || egg(level);
  if (previous.status === 'over') {
    for (const key of ['status', 'score', 'elapsed', 'merges', 'loopCount', 'spawnCount', 'maxLevelReached', 'secretCount', 'secretCycle']) if (state[key] !== previous[key]) fail(`终局不可变: ${key}`);
    if (JSON.stringify(state.trace) !== JSON.stringify(previous.trace)) fail('终局不可变: trace');
    return { state: previous, flags }; // Restoring remaps Matter body ids, but can never change a completed result.
  }
  for (const key of ['score', 'merges', 'loopCount', 'spawnCount', 'secretCycle']) {
    if (!integer(state[key], 0, key === 'score' ? 100000000 : 20000)) fail(`范围: ${key}=${state[key]}`);
    if (state[key] < previous[key]) fail(`倒退: ${key} ${previous[key]} → ${state[key]}`);
  }
  if (!integer(state.maxLevelReached, previous.maxLevelReached, 11)) fail(`范围: maxLevelReached=${state.maxLevelReached}`);
  if (!droppable(state.heldLevel)) fail(`范围: heldLevel=${state.heldLevel}`);
  if (!droppable(state.nextLevel)) fail(`范围: nextLevel=${state.nextLevel}`);
  if (!finite(state.heldX, 0, 1080)) fail(`范围: heldX=${state.heldX}`);
  if (!integer(state.randomState, 0, 0xffffffff)) fail(`范围: randomState=${state.randomState}`);
  // Budget is anchored at session creation, not arrival time of a delayed older checkpoint.
  // ⚠️ 真正的防腐约束是 `elapsed ≤ 墙上时间 + 1.5 秒`（elapsedBudget）—— 这一条不能动。
  //    上限只是"人类不可能打这么久"的兜底；原来写死 6 小时，2026-10-22 把一位真玩家
  //    打了 6 小时的无尽局永久卡死在"存档失败"（见 validate.js 的 MAX_RUN_MS 注释）。
  if (!finite(state.elapsed, previous.elapsed, Math.min(MAX_RUN_MS, Math.max(0, elapsedBudget) + 1500))) fail(`时钟: elapsed=${state.elapsed} (预算 ${elapsedBudget})`);
  for (const key of ['now', 'engineTime']) {
    if (!finite(state[key], previous[key], MAX_RUN_MS)) fail(`倒退: ${key} ${previous[key]} → ${state[key]}`);
    if (Math.abs(state[key] - state.elapsed) > 100) fail(`时钟: ${key}=${state[key]} 与 elapsed=${state.elapsed} 相差过大`);
  }
  if (!finite(state.accumulator, 0, 100)) fail(`范围: accumulator=${state.accumulator}`);
  if (!finite(state.dropCooldownUntil, 0, state.now + 500)) fail(`范围: dropCooldownUntil=${state.dropCooldownUntil}`);
  if (state.overLineSince !== null && !finite(state.overLineSince, 0, state.now)) fail(`范围: overLineSince=${state.overLineSince}`);
  if (!Array.isArray(state.trace) || state.trace.length > 20000) fail('结构: trace 非法或过长');
  if (state.trace.length < previous.trace.length) fail(`倒退: trace ${previous.trace.length} → ${state.trace.length}`);
  if (state.spawnCount !== state.trace.length) fail(`结构: spawnCount=${state.spawnCount} 与 trace 长度 ${state.trace.length} 不一致`);
  let fastDrops = 0;
  for (let i = 0; i < state.trace.length; i++) {
    const e = state.trace[i], old = previous.trace[i];
    if (!e || !integer(e.t, 0, Math.ceil(state.elapsed) + 1) || !finite(e.x, 0, 1) || !droppable(e.lv)) fail(`结构: trace[${i}] 非法`);
    if (old && (e.t !== old.t || e.x !== old.x || e.lv !== old.lv)) fail(`已保存的投放被改写: trace[${i}]`);
    if (i && e.t - state.trace[i - 1].t < MIN_DROP_GAP_MS) fastDrops++;
  }
  // 投放间隔指纹：前端 `DROP.cooldownMs = 400`，**UI 根本不允许**比这更快的投放。
  // 线上 217 局真实对局的最短间隔 min = 400、p1 = 400，一局都没有低于 400，
  // 所以阈值取 400 是零误伤。
  //
  // ⚠️ 阈值从 390 提到 400 是 2026-10-20 红队实测逼出来的：
  //    相邻投放间隔落在 [390, 400) 时三件事同时成立 —— 不触发这里、
  //    每个窗口的服务端重放都因投放冷却冲突返回 null（sim_checks 恒 0）、
  //    节拍判据的 600ms 下限也够不到 —— 等于一张"免检通行证"。
  if (fastDrops) soft(`投放间隔 ${fastDrops} 处 <${MIN_DROP_GAP_MS}ms`);
  // ⚠️ 自动投放（落点机械 / 定时器宏）**不在这里判**。
  //    它的阈值是按**完整 trace** 标定的（真人最少 158 种落点），而 checkpoint 拿到的是
  //    "到目前为止"的半截 trace —— 真人开局前 60–120 次投放的落点最少只有 4 种，
  //    中途判必然误伤（线上误标过 3 局，#414 的最终 trace 有 647 个落点）。
  //    现在挪到 validate.js 的 validateRun（提交时、trace 完整）。
  // 台账不变量：分数由 trace 等级分布 + 当前球阵唯一约束（见 validate.js 的 ledgerFlag）。
  // 这是唯一一条"不是启发式、而是游戏规则本身"的判据 —— 逐级球守恒。
  // 秘技删除只会让实际合成数更少，所以台账始终是上界，零误伤。
  //
  // ⚠️ 只在**终局**（status === 'over'）判定，2026-10-20 线上事故换来的：
  //    台账的上界依赖"当前球阵"，而中途球阵是瞬时状态 —— 比如无尽模式的循环
  //    刚吃掉两个完全体、回收的 Lv1 球还没来得及参与合成，那一刻的上界会被压低，
  //    于是分数看着"超界"。但分数是单调的：终局能过，就说明中途那次是假警报。
  //    实测 玩家D 的 9362 分无尽局（落点 348 种、物理推演 200 次偏差 −4）就是这么被误毙的，
  //    而用它的终局重算完全在界内。红队的伪造全部以 over 状态提交，照样会在这里被抓住。
  if (state.status === 'over') {
    const ledger = ledgerFlag({
      mode: state.mode, trace: state.trace, balls: state.balls,
      merges: state.merges, score: state.score, loopCount: state.loopCount,
    });
    if (ledger) soft(ledger);
  }
  const cycles = state.mode === 'classic' ? (state.score >= 1000 ? 1 : 0) : Math.floor((state.score + 2000) / 3000);
  if (!integer(state.secretCycle, 0, cycles)) fail(`秘技: secretCycle=${state.secretCycle} 超出分数允许的 ${cycles}`);
  if (!integer(state.secretCount, 0, state.secretCycle)) fail(`秘技: secretCount=${state.secretCount} 超出 secretCycle=${state.secretCycle}`);
  if (state.secretCount > previous.secretCount + state.secretCycle - previous.secretCycle) fail('秘技: 使用次数倒流');

  if (!Array.isArray(state.balls) || state.balls.length > 512) fail('结构: balls 非法或超过 512 颗');
  const ids = new Set();
  /** 场上球的单位总量（彩蛋球不折算单位） */
  let unitsInBalls = 0;
  /** 跑到容器外面的球（改宽落球区 / 把地面改低）*/
  let outside = 0, worstOutside = 0;
  for (const ball of state.balls) {
    if (!ball || !integer(ball.id, 0, Number.MAX_SAFE_INTEGER)) fail('结构: 球 id 非法');
    if (ids.has(ball.id)) fail(`结构: 球 id 重复 ${ball.id}`);
    if (!(integer(ball.level, 1, state.maxLevelReached) || egg(ball.level))) fail(`结构: 球 ${ball.id} 等级 ${ball.level} 非法`);
    ids.add(ball.id);
    for (const key of ['x', 'y', 'vx', 'vy', 'angle', 'angularVelocity']) if (!finite(ball[key], -100000, 100000)) fail(`结构: 球 ${ball.id}.${key} 非法`);
    if (!finite(ball.bornAt, 0, state.now)) fail(`结构: 球 ${ball.id}.bornAt 非法`);
    if (!finite(ball.deltaTime, 0.001, 100)) fail(`结构: 球 ${ball.id}.deltaTime 非法`);
    if (!isEasterEggLevel(ball.level)) unitsInBalls += Math.pow(2, ball.level - 1);
    // 球必须在容器里（标定见 validate.js 的 CONTAINER_RULE）
    const radius = ballDiameter(ball.level) / 2;
    const away = Math.max(
      CONTAINER_LEFT - CONTAINER_RULE.slackPx - ball.x,
      ball.x - (CONTAINER_RIGHT + CONTAINER_RULE.slackPx),
      ball.y - (FLOOR_Y + CONTAINER_RULE.slackPx + radius),
    );
    if (away > 0) { outside++; if (away > worstOutside) worstOutside = away; }
  }
  if (outside) {
    soft(`球跑到容器外：${outside} 颗球的球心越出容器边界 ${Math.round(worstOutside)}px`
      + `（真人 616 个状态里一例都没有；改宽落球区或改低地面就会这样）`);
  }
  // Eggs cannot merge or be cleared; each placed identity must survive every checkpoint.
  for (const level of [-1, -2]) {
    if (state.balls.filter(ball => ball.level === level).length !== state.trace.filter(e => e.lv === level).length) fail(`彩蛋 ${level} 数量与投放数不一致`);
  }

  // ── 守恒律（软校验）──────────────────────────────────────────────────────
  //
  //   每次投放 +1 球；每次合成 -1 球。无尽模式的循环合成同样 merges++，
  //   所以球数守恒是
  //       balls = spawnCount − merges
  //   **不能再加 loopCount**（上一版多写了，见文件头的回归说明）。
  //
  //   单位守恒：两个 Lv n（2 × 2^(n−1)）正好等于一个 Lv(n+1)（2^n），合成不改变
  //   单位总量；唯一的例外是循环 —— 吃掉两个完全体（2048）吐回 Lv1（1），净 −2047：
  //       Σ 场上球 === Σ trace 单位 − 2047 × loopCount
  //
  //   秘技会直接删球（useSecret），既不改 merges 也不改 trace，删掉多少在服务端
  //   无法核验 —— 所以这局只要用过秘技，两条守恒律就退化成只查上界。
  //   秘技次数由分数唯一决定（classic 每局 1 次；endless 每 3000 分 1 次），
  //   攻击者不能凭空多要。
  {
    let unitsInTrace = 0;
    for (const e of state.trace) {
      if (!isEasterEggLevel(e?.lv)) unitsInTrace += Math.pow(2, (e?.lv ?? 1) - 1);
    }
    const expectedUnits = unitsInTrace - 2047 * state.loopCount;
    const secretUses = state.secretCycle - state.secretCount;
    const ballsCap = state.spawnCount - state.merges;
    if (state.balls.length > ballsCap) soft(`球数守恒 ${state.balls.length} > ${ballsCap}（投放 ${state.spawnCount}、合成 ${state.merges}）`);
    const cleared = expectedUnits - unitsInBalls;
    // ⚠️ 2026-10-20 红队指出这条分支的方向是反的：没用秘技的诚实玩家走严格校验，
    //    而**谎称用了秘技**的伪造者立刻换来 3200 单位/次的松弛 —— 松弛的直接后果是
    //    场上球阵可以更空，而更空的球阵会让下面「台账不变量」把分数上界算得更高。
    //    收紧：松弛只在"确实有单位凭空消失"时才给；声称用了秘技却一个单位没少，
    //    那就没有任何理由放宽。
    if (!secretUses || cleared <= 0) {
      if (state.balls.length !== ballsCap) soft(`球数守恒 ${state.balls.length} ≠ ${ballsCap}（投放 ${state.spawnCount}、合成 ${state.merges}）`);
      if (unitsInBalls !== expectedUnits) soft(`单位守恒 ${unitsInBalls} ≠ ${expectedUnits}（trace ${unitsInTrace}、循环 ${state.loopCount}）`);
    } else if (unitsInBalls > expectedUnits) {
      soft(`单位守恒 ${unitsInBalls} > ${expectedUnits}（trace ${unitsInTrace}、循环 ${state.loopCount}）`);
    } else {
      // 秘技删掉的单位无法逐颗核验，但**删得掉多少是有几何上界的**：
      // 秘技只清半径 180+球半径 内的球，而球两两不重叠，所以一次最多约 3200 单位。
      // 另外：单位既然少了，球数也必须少了（至少删掉一颗）。
      if (state.balls.length >= ballsCap) {
        soft(`秘技声称删除 ${cleared} 单位，但球数 ${state.balls.length} 没有减少（上限 ${ballsCap}）`);
      }
      if (cleared > MAX_CLEARED_UNITS_PER_SECRET * secretUses) {
        soft(`秘技删除 ${cleared} 单位，超出 ${secretUses} 次的几何上界 ${MAX_CLEARED_UNITS_PER_SECRET * secretUses}`);
      }
    }
  }

  // 球阵必须"落地"：球是刚体，最下面那颗必然压在容器地面上（球心距地面 ≈ 半径）。
  //
  // 2026-10-20 红队实测：把整块球阵凭空上抬 772px（离地悬空）照样通过所有既有判据 ——
  // 之前的"终局见证"只要求有一颗球顶越过死亡线、堆叠自洽只查最近邻间距。
  //
  // 标定（生产库 497 个 ≥3 颗球的状态，球心离地面 gap）：
  //   p1 = 43px、中位 45px、p99 = 263px；≥8 颗球时真人最大只有 **140px**
  //   红队四条悬浮球阵：1121 / 797 / 733 / 698px（全部是 over 状态）
  //
  // ⚠️ 只在**终局**判定，2026-10-20 线上误标 #495（玩家C）换来的：
  //    中途存档随时可能落进"底下几排刚合成掉、上方的球还在下落"的瞬时状态，
  //    那一刻最低球离地 451px 是**正常物理**（他那局有 1631 次存档，撞上瞬时的机会很大），
  //    而他的终局球阵最低球离地只有 45px（标准落地、速度全 0）。
  if (state.status === 'over' && state.balls.length >= 8) {
    const lowest = Math.max(...state.balls.map(b => b.y));
    if (FLOOR_Y - lowest > GROUND_RULE.maxGapPx) {
      soft(`球阵悬空：最低一颗球离地面还有 ${Math.round(FLOOR_Y - lowest)}px（真人实测 ≤140px），球不可能浮在空中`);
    }
  }

  // 终局见证：真实对局**只可能**因为堆过死亡线而结束（checkOverflow 是唯一入口），
  // 所以 `status: 'over'` 时场上必然至少有一颗球的球顶压在 deathLineY 之上。
  // 10 局真实对局（60/30/144/5fps）实测终局时压线球有 2–5 颗。
  // 这条挡住"空场 + 声称结束"这种退化伪造 —— 红队就是这么把空场写合法的。
  // 留 DEATH_LINE_SLACK 容差，防止哪天两边半径表漂移把真人误判。
  //
  // ⚠️ 2026-10-19：线上 #392（玩家X 1500 分）没有触发这一条而是**触发了**，
  //    但同一个人被确认是渗透测试者的另一个昵称，所以按"待查"处理，规则先不动。
  if (state.status === 'over'
    && !state.balls.some(ball => ball.y - ballDiameter(ball.level) / 2 < DEATH_LINE_Y + DEATH_LINE_SLACK)) {
    soft('终局但没有球压过死亡线');
  }
  // 每次投放的得分（软判定，理由见 validate.js 的 MAX_SCORE_PER_DROP）
  if (state.trace.length >= 40 && state.score > MAX_SCORE_PER_DROP * state.trace.length) {
    soft(`每次投放得分 ${(state.score / state.trace.length).toFixed(1)} 超出经验上界 ${MAX_SCORE_PER_DROP}`);
  }
  // 分数随时间的增长曲线（软判定，标定见 validate.js 的 SCORE_CURVE）。
  // 这条是"193 秒伪造登顶"那类攻击的主闸：一次投放 400ms 冷却 + 每次最多 12 分，
  // 意味着任何人在 T 秒内能报的分有硬上限；真人速率还远低于这个上限。
  {
    const curve = scoreCurveFlag(state.score, state.elapsed);
    if (curve) soft(curve);
  }
  if (!Array.isArray(state.resonatedPairs) || state.resonatedPairs.length > 4096 || state.resonatedPairs.some(p => typeof p !== 'string' || !/^\d{1,16}-\d{1,16}$/.test(p))) fail('结构: resonatedPairs 非法');

  // ── 球的物理自洽（两条，都是软标记）─────────────────────────────────────
  //
  // ① 位移连续性：两次存档之间同一颗球（按 id 匹配）不能瞬移。
  //    标定见 validate.js 的 MOTION_RULE。
  //
  //    ⚠️ 两道门槛都是必须的，2026-10-19 线上误标 #409 换来的：
  //      · 窗口太短时不判。旧代码用 `Math.max(1, elapsed差)`，两次存档之间游戏时间没推进
  //        （页面暂停 / 刷新 / 模态框拦住物理）时窗口变成 1ms，"允许位移"只剩 203px，
  //        任何位置变化都撞线。#409 就是这么被判的（球 9「1ms 内移动 883px」）。
  //        真人存档间隔中位数 2–3 秒，300ms 以下的窗口根本不含运动信息。
  //      · id 集合对不上时也不判。`resume` 走 Game.restore 会把球**重新编号**成 1..N，
  //        于是"球 9"前后可能指两颗不同的球。只有当前球里有足够高比例的 id 在上一帧存在时，
  //        同 id 才真的代表同一颗球。
  {
    const prevBalls = previous.balls ?? [];
    const prevById = new Map();
    for (const b of prevBalls) prevById.set(b.id, b);
    const dtMs = state.elapsed - previous.elapsed;
    const budget = MOTION_RULE.maxSpeedPxPerSec * (dtMs / 1000) + MOTION_RULE.slackPx;
    let compared = 0, worst = 0, worstId = 0;
    for (const b of state.balls) {
      const old = prevById.get(b.id);
      if (!old) continue;
      compared++;
      const d = Math.hypot(b.x - old.x, b.y - old.y);
      if (d > worst) { worst = d; worstId = b.id; }
    }
    // 至少一半的球能按 id 对上，才认为 id 没有整体重编号
    const overlapOk = compared * 2 >= Math.min(prevBalls.length, state.balls.length);
    if (dtMs >= MOTION_RULE.minWindowMs && compared >= 3 && overlapOk && worst > budget) {
      soft(`球位置跳变：球 ${worstId} 在 ${Math.round(dtMs)}ms 内移动 ${Math.round(worst)}px（上限 ${Math.round(budget)}px）`);
    }
  }
  // ② 终局堆叠自洽：专门抓「客户端把球半径改小」（标定见 PACKING_RULE）。
  if (state.status === 'over' && state.balls.length >= PACKING_RULE.minBalls) {
    const nn = [];
    for (let i = 0; i < state.balls.length; i++) {
      const a = state.balls[i];
      const ra = ballDiameter(a.level) / 2;
      let nearest = Infinity;
      for (let j = 0; j < state.balls.length; j++) {
        if (i === j) continue;
        const b = state.balls[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const ratio = d / (ra + ballDiameter(b.level) / 2);
        if (ratio < nearest) nearest = ratio;
      }
      if (Number.isFinite(nearest)) nn.push(nearest);
    }
    if (nn.length >= PACKING_RULE.minBalls) {
      nn.sort((x, y) => x - y);
      const median = nn[Math.floor(nn.length / 2)];
      if (median < PACKING_RULE.minMedianRatio) {
        soft(`终局球间距异常：相邻球间距只有半径和的 ${(median * 100).toFixed(0)}%（真人实测 99%），疑似改小了球的半径`);
      }
    }
  }
  if (state.trace.length) {
    const result = validateRun({ mode: state.mode, score: state.score, maxLevel: state.maxLevelReached,
      merges: state.merges, loopCount: state.loopCount, durationMs: Math.max(2000, state.elapsed), trace: state.trace });
    if (!result.ok) soft(...result.flags);
  } else if (state.score || state.merges || state.loopCount || state.maxLevelReached !== 1 || state.secretCount) fail('空对局却有分数/合成记录');
  // Strip unknown fields before storing or restoring a client snapshot.
  const clean = {};
  for (const key of ['version', 'mode', 'status', 'score', 'merges', 'loopCount', 'maxLevelReached', 'heldLevel', 'nextLevel', 'heldX', 'spawnCount', 'now', 'elapsed', 'accumulator', 'dropCooldownUntil', 'overLineSince', 'engineTime', 'randomState', 'secretCount', 'secretCycle']) clean[key] = state[key];
  clean.trace = state.trace.map(({ t, x, lv }) => ({ t, x, lv }));
  clean.balls = state.balls.map(({ id, level, x, y, vx, vy, angle, angularVelocity, deltaTime, bornAt }) => ({ id, level, x, y, vx, vy, angle, angularVelocity, deltaTime, bornAt }));
  clean.resonatedPairs = [...state.resonatedPairs];
  if (state.easterEggs) clean.easterEggs = true;
  return { state: clean, flags };
}
