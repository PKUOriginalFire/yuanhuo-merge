import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { validateCheckpoint } from './checkpoint.js';
import { cadenceFlag, LINE_RULE, overLineBlocked } from './validate.js';

export class SessionError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const token = () => randomBytes(32).toString('hex');
const same = (a, b) => typeof b === 'string' && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const requestId = value => {
  if (typeof value !== 'string' || value.length < 8 || value.length > 80) throw new SessionError('操作编号无效', 400);
  return value;
};
const STEP = 1000 / 60;

/**
 * 增量校验：服务端自己从**上一个存档**推演到**当前存档**，再和客户端报的结果比。
 *
 * 为什么这条能压住"伪造客户端"：
 *   伪造者可以直接编一个自洽的 state（伪造落点、伪造球阵、伪造分数），
 *   但他没法凭空造出一条**符合物理演化**的相邻帧序列 —— 除非他真的跑一遍 Matter。
 *   而一旦他真跑物理，他报的分数就是他选的落点真实打出来的分数，不能再随便编。
 *
 * 实测标定（8 个种子、真实引擎 + 真实帧长抖动，客户端 = web/src/game，服务端 = sim）：
 *   · 单窗口符号偏差（客户端 − 推演）零均值：
 *       1.0 秒窗口 σ=0.48（1008 窗口，均值 +0.03）
 *       1.6 秒窗口 σ=0.87（ 610 窗口，均值 +0.01）   ← 真人单次存档间隔中位数约 1.6 秒
 *       2.5 秒窗口 σ=1.33（ 386 窗口，均值 −0.04）
 *   · 推演耗时：1 秒窗口 11ms，3 秒满屏（64 球）窗口最坏 65ms
 *
 * 判据用**累计偏差**，并且按随机游走定界而不是定值比值：
 *   真玩家累计偏差 ~ 均值 0、标准差 σ√N 的随机游走；
 *   "每窗口注水"的伪造者累计偏差 ≈ k·N，线性增长。
 *   所以判 |Σ| > 4·σ·√N  —— 真人误报 p≈6e-5，而 +1 次合成/窗口的注水者远超此界。
 *   （早先用固定比值 0.5 会让"抽样次数少"的短局误报风险升高，这个式子跟着 N 自适应。）
 *
 * ⚠️ 只校验**短窗口**：几何发散随窗口变长而变大（实测 σ 从 0.48 涨到 1.33），
 *    所以只认 elapsed 增量 ≤ 3 秒的窗口；更长的直接跳过（不判）。
 *    这不是漏洞：存档节奏那条规则要求真人每分钟 ≥20 次存档（≤3 秒一次），
 *    故意拉长存档间隔来躲这条，就会撞上节奏规则。
 *
 * 返回 null（跳过/无法推演）或 { bias, ok }，bias = 客户端报的合成数 − 推演出的合成数。
 */
const SIM_RULE = {
  maxWindowMs: 3000,      // 只校验 ≤3 秒的窗口
  minIntervalMs: 1000,    // 同一秒内不重复抽（成本翻倍无收益）
  sample: 0.12,           // 每次存档 12% 概率抽检 → 10 分钟对局约 45 次
  maxChecks: 200,         // 单局最多校验 200 次（防超长对局吃 CPU）
  mergeTolerance: 3,      // 单窗口容差：实测 ±3 时真人 100% 通过
  sigma: 0.9,             // 单窗口偏差标准差上界（1.6 秒窗口实测 0.87）
  sigmaMultiple: 4,       // 4σ 界 → 真人误报 p≈6e-5
  minChecks: 20,          // 少于 20 次抽样统计上说明不了任何事（前 20 次无条件校验）
  /**
   * 「全部窗口都推演不了」的判据。红队实测：trace 间隔卡在 [390,400) 时
   * 每个窗口都会因投放冷却冲突返回 skip，sim_checks 恒 0 → 物理推演形同不存在。
   * 阈值取 0.8 而不是 0.3：真人顶着冷却连点实测冲突率 17/26 = 65%，0.3 会误伤手速党。
   */
  cooldownRatio: 0.8,
  minCooldownAttempts: 10,
};

/**
 * 累计偏差是否显著。返回''表示正常，否则返回给人看的原因。
 * 放在这里而不是 index.js，是因为它和 SIM_RULE 的标定值是绑定的。
 */
const SIM_FLAG_PREFIX = '物理推演不一致';
function simBiasFlag(checks, bias) {
  if (!(checks >= SIM_RULE.minChecks)) return '';
  const bound = SIM_RULE.sigmaMultiple * SIM_RULE.sigma * Math.sqrt(checks);
  if (!(Math.abs(bias) > bound)) return '';
  return `${SIM_FLAG_PREFIX}：${checks} 次抽样，累计偏差 ${bias > 0 ? '+' : ''}${bias} 次合成`
    + `（4σ 界 ${bound.toFixed(0)}，等于每窗口注水 ${(Math.abs(bias) / checks).toFixed(2)} 次；真人 |Σ| 通常 < 3）`;
}
export { SIM_RULE, simBiasFlag, SIM_FLAG_PREFIX, mergeFlags, dodgeFlag, DODGE_RULE };

function replayWindow(previous, state, rule, Game) {
  if (!(state.elapsed - previous.elapsed > 0) || state.elapsed - previous.elapsed > rule.maxWindowMs) return { skip: 'window' };
  // 秘技（删球）只体现在 secretCycle/secretCount 上，trace 里没有对应条目 ——
  // 这个窗口里用过秘技就没法推演（客户端删了球，服务端没删），跳过不判。
  const secrets = s => (s.secretCycle ?? 0) - (s.secretCount ?? 0);
  if (secrets(state) !== secrets(previous)) return { skip: 'secret' };
  // 非 playing 的窗口（暂停/结束）也不推演
  if (previous.status !== 'playing') return { skip: 'status' };
  let sim = null;
  try {
    sim = Game.restore(previous, {});
    // 这个窗口内客户端真实投放的那些球（trace 里 t 落在区间内的条目）
    const pending = state.trace.filter(e => e.t > previous.elapsed && e.t <= state.elapsed);
    let i = 0;
    let guard = 0;
    while (sim.elapsed < state.elapsed && sim.status === 'playing' && guard++ < 1000) {
      while (i < pending.length && sim.elapsed >= pending[i].t) {
        const e = pending[i];
        sim.heldLevel = e.lv;                                  // ← 必须用 trace 的等级，不能用模拟自己的 LCG
        sim.setAimX(62 + e.x * 1001);                          // x 是归一化到容器内宽的
        // 冷却冲突 → 这一窗推演不了。**但必须计数**：
        // 2026-10-20 红队实测，trace 间隔卡在 [390,400) 时每个窗口都会走到这里，
        // 于是 sim_checks 恒为 0、物理推演一次都不跑，2600 分零标记上榜。
        // 现在（a）投放间隔阈值提到 400 直接封死那条带，（b）这里的跳过也要计数报账。
        if (!sim.drop()) return { skip: 'cooldown' };
        i++;
      }
      sim.update(STEP);
    }
    if (guard >= 1000) return { skip: 'guard' };
    const bias = state.merges - sim.merges;
    return { bias, ok: Math.abs(bias) <= rule.mergeTolerance };
  } catch {
    return { skip: 'error' };
  } finally {
    if (sim) { try { sim.destroy(); } catch { /* 忽略 */ } }
  }
}

/**
 * 安全地给任意客户端输入算内容哈希。
 *
 * ⚠️ 必须有这个包装。`JSON.stringify` 是**递归**的，而这里要哈希的
 *    `input.state` / `input.action` 是**完全由客户端控制**的任意 JSON。
 *    红队实测：一个 20000 层嵌套的 `state` 会让 `JSON.stringify` 抛
 *    `RangeError: Maximum call stack size exceeded` —— 而这一步在校验之前，
 *    所以能**按需触发 500**（进程靠 uncaughtException 兜住没死，但 500 就是 500，
 *    还会往日志里刷错误行）。
 *
 *    这些哈希只用于「同一个 requestId 是否换了内容」的幂等判断，
 *    所以内容深到 stringify 不了的时候，直接当成非法请求拒掉即可。
 */
function contentHash(payload) {
  try {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } catch (error) {
    if (error instanceof RangeError) throw new SessionError('进度数据嵌套过深', 400);
    throw error;
  }
}

/**
 * 磁盘防线的三个闸门。
 *
 * ⚠️ 以前完全没有上限。红队实测：构造超大 state 仍然被 200 接受，配合
 *    「开局限流 120 次/分钟/IP」约 55MB/分钟，剩 15G 的盘几小时写满，
 *    写满之后全站写操作 500，而且 `systemctl restart` 救不回来（SQLite 不会自己缩）。
 *
 * 单行体积：`validateCheckpoint` 的白名单已经把 state 削到只剩已知字段，
 * 所以单行天然上限约 800KB（20000 条 trace + 512 颗球）。这里再留 25% 兜底。
 * 真正限制磁盘的是行数上限和 abandoned 的保留期。
 */
const LIMITS = {
  /**
   * 单行 state 字节上限。
   *
   * ⚠️ 2026-10-19 从 1MB 收到 320KB。原因：实测一次 635KB 的 checkpoint 要 ~20ms 服务端 CPU
   *    （JSON 解析×2 + 序列化×2 + 写库），而单线程节点每秒只能处理 ~32 次 ——
   *    请求越大，"一个 IP 打满全站"越容易。线上真实对局 state 只有 20–30KB，
   *    历史最大值 108KB（3228 次投放），320KB 还有 3 倍余量。
   */
  maxStateBytes: 320 * 1024,
  /** 同时存在的对局行数上限，超了删最旧的 */
  maxLiveRows: 3000,
  /** 被新对局替代的行只为给玩家一句像样的提示，2 小时足够 */
  abandonedTtlMs: 2 * 3600 * 1000,
};

/**
 * 日志闸门。
 *
 * ⚠️ 每个被标记/被拒的 checkpoint 都会写一行 journald。正常流量下这没问题，
 *    但如果有人用脚本刷 checkpoint（限流允许 20 次/秒），日志会跟着洪水式增长，
 *    把 journald 和磁盘一起拖下水。
 *
 * 策略：每局**第一次**一定记（排查时最关键的就是第一行），之后走每分钟 60 行的预算；
 * 超预算就静默，并在窗口结束时补一行"压缩了多少条"。
 */
const LOG_GATE = { windowMs: 60_000, max: 60, count: 0, resetAt: 0, suppressed: 0 };
const loggedRuns = new Set();
function shouldLog(runId) {
  const t = Date.now();
  if (t > LOG_GATE.resetAt) {
    if (LOG_GATE.suppressed) console.warn(`[checkpoint] （上一分钟另有 ${LOG_GATE.suppressed} 条日志被压缩）`);
    LOG_GATE.resetAt = t + LOG_GATE.windowMs; LOG_GATE.count = 0; LOG_GATE.suppressed = 0;
  }
  if (runId && !loggedRuns.has(runId)) {
    if (loggedRuns.size < 5000) loggedRuns.add(runId);   // 有界，防止内存涨
    LOG_GATE.count++;
    return true;
  }
  if (LOG_GATE.count >= LOG_GATE.max) { LOG_GATE.suppressed++; return false; }
  LOG_GATE.count++;
  return true;
}

/**
 * 可疑原因的归类与合并。
 *
 * ⚠️ 必须按类别限量。`flags` 列封顶 500 字符，而像「球数守恒 X > Y（投放…、合成…）」
 *    这种带具体数字的条目，一次对局能刷出几十条不同文本（Set 去重对它们无效）。
 *    实测一次注水对局里，球数守恒条目把 500 字符吃满，**后面才追加的
 *    「物理推演不一致」被整条截掉** —— 最关键的原因反而看不到。
 *
 * 策略：同一类别最多留 2 条（第一条 = 什么时候开始不对，最后一条 = 最后有多严重）。
 */
function flagCategory(flag) {
  const cut = flag.search(/[ ：:（(]/);
  return cut === -1 ? flag : flag.slice(0, cut);
}
function mergeFlags(existing, incoming) {
  const kept = [];                       // [{ category, flag }]，保持首次出现的顺序
  const count = new Map();               // 类别 → 已收条数
  const lastIndex = new Map();           // 类别 → 该类别最后一条在 kept 里的下标
  for (const flag of [...existing, ...incoming]) {
    const category = flagCategory(flag);
    const seen = count.get(category) ?? 0;
    if (seen < 2) { kept.push({ category, flag }); lastIndex.set(category, kept.length - 1); }
    else kept[lastIndex.get(category)].flag = flag;    // 已经两条：用最新这条覆盖最后一条
    count.set(category, seen + 1);
  }
  return kept.map(entry => entry.flag).join(' | ').slice(0, 500);
}

/**
 * 「规避物理推演」判据。
 *
 * 2026-10-19 红队实测的绕过（已上线成功，4597 分挂到经典第 12）：
 *   增量校验只在 `|Δelapsed| ≤ 3000ms` 的窗口上推演，而 `cadenceFlag` 用的是
 *   `revision` —— `/api/run/resume` 每次也 +1。于是 60 次真正的 checkpoint 之间
 *   插 259 次 resume：节奏算出来 22.2 次/分（阈值 20）过关，但每个 checkpoint 的
 *   真实间隔是 9000ms → 窗口全部超限 → `sim_checks` 恒为 0 → 物理推演永远不会触发。
 *
 * 所以不能再靠计数器判断"存得勤不勤"，要看**窗口形状**：
 *   真客户端 `saveProgress` 由 2 秒定时器驱动（web/src/main.ts），窗口天然 ≤2 秒；
 *   切后台是暂停（elapsed 冻结），模态框期间既不存档也不推进 ——
 *   也就是说真人的宽窗口只会来自网络失败，比例接近 0。
 *
 * 判据：
 *   · `wide / writes ≥ 50%`（且至少 8 次存档）→ 直接判定在躲
 *   · 或者：写窗口覆盖的时长里，真实存档速率 < 20 次/分（用 `write_from` 计时基，
 *     不用总 elapsed —— 这样对"部署前就在跑的老对局"也不会误伤）
 */
const DODGE_RULE = {
  minWrites: 8,           // 少于 8 次存档不下结论
  wideRatio: 0.5,         // 宽窗口占一半以上
  minSpanMs: 120000,      // 速率判据至少要覆盖 2 分钟，否则样本太短
  minPerMinute: 20,       // 真人实测 31–126 次/分
};

function dodgeFlag({ writes, wide, spanMs }) {
  if (!(writes >= DODGE_RULE.minWrites)) return '';
  if (wide * 2 >= writes) {
    return `疑似规避物理推演：${writes} 次存档里有 ${wide} 次间隔超过 3 秒`
      + `（真客户端每 2 秒存档一次，宽窗口只会来自网络失败）`;
  }
  if (spanMs >= DODGE_RULE.minSpanMs) {
    const perMinute = (writes * 60000) / spanMs;
    if (perMinute < DODGE_RULE.minPerMinute) {
      return `存档间隔过长：${(spanMs / 60000).toFixed(1)} 分钟里只存了 ${writes} 次`
        + `（${perMinute.toFixed(1)} 次/分，真人实测 31–126；用真实存档次数算，不含 resume）`;
    }
  }
  return '';
}

/** Protocol 1 supports old tabs; protocol 2 saves bounded local physics without per-drop round trips. */
export function createRunSessions(db, Game, now = Date.now, overrides = {}) {
  const { maxStateBytes, maxLiveRows, abandonedTtlMs } = { ...LIMITS, ...overrides };
  const simRule = { ...SIM_RULE, ...(overrides.sim ?? {}) };
  db.exec(`CREATE TABLE IF NOT EXISTS live_game (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, mode TEXT NOT NULL,
    resume_key TEXT NOT NULL, lease TEXT NOT NULL, revision INTEGER NOT NULL,
    state TEXT NOT NULL, active INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    carry REAL NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0,
    start_id TEXT NOT NULL, claim_id TEXT, last_id TEXT, last_hash TEXT, result TEXT, flags TEXT,
    UNIQUE(client_id, start_id)
  ); CREATE INDEX IF NOT EXISTS idx_live_client ON live_game(client_id, abandoned);
  CREATE INDEX IF NOT EXISTS idx_live_updated ON live_game(updated_at);`);
  // ⚠️ 迁移必须幂等**且**能容忍多进程竞态：cluster 起 4 个 worker 会同时跑这段，
  //    第二个 worker 的 ALTER 会抛 `duplicate column name`，直接崩一个 worker。
  //    所以统一走这个 helper：先查列存不存在，再 try/catch 忽略重复列错误。
  const ensureColumn = (name, ddl, after) => {
    if (db.prepare('PRAGMA table_info(live_game)').all().some(c => c.name === name)) return;
    try { db.exec(ddl); if (after) db.exec(after); }
    catch (error) { if (!/duplicate column/i.test(String(error?.message ?? error))) throw error; }
  };
  ensureColumn('protocol', 'ALTER TABLE live_game ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1');
  ensureColumn('flags', 'ALTER TABLE live_game ADD COLUMN flags TEXT');
  ensureColumn('started_at', 'ALTER TABLE live_game ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0',
    "UPDATE live_game SET started_at=updated_at-CAST(json_extract(state,'$.elapsed') AS INTEGER)");
  // 增量校验（物理推演）的计分板：已校验窗口数 / 累计符号偏差（单位：合成次数）
  ensureColumn('sim_checks', 'ALTER TABLE live_game ADD COLUMN sim_checks INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sim_bias', 'ALTER TABLE live_game ADD COLUMN sim_bias REAL NOT NULL DEFAULT 0');
  ensureColumn('sim_at', 'ALTER TABLE live_game ADD COLUMN sim_at INTEGER NOT NULL DEFAULT 0');
  // 「规避物理推演」用的三个计数：真实存档次数 / 其中宽窗口(>3 秒)次数 / 计时基（第一次存档时的 elapsed）
  ensureColumn('state_writes', 'ALTER TABLE live_game ADD COLUMN state_writes INTEGER NOT NULL DEFAULT 0');
  ensureColumn('wide_writes', 'ALTER TABLE live_game ADD COLUMN wide_writes INTEGER NOT NULL DEFAULT 0');
  ensureColumn('write_from', 'ALTER TABLE live_game ADD COLUMN write_from REAL NOT NULL DEFAULT 0');
  // 物理推演的账：尝试过多少次 / 其中因投放冷却冲突失败多少次
  ensureColumn('sim_attempts', 'ALTER TABLE live_game ADD COLUMN sim_attempts INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sim_cooldown', 'ALTER TABLE live_game ADD COLUMN sim_cooldown INTEGER NOT NULL DEFAULT 0');
  // 压线计时：服务端**自己**看到"没球压过死亡线"的最后时刻（见 validate.js 的 LINE_RULE）
  ensureColumn('line_clear_at', 'ALTER TABLE live_game ADD COLUMN line_clear_at REAL NOT NULL DEFAULT 0');
  // 观察期指标：终局时"服务端观测到的压线持续时长"。先只记录，等真人数据再定阈值。
  ensureColumn('line_hold_ms', 'ALTER TABLE live_game ADD COLUMN line_hold_ms REAL NOT NULL DEFAULT 0');
  const byId = db.prepare('SELECT * FROM live_game WHERE id = ?');
  const update = db.prepare(`UPDATE live_game SET state=?, active=?, updated_at=?, carry=?, revision=?, lease=?, claim_id=?, last_id=?, last_hash=?, flags=?, sim_checks=?, sim_bias=?, sim_at=?, state_writes=?, wide_writes=?, write_from=?, sim_attempts=?, sim_cooldown=?, line_clear_at=?, line_hold_ms=? WHERE id=? AND revision=?`);
  const reply = row => {
    const state = JSON.parse(row.state);
    if (row.protocol === 1) state.randomState = 0;
    return { id: row.id, key: row.resume_key, lease: row.lease, revision: row.revision, protocol: row.protocol, active: !!row.active, state };
  };
  function authenticate(clientId, id, key) {
    const row = typeof id === 'string' ? byId.get(id) : null;
    if (!row || row.client_id !== clientId || !same(row.resume_key, key)) throw new SessionError('找不到这局进度，请确认使用原来的浏览器', 403);
    if (now() - row.updated_at > 14 * 86400000) throw new SessionError('这局进度已超过 14 天未使用，请重新开局');
    if (row.abandoned) throw new SessionError('这局已被新对局替代，不能恢复已放弃的进度');
    return row;
  }
  function writer(clientId, input) {
    const row = authenticate(clientId, input.id, input.key);
    if (!same(row.lease, input.lease)) throw new SessionError('这局已在其他页面恢复，请回到最新页面');
    return row;
  }
  function advance(row) {
    const game = Game.restore(JSON.parse(row.state));
    const elapsed = row.active ? Math.max(0, now() - row.updated_at) + row.carry : 0;
    // After 10 seconds without input bodies are settled or overflow has already ended the run.
    // This cap bounds CPU on abandoned tabs without resetting any grace timer.
    const steps = Math.min(600, Math.floor(elapsed / STEP));
    for (let i = 0; i < steps && game.status === 'playing'; i++) game.update(STEP);
    row.carry = elapsed < 10000 ? elapsed - steps * STEP : 0;
    return game;
  }
  function saveState(row, state, active) {
    const previous = row.revision; row.revision++;
    row.state = JSON.stringify(state); row.active = active && state.status === 'playing' ? 1 : 0;
    if (row.state.length > maxStateBytes) throw new SessionError('进度数据过大', 413);
    row.updated_at = now();
    const changed = update.run(row.state, row.active, row.updated_at, row.carry, row.revision, row.lease, row.claim_id,
      row.last_id, row.last_hash, row.flags || null,
      row.sim_checks ?? 0, row.sim_bias ?? 0, row.sim_at ?? 0,
      row.state_writes ?? 0, row.wide_writes ?? 0, row.write_from ?? 0,
      row.sim_attempts ?? 0, row.sim_cooldown ?? 0, row.line_clear_at ?? 0, row.line_hold_ms ?? 0,
      row.id, previous);
    if (changed.changes !== 1) throw new SessionError('存档版本已更新，请重新恢复');
    return reply(row);
  }
  function save(row, game, active) {
    const state = game.snapshot(); game.destroy(); return saveState(row, state, active);
  }
  // 软校验失败不拒绝、只累积可疑原因；硬校验失败才 400。原因必须写日志 ——
  // 上次"无尽模式循环合成后永久 400"就是被这里一句固定文案吞掉，排查花了几小时。
  function checked(row, state) {
    let result, prevState;
    try { prevState = JSON.parse(row.state); result = validateCheckpoint(state, prevState, now() - row.started_at); }
    catch (error) {
      if (shouldLog(row.id)) console.warn(`[checkpoint] rejected run=${row.id} ${row.mode} rev=${row.revision} elapsed=${state?.elapsed} :: ${error.message}`);
      throw new SessionError('进度数据无效或发生倒退', 400);
    }
    // 存档节奏：真假客户端在"每分钟被接受多少次存档"上差一个数量级（见 validate.js 的 CADENCE_RULE）。
    // ⚠️ 只在**终局**判，2026-10-23 误标 #554（五条悟，classic 4169）换来的：
    //    那条标记来自开局 36 秒的窗口（7 次存档 = 11.1 次/分，当时他正停在开局发现动画里），
    //    而他整局的真实速率是 **35.9 次/分**（完全正常）。累积判定会把一次瞬时低谷永久钉死 ——
    //    这已经是"拿中途瞬时状态判终局性质"的第三次教训（前两次：台账、球阵悬空）。
    //    用 state_writes（真实存档次数）而不是 revision（resume 也会 +1）。
    if (result.state.status === 'over') {
      const cadence = cadenceFlag(row.state_writes ?? row.revision, result.state.elapsed);
      if (cadence) result.flags.push(cadence);
    }
    // 规避物理推演：数真实存档次数、宽窗口占比、以及真实存档速率（见 DODGE_RULE）。
    // 计数每次存档都要累加，但**判定只在终局** —— 和存档节奏同一个道理：
    // 宽窗口占比、真实存档速率都是"整局平均"性质的量，中途判会被早年的一次瞬时低谷钉死。
    {
      const deltaMs = result.state.elapsed - prevState.elapsed;
      row.state_writes = (row.state_writes ?? 0) + 1;
      if (deltaMs > simRule.maxWindowMs) row.wide_writes = (row.wide_writes ?? 0) + 1;
      if (!row.write_from) row.write_from = prevState.elapsed || 0.0001;
      if (result.state.status === 'over') {
        const spanMs = result.state.elapsed - (row.write_from ?? 0);
        const dodge = dodgeFlag({ writes: row.state_writes, wide: row.wide_writes ?? 0, spanMs });
        if (dodge) result.flags.push(dodge);
      }
    }
    // 压线计时：治"改高死亡线"（见 validate.js 的 LINE_RULE）。
    // 服务端自己按 540 算有没有球压线，记下最后一次"没压线"的时刻。
    //
    // ⚠️ 观察期：现在只**记录** `line_hold_ms`（终局时这个时刻已经过去了多久），不判。
    //    原因：服务端只能在存档时刻观测，两次压线之间若有个很短的"清空"而恰好没有存档
    //    落在里面，line_clear_at 就不会刷新 —— 这种漏采样累积上界我没有真人数据。
    //    已测到的真人数据只有客户端自己报的压线时长（424 个终局状态全部 2000ms、最多 2500ms）。
    //    攒够一批 line_hold_ms 再定阈值。
    {
      const blocked = overLineBlocked(result.state);
      if (!blocked) {
        row.line_clear_at = result.state.elapsed;
      } else if (result.state.status === 'over' && (row.line_clear_at ?? 0) > 0) {
        const heldMs = result.state.elapsed - row.line_clear_at;
        row.line_hold_ms = heldMs;
        if (heldMs > LINE_RULE.maxBlockedMs) {
          result.flags.push(`压线后迟迟不结束：球压过死亡线又继续玩了 ${(heldMs / 1000).toFixed(1)} 秒`
            + `（真人实测只有 ${LINE_RULE.graceMs / 1000}–2.5 秒；把死亡线改高就会这样）`);
        }
      }
    }
    // 增量校验（抽样）：服务端自己推演这个窗口，和客户端报的结果比。
    try {
      const checks = row.sim_checks ?? 0;
      // ⚠️ 前 minChecks 次**无条件**校验，不能只靠 12% 抽样。
      //    否则"短对局 + 贴着节奏下限存档"的伪造者永远攒不够样本：
      //    登顶 5786 分至少 483 次投放 ≈ 193 秒，为躲存档节奏规则又要 ≥64 次存档，
      //    64 × 0.12 ≈ 7.7 次 —— 而 4σ 判据需要 20 次才有统计意义。
      //    预热把"N ≥ 20"从"碰运气"变成"任何对局必然满足"，代价约 0.4 秒 CPU/局。
      const warmup = checks < simRule.minChecks;
      if (checks < simRule.maxChecks
        && result.state.elapsed - prevState.elapsed <= simRule.maxWindowMs
        && now() - (row.sim_at ?? 0) >= simRule.minIntervalMs
        && (warmup || Math.random() < simRule.sample)) {
        const verdict = replayWindow(prevState, result.state, simRule, Game);
        row.sim_at = now();
        if (verdict && (verdict.bias !== undefined)) {
          row.sim_attempts = (row.sim_attempts ?? 0) + 1;
          row.sim_checks = checks + 1;
          row.sim_bias = (row.sim_bias ?? 0) + verdict.bias;
          // 一旦累计偏差越界就当场记 flag —— 别等到提交才生成，
          // 否则"这个人打到一半就已经不对劲"这件事在后台看不出来。
          const reason = simBiasFlag(row.sim_checks, row.sim_bias);
          if (reason) result.flags.push(reason);
        } else if (verdict) {
          // 试过但推演不了。只有"几乎全部窗口都因冷却冲突被跳过"才报账，
          // 因为这个比例真人也会有：顶着 400ms 冷却连点的真人实测 17/26 = 65% 冲突
          // （客户端的投放时刻正好压在边界上，服务端按固定步长重放会差半个步长）。
          // 取 0.8 意味着"只剩零星窗口能推演"，那时物理推演本身也抓不到东西了。
          if (verdict.skip !== 'window') row.sim_attempts = (row.sim_attempts ?? 0) + 1;
          if (verdict.skip === 'cooldown') row.sim_cooldown = (row.sim_cooldown ?? 0) + 1;
          const attempts = row.sim_attempts ?? 0, cooldown = row.sim_cooldown ?? 0;
          // ⚠️ "被系统性跳过"是**整局**性质（冷却冲突占比），所以在终局才判 ——
          //    和存档节奏、规避推演同一条原则：累积比值一旦中途判，早年一次连点就能钉死整局。
          if (attempts >= simRule.minCooldownAttempts && cooldown / attempts >= simRule.cooldownRatio
            && result.state.status === 'over') {
            result.flags.push(`物理推演被系统性跳过：${attempts} 个可推演窗口里有 ${cooldown} 个因投放冷却冲突无法推演`
              + `（${Math.round(cooldown / attempts * 100)}%，真人连点也只有 65%）`);
          }
        }
      }
    } catch { /* 增量校验失败绝不影响正常存档 */ }
    if (result.flags.length) {
      row.flags = mergeFlags(row.flags ? row.flags.split(' | ') : [], result.flags);
      if (shouldLog(row.id)) console.warn(`[checkpoint] flagged run=${row.id} ${row.mode} score=${state.score} elapsed=${state.elapsed} :: ${result.flags.join(' | ')}`);
    }
    return result.state;
  }
  return {
    start(clientId, mode, startId, protocol = 1, easterEggs = false) {
      requestId(startId);
      if (!['classic', 'endless'].includes(mode)) throw new SessionError('模式无效', 400);
      if (![1, 2].includes(protocol)) throw new SessionError('对局版本无效', 400);
      const existing = db.prepare('SELECT * FROM live_game WHERE client_id=? AND start_id=?').get(clientId, startId);
      if (existing) { authenticate(clientId, existing.id, existing.resume_key); return reply(existing); }
      const game = new Game(mode, {}, randomBytes(4).readUInt32LE(), protocol === 2 && easterEggs); game.start();
      const row = { id: randomUUID(), client_id: clientId, mode, resume_key: token(), lease: token(), state: JSON.stringify(game.snapshot()), updated_at: now(), start_id: startId };
      game.destroy();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE live_game SET abandoned=1, active=0 WHERE client_id=? AND result IS NULL').run(clientId);
        db.prepare('INSERT INTO live_game(id,client_id,mode,resume_key,lease,revision,state,active,updated_at,start_id,protocol,started_at) VALUES (?,?,?,?,?,0,?,1,?,?,?,?)')
          .run(row.id, clientId, mode, row.resume_key, row.lease, row.state, row.updated_at, startId, protocol, row.updated_at);
        db.prepare('DELETE FROM live_game WHERE updated_at < ?').run(now() - 14 * 86400000);
        // 磁盘防线：被替代的行只留 2 小时；总量超过上限就删最旧的。
        db.prepare('DELETE FROM live_game WHERE abandoned = 1 AND updated_at < ?').run(now() - abandonedTtlMs);
        db.prepare(`DELETE FROM live_game WHERE id IN (
          SELECT id FROM live_game ORDER BY updated_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM live_game) - ?))`).run(maxLiveRows);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return reply(byId.get(row.id));
    },
    resume(clientId, id, key, claimId, local = {}) {
      requestId(claimId); const row = authenticate(clientId, id, key);
      if (JSON.parse(row.state).easterEggs && local.easterEggs !== 1) throw new SessionError('这局含有新版彩蛋，请刷新页面后恢复');
      if (row.claim_id === claimId) return reply(row);
      if (row.protocol === 2 && local.protocol !== 2) throw new SessionError('请刷新页面后恢复');
      if (local.protocol === 2) {
        let state;
        if (row.protocol === 1) {
          const game = advance(row); state = game.snapshot(); game.destroy();
        } else {
          state = JSON.parse(row.state);
          if (!row.result && same(row.lease, local.lease) && local.state) {
            try { state = checked(row, local.state); } catch { /* Corrupt or old local cache cannot replace a newer server copy. */ }
          }
        }
        // Opt-in is a resume boundary: keep already generated held/next balls unchanged.
        if (local.easterEggs === 1 && state.mode === 'endless' && state.status !== 'over') state.easterEggs = true;
        row.protocol = 2; db.prepare('UPDATE live_game SET protocol=2 WHERE id=?').run(row.id);
        row.lease = token(); row.claim_id = claimId; row.last_id = row.last_hash = null; row.carry = 0;
        return saveState(row, state, false);
      }
      const game = advance(row);
      row.lease = token(); row.claim_id = claimId; row.last_id = row.last_hash = null;
      return save(row, game, false);
    },
    sync(clientId, input) {
      requestId(input.requestId);
      const row = writer(clientId, input);
      if (row.protocol !== 1) throw new SessionError('请刷新页面后继续');
      const { action, active } = input;
      if (!action || !['none', 'drop', 'secret'].includes(action.kind) || typeof active !== 'boolean') throw new SessionError('操作无效', 400);
      if (action.kind !== 'none' && (!Number.isFinite(action.x) || action.x < 0 || action.x > 1080
        || (action.kind === 'secret' && (!Number.isFinite(action.y) || action.y < 0 || action.y > 1940)))) throw new SessionError('落点无效', 400);
      const hash = contentHash({ action, active });
      if (row.last_id === input.requestId) {
        if (row.last_hash !== hash) throw new SessionError('不能用同一操作编号替换落点');
        return reply(row);
      }
      if (row.revision !== input.revision) throw new SessionError('存档版本已更新，不能使用旧进度');
      if (row.result || JSON.parse(row.state).status === 'over') throw new SessionError('这局已经结束');
      if (action.kind !== 'none' && !row.active) throw new SessionError('请先继续游戏');
      const game = advance(row);
      if (game.status === 'playing') {
        if (action.kind === 'drop') { game.setAimX(action.x); game.drop(); }
        if (action.kind === 'secret') game.useSecret(action.x, action.y);
      }
      row.last_id = input.requestId; row.last_hash = hash;
      return save(row, game, active);
    },
    checkpoint(clientId, input) {
      requestId(input.requestId); const row = writer(clientId, input);
      if (row.protocol !== 2 || typeof input.active !== 'boolean') throw new SessionError('存档版本无效', 400);
      const hash = contentHash({ state: input.state, active: input.active });
      if (row.last_id === input.requestId) {
        if (row.last_hash !== hash) throw new SessionError('不能替换已保存的操作');
        return reply(row);
      }
      if (row.revision !== input.revision) throw new SessionError('存档版本已更新，不能使用旧进度');
      if (row.result) throw new SessionError('这局已经结束');
      const state = checked(row, input.state);
      row.last_id = input.requestId; row.last_hash = hash;
      return saveState(row, state, input.active);
    },
    finish(clientId, input, commit) {
      const row = writer(clientId, input);
      if (row.result) return JSON.parse(row.result);
      if (row.revision !== input.revision) throw new SessionError('存档版本已更新');
      const state = JSON.parse(row.state);
      if (state.status !== 'over') throw new SessionError('对局尚未结束');
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = commit({ mode: state.mode, score: state.score, maxLevel: state.maxLevelReached,
          merges: state.merges, loopCount: state.loopCount, durationMs: Math.round(state.elapsed), trace: state.trace,
          flags: row.flags || null, simChecks: row.sim_checks ?? 0, simBias: row.sim_bias ?? 0 });
        db.prepare('UPDATE live_game SET result=?, active=0 WHERE id=?').run(JSON.stringify(result), row.id);
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
