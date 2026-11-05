/**
 * 防作弊校验 + 昵称校验。
 *
 * ⚠️ 这里的常量必须和 web/src/config.ts、web/src/nick.ts 保持一致。
 *    改规则时两边一起改（就这几个数，别搞共享包了，不值当）。
 *
 * 思路：前端的一切都能被改，所以不信任"分数"，只信任"操作序列"，然后
 * 在服务端算一个**理论上界**。不跑物理（太贵），纯组合数学，微秒级。
 */

export const MAX_LEVEL = 11;
export const SPAWN_TUTORIAL = [1, 1, 2, 2, 3];
export const SPAWN_POOL = [1, 2, 3, 4, 5];
// Keep reserved identities in sync with web/src/easter-eggs.ts. Eggs have no merge units.
export const isEasterEggLevel = (level) => level === -1 || level === -2;
export const RESONANCE_SCORE = 100;   // 经典模式：一对完全体共鸣
export const RECYCLE_BASE = 500;      // 无尽模式：第 k 次循环得 500k

/**
 * 球的直径表 + 容器关键高度。⚠️ 必须和 web/src/config.ts 的 LEVELS / CONTAINER 一致。
 *
 * 只有一处用到：判断「这一局是不是真的因为堆过线而结束」。
 * 真实对局**必然**至少有一颗球压在 `deathLineY` 之上（`checkOverflow` 是唯一的终局入口，
 * 而它要求有一颗成熟球顶越过死亡线并持续 deathGraceMs）。我用 10 局真实对局验证过，
 * 终局时压线球有 2–5 颗。
 */
export const BALL_DIAMETERS = [90, 106, 125, 147, 173, 204, 240, 283, 333, 392, 461];
/** 彩蛋球（-1/-2）渲染成 Lv5 大小，见 server/sim/easter-eggs.js 的 ballDiameter */
export const EGG_DIAMETER = BALL_DIAMETERS[4];
export const DEATH_LINE_Y = 540;
/** 容器地面 y（web/src/config.ts 的 CONTAINER.floor）*/
export const FLOOR_Y = 1940;
/** 容器左右内壁 x（web/src/config.ts 的 CONTAINER.left / right）*/
export const CONTAINER_LEFT = 62;
export const CONTAINER_RIGHT = 1063;

/**
 * 球必须在容器里。
 *
 * 2026-10-20 提出的攻击：**把落球区改宽**（改 `CONTAINER.left/right`）。
 * 服务端原来对球坐标只查 `finite(x, -100000, 100000)` —— 球跑到 x=1500 也照样收，
 * 于是球堆可以铺到墙外、有效容量变大、活得更久。
 *
 * 标定（生产库 616 个有球的状态）：球心越出左右墙的**一例都没有**，
 * 球只有贴着墙时球心才到 62 / 1063；真实最低球球心 1895、加半径正好贴地（1940）。
 * 所以容差只给 10px：真人上限 + 10px，不给"改宽一点点"留空间。
 */
export const CONTAINER_RULE = { slackPx: 10 };

/**
 * 压线计时：服务端自己判断"有没有成熟的球压过死亡线"，并记下最后一次没压线的时刻。
 *
 * 这条是治**"改高死亡线 / 加高可玩区"**的 —— 那是目前唯一能稳定获益又完全隐形的篡改：
 *   · 物理推演完全一致（球怎么动跟死亡线无关）
 *   · 终局见证照样通过（球顶在 y=300，比 540 高，`300 < 580` ✓）
 *   · 守恒/台账/落点全都不受影响
 *
 * 思路（2026-10-20 用户提的）：服务端**自己知道**死亡线在哪，那就自己记时间。
 * 真客户端 `checkOverflow()` 的规则是：任意球顶 < 540，且该球出生超过 spawnGraceMs(800)，
 * 持续 deathGraceMs(2000) 才判负。所以真人一局结束时，"球压线"这件事最多只持续
 * 2000ms + 一个存档间隔（客户端每次投放都存档，间隔 0.4–2 秒）≈ 最多 6 秒。
 * 而把线改到 400 的客户端，会在球压在 400–540 之间**继续玩几十秒到几分钟**才结束 ——
 * 这段时间服务端看得一清二楚。取 20 秒：真人留 3 倍以上余量。
 */
export const LINE_RULE = {
  deathLineY: 540,        // 与 web/src/config.ts 的 CONTAINER.deathLineY 一致
  graceMs: 2000,          // deathGraceMs
  spawnGraceMs: 800,      // spawnGraceMs：刚投下来的球不算压线
  /**
   * 终局时"服务端自己看到球压线"的持续时长上限。
   *
   * 真人数据（生产库 424 个终局状态，客户端自报的压线时长 `elapsed − overLineSince`）：
   *   414 个正好 **2000ms**（= deathGraceMs），10 个 2500ms，**最大 2500ms**
   *   —— 一个例外都没有，因为客户端规则就是"压线连续 2 秒必死"。
   *
   * 服务端观测的账面开销：它只能在存档时刻观测，最后一次"看到没压线"可能比真正开始压线
   * 早一个存档间隔（真人存档间隔 0.4–2 秒），所以诚实的观测值 ≤ 2000 + 2000 ≈ 4000ms。
   *
   * 取 **10 秒**：对实测最大值 4 倍、对账面诚实上限 2.5 倍。
   * 而把死亡线从 540 改到 400 的客户端，会在球压 400–540 之间多玩几十秒到几分钟 —— 会被抓住。
   */
  maxBlockedMs: 10000,    // 站长定的：实测真人 2.5 秒（客户端自报）/ 5.5 秒（服务端观测，存档稀疏的玩家）
};
/** 「压过死亡线」判定留的容差：万一哪天两边半径表漂了，不该因此把真人判成可疑 */
export const DEATH_LINE_SLACK = 40;
export const ballDiameter = level => (isEasterEggLevel(level) ? EGG_DIAMETER : BALL_DIAMETERS[level - 1]);

/**
 * 一次秘技最多能删掉多少单位。
 *
 * ⚠️ 这个数是**实测**出来的。做法：拿线上 424 个真实棋盘状态，按游戏真实规则
 *    （清除半径 180 + 球半径，见 SECRET_RULES.radius）穷举所有点击位置（每 25px 一格），
 *    统计每个位置能清掉多少单位，取全局最大值：
 *
 *      中位 1218 · p90 2148 · p99 3085 · **max 3333**（一个 3859 单位的满盘里删掉 86%）
 *      前五名的四个真高手（玩家1/j玩家E/玩家B/玩家2）都在 3081–3136
 *
 * 取值 3200 —— 这是一个**刻意的取舍**，理由和代价都要记住：
 *
 *   · 好处：它是一道闸门。真有人能一次删掉超过 3200 单位，就说明要么他改了客户端
 *     （把球半径/清除半径改大），要么构造了不可能的棋盘 —— 这两种都值得复核。
 *     线上 344 局里它一次都没触发过（0 条），所以现在它不产生任何误伤。
 *   · 代价：实测最大值 3333 > 3200，也就是说**如果**某位真玩家把棋盘堆得比历史上任何
 *     一局都满、然后再开秘技，就会被标记。命中的是**软标记**（只进复核队列、不进榜，
 *     不会丢局、`clear-flag` 可放行），不是硬拒绝。
 *
 * 曾经改成 4200 又改回来了：4200 零误伤，但等于把这道闸门拆了。
 * 既然它至今零触发，留着更划算 —— 零误伤 + 零收益，不如零误伤以外还有一道闸。
 */
export const MAX_CLEARED_UNITS_PER_SECRET = 3200;

/**
 * 「每次投放的得分」经验上界。
 *
 * ⚠️ 这条是**软判定**，只用来把可疑对局送进人工复核，绝不拒绝。
 *
 * 线上 219 局真实对局实测：每次投放得分 p50=3.94、p99=5.64、**最大 7.85**。
 * 拿理论上界反解：`score ≤ 1.15×(2.9873×U)`，而小 n 时统计余量 `8σ√(n·var)` 会把
 * U/n 抬到 6 以上，所以理论上限约 20.8。取 12 作为阈值：
 * 比真实最大值高 53%，比伪造攻击（20.8）低 42%。
 *
 * ⚠️ 但别指望它能挡住会调参的攻击者 —— 他只要把上报分数压到 12n 以下就能过。
 *    它挡的是"直接把分数顶到理论上界"这种最省事暴力，而攻击者的成本（墙上时间）
 *    一点都没被它抬高。
 */
export const MAX_SCORE_PER_DROP = 12;

/**
 * 「自动投放」（定时器宏 / 脚本）的识别规则。
 *
 * ⚠️ 这是**软判定**：命中只进人工复核队列，不拒绝、不判死。
 *    理由很简单 —— 判错一个真人，代价是他的成绩消失；判漏一个脚本，代价只是榜单上多一条。
 *
 * ## 判定条件：**只看落点**，节奏不参与判定
 *
 * 落点是必要条件，满足其一即标记：
 *
 *   ① 硬编码清单：落点 ≤maxPositions 种，且（≤4 个固定点，或跨度 ≥gridMinSpan）
 *   ② 窄带：跨度 < narrowSpan
 *
 * ⚠️⚠️ **为什么节奏不能当判据（这一条是踩过坑的）**
 *
 *   最初写成「节奏机械 **AND** 落点机械」，结果漏掉了一整类：
 *   同一个脚本把投放延迟随机化之后（间隔 200–323 个不同值、中位 2.4–3.6 秒），
 *   节奏这一半失效，`And` 直接短路返回 null，落点根本没被检查 ——
 *   于是他用同一张 21 点落点表在榜上挂了 6040 分（无尽第 8）和 3654 分（经典第 20）。
 *
 *   反过来「节奏机械 **AND** 落点机械」还会漏掉另一种：一个会瞄准的 bot 落点铺满时，
 *   节奏再机械也抓不到（这是已知的、接受了的缺口）。
 *
 *   而**落点单独成立**是安全的，因为线上 264 条成绩里落点 ≤30 种的只有同一个人的 5 局，
 *   其余所有真人最少的也有 158 种。真人的手不可能只落在 21 个精确像素上。
 *
 * ## 校准数据（改阈值前必读）
 *
 *   · 真人落点种类数：最少 158 种、p10 158、中位 384
 *   · 已确认的真人「玩家I」：连续 180 颗顶冷却，但落点 158 种 / 跨度 907px → 不标记 ✓
 *   · 已确认的真人「玩家Z」正常局：落点 350–494 种、跨度 941px
 *   · 脚本形态：「玩家Y」16 个点每 63px 一格；「测试账号」21 个点每 47px 一格；
 *     另有一条 1 个点连投 408 次；一条 8 个点严格循环；一条挤在 39px 窄带内
 *
 * 🔴 不要用的指标（都试过，会误杀真人）：
 *   · 单纯的中位间隔阈值 —— 42 局真人的中位间隔就在 400–416ms（顶着冷却连点）
 *   · 相邻间距「规整度」—— 落点一密中位间距就是 1px，把 672 种落点、27 分钟的真人都能算成 90% 规整
 *   · 「高分必须用满棋盘」—— 实测确实成立（1500 分以上 197 局跨度都 ≥907px），
 *     但它只是"定点投放"判据的一个推论，单独用反而更弱，且真人 459px 的反例存在，别加
 */
export const BOT_RULES = {
  minDrops: 60,
  /**
   * 落点判据的最低样本数。
   * 真人开局阶段落点天然很少：生产库实测「已投次数 → 真人最少落点」
   *   60–80 次 → 4 种｜80–120 → 4｜120–200 → 5｜200–300 → 13
   * 所以 300 次以下**不下结论**（早期 trace 的落点密度说明不了任何事）。
   * 同时期的跨度也会很窄（玩家I前 200 次投放跨度只有 30px），所以窄带判据同样受这道门槛约束。
   */
  aimMinDrops: 300,
  /** 300–500 次投放时的落点上限（同长度真人最少 39 种）*/
  maxPositions: 30,
  gridMinSpan: 40,
  narrowSpan: 40,
  containerWidth: 1001,
  /** 节奏维度（判定用）：间隔按 10ms 分桶取众数，占比 ≥ beatShare 且众数 ≥ beatMinMs 即算机械 */
  beatMinMs: 600,
  beatShare: 0.5,
  beatBucketMs: 10,
  /** 以下两个只在描述文案里用，不参与判定 */
  fastGapMs: 700,
  minStreak: 30,
};

/**
 * 落点种类的上限随投放数阶梯上升 —— 真人的落点种类是"随对局长度长出来"的。
 * 生产库实测（完整 trace）：300–500 次真人最少 39 种｜500–1000 最少 74｜1000+ 最少 272。
 * 每一档都取在真人下限之下，所以阶梯只影响脚本：
 *   21 种 @894 次（测试账号）、36 种 @532 次 都会被抓住；
 *   88 种 @727 次（真人）、85 种 @459 次（玩家I）都不会。
 */
function positionCap(drops) {
  if (drops >= 1000) return 100;
  if (drops >= 500) return 45;
  if (drops >= BOT_RULES.aimMinDrops) return BOT_RULES.maxPositions;
  return 0;            // 样本不足，落点维度不判
}

/**
 * 「存档节奏」判据：每分钟被服务端接受了多少次存档。
 *
 * 历史：这条原本很有用——协议 2 下客户端边玩边存，每 0.9–1.7 秒一次（31–126 次/分），
 * 而"整局捏成一个 POST"的伪造者只存 1–5 次（0.1–7.7 次/分）。当时中间是空档。
 *
 * ⚠️ 但这个空档**已经被真人的低值填掉了**（2026-10 实测）：
 *   · #554 五条悟 终局 35.9 次/分（开局进发现动画时短暂掉到 11 次/分）
 *   · #546 玩家S 终局 13.9 次/分（存档被大量跳过）
 *   · #591 玩家C 终局 **5.4 次/分** —— 已经落进伪造区间（0.1–7.7）里
 *   这三个人物理推演、台账、落点全部正常，是网络/设备慢导致的存档稀疏，不是作弊。
 *
 * 所以阈值从 20 降到 **2**：只抓最典型的"离线跑完再批量上报"（实测 0.1–1.7 次/分那批），
 * 不再试图区分 2 次/分以上的一切。剩下的作弊面由物理推演、台账、落点、规避推演兜着 ——
 * 那些判据不依赖存档频率。
 *
 * 仍然只在**终局**判（见 sessions.js）：累积速率中途判会被早年一次低谷钉死。
 * ⚠️ 软判定，只进复核队列。判错一个真人的代价是成绩消失，所以只标记、不拒绝。
 */
export const CADENCE_RULE = { minElapsedMs: 30000, minPerMinute: 2 };

/**
 * 分数随时间的增长曲线。
 *
 * 这是"时间挤压"的最后一块：任何伪造者都必须把分数摊在真实时间里，
 * 因为一次投放要 400ms 冷却、而每次投放最多折 12 分（见 MAX_SCORE_PER_DROP）。
 * 所以真正的问题不是"他能不能编"，而是"他在 T 秒内最多能编多少分"。
 *
 * 标定（生产库 274 局真人，score 与 duration_ms 都是服务端校验过的字段）：
 *   classic  峰值 6.95 分/秒（165 秒那局），中位 1.49，40 分钟以上的长局只有 1.79
 *   endless  峰值 6.87 分/秒，中位 1.57，长局 2.96
 *   包络形状是"速率随对局变长而衰减"，正好可以用 速率 ≤ perSecond + intercept/T 描述。
 *
 * 取 intercept=1200、perSecond=4：
 *   · 274 局真人**全部通过**，最紧的一局（1145 分 / 165 秒）也有 1.62 倍余量
 *   · 193 秒最多报 1972 分；要报 5786 分（当前经典榜首）必须真的打满 19 分钟
 *   · 而 19 分钟的对局在前 1 分钟就攒满 20 次物理校验（见 sessions.js 的预热）
 *
 * 为什么不用固定速率上限：165 秒的真人能打出 6.95 分/秒，长局只有 1.8 分/秒 ——
 * 固定上限要么放过短局伪造，要么误杀高分段真人。
 */
export const SCORE_CURVE = { intercept: 1200, perSecond: 4 };

/** 返回超出曲线多少分（<=0 表示正常） */
export function scoreCurveExcess(score, elapsedMs) {
  if (!Number.isFinite(score) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return score - (SCORE_CURVE.intercept + SCORE_CURVE.perSecond * (elapsedMs / 1000));
}

/** 给人看的理由；正常返回 '' */
export function scoreCurveFlag(score, elapsedMs) {
  const excess = scoreCurveExcess(score, elapsedMs);
  if (excess <= 0) return '';
  const seconds = elapsedMs / 1000;
  return `分数增长过快：${seconds.toFixed(0)} 秒 ${score} 分（${(score / seconds).toFixed(1)} 分/秒，`
    + `真人在这个时长最多 ${((SCORE_CURVE.intercept + SCORE_CURVE.perSecond * seconds) / seconds).toFixed(1)} 分/秒，峰值 6.95）`;
}

/**
 * 球位置连续性：两次存档之间，同一颗球的位移不能超过物理上限。
 *
 * 标定（真实引擎连跑 4 局、每 1 秒取快照，共比对 4582 个「同 id 球对」）：
 *   单球最大速度 26.3 px/step = 1578 px/秒
 *   单球最大位移 1106 px/秒
 * 取 3000 px/秒 + 200px 松量 → 有约 2.7 倍余量。
 *
 * ⚠️ 能抓的和不能抓的，说清楚：
 *   · 能抓：伪造者一次性把球阵"瞬移"成想要的样子（比如把全部单位塞进几颗球摆中间）
 *   · 不能抓：伪造者自己跑一个物理模拟来生成平滑轨迹（那等同于真的在玩）
 *
 * 🔴 试过更狠的版本，被实测否掉了：想用「位移 ≈ 报告速度 × Δt」做一致性检查，
 *    结果真实对局里这个比值范围是 0.00–31.19 —— 速度是瞬时值、位移是整段积分，
 *    中间还有碰撞和合成，两者本来就不该相等。这条别再试。
 */
/**
 * 「台账不变量」：分数不是自由变量，它由 trace 的等级分布 + 终局球阵唯一约束。
 *
 * 逐级球守恒（这是游戏规则本身，不是启发式）：
 *     drops_k + M_{k-1} = 2·M_k + final_k + D_k        （D_k ≥ 0 = 秘技删除的球数）
 * 因为 D_k ≥ 0，所以
 *     M_k ≤ ⌊(drops_k + M_{k-1} − final_k) / 2⌋
 * 从 k=1 往上贪心取等号就得到上界；分数由 M 决定：
 *     合成出等级 n 得 n 分（SCORE.perMerge(n) = n）→ score = Σ (k+1)·M_k
 *     classic：两完全体相撞「共鸣」，MODES.classic.resonanceScore = 100，每对一次
 *     endless：两完全体相撞「回收」变回 Lv1，第 i 次给 500·i（Σ = 250·K(K+1)）
 *
 * 为什么零误伤：
 *   · 没用到秘技 → D_k = 0，M_k 被唯一确定，真人上报值恰好等于台账值
 *   · 用到秘技   → D_k ≥ 0 只会让实际 M 更小，台账仍是上界
 *   · 共鸣/循环的加成按"最多能造出多少个"给足
 *
 * ⚠️ 无尽模式必须**迭代到不动点**：回收会把完全体变回 Lv1 球，那些球还能继续合成。
 *    单遍计算时 k=1 那一步 K 还是 0，会低估上界 → 误杀真实无尽玩家（实测 玩家F 那局有 3 次循环）。
 *    这里从 M≡0 开始单调上升迭代，任何满足方程组的解都被它夹住，所以仍然是上界。
 *
 * 效果（同一局伪造：899 投放 / 3485 单位 / 22 球 / 报 4597 分）：
 *   旧的 units 上界 3.435 × 3485 ≈ 11,970（伪造只用了 38%，拦不住）
 *   台账上界 3,636（直接越界 961 分）
 *
 * ⚠️ 单独用封不死：上界约 4.0 分/投放，多报投放次数就能把上界抬起来。
 *    它必须和"逼出真实物理重放"配合使用。
 */
export function ledgerFlag({ mode, trace, balls, merges, score, loopCount = 0 }) {
  const n = MAX_LEVEL + 1;
  const drops = new Array(n).fill(0);
  for (const e of trace ?? []) if (Number.isInteger(e?.lv) && e.lv >= 1 && e.lv <= MAX_LEVEL) drops[e.lv]++;
  const final = new Array(n).fill(0);
  for (const b of balls ?? []) if (Number.isInteger(b?.level) && b.level >= 1 && b.level <= MAX_LEVEL) final[b.level]++;

  const endless = mode === 'endless';
  const M = new Array(n).fill(0);
  // ⚠️ 无尽模式的循环是**自引用**的：回收把两个完全体变回一个 Lv1 球，那个球又能继续合成、
  //    最终再造出完全体，于是方程组在 k=1 与 k=11 之间成环。
  //    从 M≡0 起手解不出来：第一遍算不出"能回收几次"，整条链系统性少算**一次循环**，
  //    真人分数就会被判越界（实测 #533 玩家S、#474 玩家D 两例，差值恒为 **565 分**
  //    = Σ(k+1) k=1..10 的 65 分 + 500 分循环奖励；merges 差 11 次）。
  //    正确做法：拿客户端上报的 `loopCount` 作为 M[11] 的**起点**再迭代到不动点。
  //    谎报 loopCount 不会让上界虚高到能藏分 —— 单位守恒会先抓住它
  //    （expectedUnits = unitsInTrace − 2047×loopCount，谎报 9 次循环就等于凭空少 18423 单位，
  //      实测 25000 / 20250 那批伪造正是被这条挡下的）。
  if (endless) M[MAX_LEVEL] = Math.max(0, Math.floor(loopCount) || 0);
  for (let iter = 0; iter < 40; iter++) {
    let changed = false;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      // 无尽模式的回收会把 Lv11 变回 Lv1，所以等级 1 的可用量还要加上回收次数
      const avail = drops[k] + M[k - 1] + (endless && k === 1 ? M[MAX_LEVEL] : 0);
      const bound = Math.max(0, Math.floor((avail - final[k]) / 2));
      if (bound > M[k]) { M[k] = bound; changed = true; }
    }
    if (!changed) break;
  }

  // 经典模式两颗 Lv11 相撞只是共鸣，不合成；无尽模式才是合成（回收）
  let maxMerges = 0;
  let maxScore = 0;
  for (let k = 1; k < MAX_LEVEL; k++) { maxMerges += M[k]; maxScore += (k + 1) * M[k]; }
  if (endless) {
    const K = M[MAX_LEVEL];
    maxMerges += K;
    maxScore += (RECYCLE_BASE * K * (K + 1)) / 2;
  } else {
    const top = drops[MAX_LEVEL] + M[MAX_LEVEL - 1];
    const pairs = Math.min((top * (top - 1)) / 2, top * (MAX_TOP_COEXISTING - 1));
    maxScore += RESONANCE_SCORE * pairs;
  }

  const flags = [];
  const tol = LEDGER_RULE.tolerance;
  // 注意：这里**不再**用 M[MAX_LEVEL] 去校验 loopCount —— M 已经被 loopCount 初始化了，
  // 那个比较恒为真。谎报 loopCount 由单位守恒负责抓（见上面的注释）。
  if (Number.isInteger(merges) && merges > Math.floor(maxMerges * tol)) {
    flags.push(`合成 ${merges} 次超过台账上界 ${maxMerges}（由 trace 的等级分布与当前球阵唯一决定）`);
  }
  if (Number.isInteger(score) && score >= LEDGER_RULE.minScore && score > Math.floor(maxScore * tol)) {
    flags.push(`分数 ${score} 超过台账上界 ${maxScore}（由 trace 的等级分布与当前球阵唯一决定）`);
  }
  return flags.join(' | ');
}

/**
 * 单局时长上限。
 *
 * ⚠️ 2026-10-22 事故：`玩家A` 在无尽模式打了 **6 小时**（31898 分），
 *    正好撞上原来的 6 小时硬上限 —— 每次存档都被 400 拒（`时钟: elapsed=21601400`），
 *    客户端永久卡在"存档失败"；而且就算他打完，提交时也会被判「对局时长非法」。
 *    6 小时没有任何依据：真正的防腐约束是"elapsed ≤ 墙上时间 + 1.5 秒"，那一条仍在。
 *    抬到 24 小时，只是把"人类不可能打这么久"这个假设去掉。
 */
export const MAX_RUN_MS = 24 * 3600 * 1000;

/**
 * 台账判据的容差。
 *
 * 本地用真客户端（web/src/game）打了 6 局验证：**分数与合成数都精确等于台账上界**
 * （比值 1.00，一局不差）。所以 1.02 只是给浮点/共鸣边角留的余量 ——
 * 真实对局只会 ≤1.00（秘技删除让实际合成数更少，只会让比值往下走）。
 *
 * `minScore` 是防止极短对局（个位数分数）在取整边角上抖出标记。
 */
export const LEDGER_RULE = { tolerance: 1.02, minScore: 50 };

/**
 * 球阵必须落地（判定见 checkpoint.js）。
 *
 * 标定（生产库 497 个 ≥3 颗球的状态，最低球球心离地面距离）：
 *   p1 = 43px、中位 45px、p99 = 263px；**≥8 颗球时真人最大只有 140px**
 *   （140px 那局是 24 颗球正在下落的过程中被存档）
 *   红队四条"整块球阵凭空上抬"的伪造：1121 / 797 / 733 / 698px
 * 取 400px：真人 2.9 倍余量，伪造全部抓住。
 */
export const GROUND_RULE = { maxGapPx: 400 };

/**
 * 压线判定（服务端复刻客户端的 checkOverflow 条件，见 LINE_RULE）。
 * 返回 true 表示"有成熟的球压过死亡线"。
 */
export function overLineBlocked(state) {
  for (const ball of state.balls ?? []) {
    if (!Number.isFinite(ball?.y) || !Number.isInteger(ball?.level) || ball.level < 1) continue;
    const top = ball.y - ballDiameter(ball.level) / 2;
    if (top < LINE_RULE.deathLineY && (state.now ?? 0) - (ball.bornAt ?? 0) >= LINE_RULE.spawnGraceMs) return true;
  }
  return false;
}

/**
 * 球位移连续性（判定见 checkpoint.js）。
 *
 * ⚠️ `minWindowMs` 不是调参，是正确性门槛：两次存档之间游戏时间几乎没推进时
 *    （页面暂停/刷新/模态框拦住物理），窗口里根本不含运动信息，拿它判"瞬移"
 *    必然误伤。线上 #409 就是被 1ms 窗口判成"球 9 移动 883px"的（开局真实玩家，
 *    落点 481 种、间隔中位 3.15 秒，其它规则一条都没命中）。
 *    真人存档间隔中位数 2–3 秒、最快 0.48 秒，所以 300ms 以下不判。
 */
export const MOTION_RULE = { maxSpeedPxPerSec: 3000, slackPx: 200, minWindowMs: 300 };

/**
 * 终局堆叠自洽：静止时球是**相切**的，所以「相邻球间距 ÷ 半径和」≈ 1。
 *
 * 标定（线上 397 个 ≥6 颗球的状态）：每局最近邻比值的中位数
 *   p1 = 0.986 / 中位 = 0.992 —— 差的那 1% 是 Matter 的 slop。
 *
 * 这条专门用来抓**改球半径**：客户端把直径改小 x 倍，这个比值就会整体落在 x 附近。
 * 改小 10% → 0.89（已经低于阈值 0.90）；改小一半 → 0.5，差得非常远。
 *
 * ⚠️ 只在 `status: 'over'` 时判：对局中球的投影重叠最高能到 93%（新球直接生在球堆里），
 *    那时候不能判。用**中位数**而不是最小值，避开个别刚生成的球。
 */
export const PACKING_RULE = { minBalls: 6, minMedianRatio: 0.9 };

/** 返回可疑原因字符串，或 null（正常 / 时长太短不判） */
export function cadenceFlag(saves, elapsedMs) {
  if (!Number.isFinite(saves) || !Number.isFinite(elapsedMs) || elapsedMs < CADENCE_RULE.minElapsedMs) return null;
  const perMinute = (saves * 60000) / elapsedMs;
  if (!Number.isFinite(perMinute) || perMinute >= CADENCE_RULE.minPerMinute) return null;
  return `存档节奏异常：${saves} 次存档 / ${(elapsedMs / 60000).toFixed(1)} 分钟 = ${perMinute.toFixed(1)} 次/分`
    + `（真人正常是 31–126，但网络差的真人实测低到 5.4；这条只抓 <2 的批量上报）`;
}
/** 落点统计：种类数与跨度（像素） */
export function aimStats(trace) {
  const positions = new Set();
  let min = Infinity, max = -Infinity;
  for (const e of trace) {
    if (!Number.isFinite(e?.x)) return null;
    positions.add(e.x);
    const px = e.x * BOT_RULES.containerWidth;
    if (px < min) min = px;
    if (px > max) max = px;
  }
  return { positions: positions.size, span: max - min };
}

/**
 * 判断一局的操作序列是否像自动投放。
 * 返回 null（正常）或 { kind, positions, span, streak, beat, beatShare }（可疑）。
 * 只读、O(n)、无副作用。
 *
 * ⚠️ 两个维度是 **OR** 关系，不是 AND。
 *    曾经写成 AND（落点机械 且 节奏机械），结果"把投放间隔随机化"的脚本从缝里漏了；
 *    改成 aim-only 之后，反面又漏了"落点随机 + 节拍精确"的脚本 ——
 *    线上审计抓到的 #84（461 次投放里 456 次间隔精确落在 616/617ms、落点却有 277 种、
 *    1677 分挂在榜上）就是这一类。
 *
 *    现在：落点机械 **或** 节拍机械，任一成立就标记。
 *    节拍判据的误伤空间（实测 285 局干净对局）：
 *      · 间隔众数占比（10ms 分桶）：p50 2%、p90 9%、p99 28%，最高的 #84 是 99%
 *      · 所以「占比 ≥50% 且众数 ≥600ms」在真人里**只命中 #84 一局**，与第二名隔 3.5 倍
 *      · 600ms 下限是必须的：线上有十几局真人的中位间隔就在 450–467ms（顶着 400ms 冷却连点），
 *        这一档在时间维度上和脚本无法区分（见 MIN_DROP_GAP_MS 那段注释）
 */
export function detectAutomatedDrops(trace) {
  if (!Array.isArray(trace) || trace.length < BOT_RULES.minDrops) return null;
  const aim = aimStats(trace);
  if (!aim) return null;
  // 落点维度要够长的样本才判（见 BOT_RULES.aimMinDrops / positionCap）
  const cap = positionCap(trace.length);
  const judged = cap > 0;
  const hardcoded = judged && aim.positions <= cap
    && (aim.positions <= 4 || aim.span >= BOT_RULES.gridMinSpan);
  const narrow = judged && aim.span < BOT_RULES.narrowSpan;

  const gaps = [];
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1]?.t, b = trace[i]?.t;
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) gaps.push(b - a);
  }
  let streak = 0, cur = 0;
  for (const g of gaps) { if (g <= BOT_RULES.fastGapMs) { cur++; if (cur > streak) streak = cur; } else cur = 0; }
  // 间隔按 bucket 分桶再取众数：脚本会有 ±1ms 抖动（616/617 混着出现），
  // 精确到毫秒去数会把同一个节拍拆成两半，白给脚本一条活路。
  const counts = new Map();
  for (const g of gaps) counts.set(Math.round(g / BOT_RULES.beatBucketMs), (counts.get(Math.round(g / BOT_RULES.beatBucketMs)) ?? 0) + 1);
  let beatCount = 0, beatBucket = 0;
  for (const [bucket, n] of counts) if (n > beatCount) { beatCount = n; beatBucket = bucket; }
  const beat = beatBucket * BOT_RULES.beatBucketMs;
  const beatShare = beatCount / Math.max(1, gaps.length);
  const metronome = beat >= BOT_RULES.beatMinMs && beatShare >= BOT_RULES.beatShare;

  if (!hardcoded && !narrow && !metronome) return null;
  return {
    kind: narrow ? 'narrow' : hardcoded ? 'fixed-aim' : 'metronome',
    positions: aim.positions, span: aim.span, cap,
    streak, beat, beatShare,
  };
}

/** 给日志和复核队列用的一句话说明 */
export function describeAutomatedDrops(hit) {
  const aim = hit.kind === 'metronome'
    ? `落点随机（${hit.positions} 种、跨度 ${Math.round(hit.span)}px）但投放间隔固定在 ${hit.beat}ms`
      + `（占 ${Math.round(hit.beatShare * 100)}%，真人实测最多 28%）`
    : hit.kind === 'narrow'
      ? `落点挤在 ${Math.round(hit.span)}px 的窄带内（真人 300 次投放后最少 80px）`
      : `落点只有 ${hit.positions} 个固定位置、跨度 ${Math.round(hit.span)}px（同长度上限 ${hit.cap}，真人实测最少 39–272 种）`;
  if (hit.kind === 'metronome') return `疑似自动投放：${aim}`;
  const rhythm = hit.streak >= BOT_RULES.minStreak
    ? `，且连续 ${hit.streak} 颗投放间隔都 ≤${BOT_RULES.fastGapMs}ms`
    : hit.beat >= BOT_RULES.beatMinMs && hit.beatShare >= BOT_RULES.beatShare
      ? `，且投放间隔固定在 ${hit.beat}ms（占 ${Math.round(hit.beatShare * 100)}%）`
      : '，投放间隔被随机化过';
  return `疑似自动投放：${aim}${rhythm}`;
}


/**
 * 两次投放的最小间隔。
 *
 * ⚠️⚠️ 这个值必须**小于**前端的投放冷却（web/src/config.ts 的 DROP.cooldownMs = 400），
 *      否则按游戏允许的最快速度连点的玩家会被判成作弊。
 *
 *      这里踩过一次真实事故：原本写 450 > 400，手速党打出的每一局都被拦，
 *      而玩家看到的现象只是「我玩了但榜上没我」。
 *
 *      现在取 390：仍然守"服务端阈值 < 前端冷却"这条不变式（留 10ms 给取整），
 *      但同时把 350–390 这一段堵上 —— 那一档是**前端 UI 根本不允许**的投放速度，
 *      只有自己写脚本的人能达到。线上 217 局真实对局的实测最短间隔：
 *      min = 400ms，p1 = 400ms，一局都没有低于 400，所以 390 不会误伤任何人。
 *
 *      ⚠️ 但别把这条当测谎仪：线上有 42 局真人的**中位间隔**就在 400–416ms
 *      （顶着冷却连点），跟"恰好每 400ms 一次的脚本"在时间维度上无法区分。
 *      阈值再往上调（500ms 会误杀 20 局，600ms 会误杀 37 局）必然会打死真人。
 *      这条规则只能挡住"比前端冷却还快"的粗暴造假。
 */
const MIN_DROP_INTERVAL_MS = 390;
/** 末尾几颗的宽限，吸收取整误差 */
const DROP_COUNT_GRACE = 5;

/** 导出给自检脚本用，避免测试里硬编码一份、日后和实现漂移 */
export { MIN_DROP_INTERVAL_MS, DROP_COUNT_GRACE };
/** 上界再乘一个容忍系数，宁可放过不可错杀 */
const TOLERANCE = 1.15;

/** 等级 n 的球 = 2^(n-1) 个 Lv1「单位」 */
const unit = (lv) => Math.pow(2, lv - 1);

/**
 * baseScore 上界系数。
 *
 * 合成出等级 n 的球得 n 分，而造出它至少要消耗 2^(n-1) 个单位，
 * 所以总分 ≤ U × Σ(n / 2^(n-1))，n = 2..11。
 * U = Σ 2^(lv-1)（本次对局所有投放球折算成 Lv1 的总量）
 *
 * 这个 Σ 收敛到 ≈ 2.987，所以「分数不可能超过投放总量的 3 倍」——
 * 一句人话就能解释给社团里的人听。
 */
const BASE_COEF = (() => {
  let s = 0;
  for (let n = 2; n <= MAX_LEVEL; n++) s += n / Math.pow(2, n - 1);
  return s;
})();

export { BASE_COEF };

/**
 * 投放等级的统计上界。
 *
 * ⚠️ 这是一道**关键防线**，别删。
 *
 * 之前的写法是直接把 trace 里所有球的等级折算成单位数：
 *     units = Σ 2^(lv-1)
 * 而 trace 完全由玩家自报。攻击者喂 20000 颗 Lv5 就能得到 32 万单位，
 * 进而算出 312 个「完全体」，刷出 485 万共鸣分（线上真实最高分只有 2917）。
 *
 * 但真实对局的等级是从加权池 [35,25,20,12,8] 里抽的，平均每次投放
 * 只有 3.89 个单位，不可能次次 Lv5。所以这里按**投放次数**算一个
 * 统计学上界：N 次独立抽样的和，超过 N·E + 8σ 的概率约 1e-15，
 * 真人绝无可能踩到，而全 Lv5 的伪造会被直接卡死。
 */
const SPAWN_WEIGHTS = [35, 25, 20, 12, 8];
const UNIT_MEAN = SPAWN_POOL.reduce(
  (s, lv, i) => s + SPAWN_WEIGHTS[i] * Math.pow(2, lv - 1), 0,
) / SPAWN_WEIGHTS.reduce((a, b) => a + b, 0);
const UNIT_VAR = SPAWN_POOL.reduce(
  (s, lv, i) => s + SPAWN_WEIGHTS[i] * Math.pow(Math.pow(2, lv - 1) - UNIT_MEAN, 2), 0,
) / SPAWN_WEIGHTS.reduce((a, b) => a + b, 0);
/** 8 个标准差，宽到不可能误杀真人 */
const UNIT_SIGMA = 8;

/** N 次投放最多能折算多少单位（统计上界） */
function maxUnitsForDrops(n) {
  return n * UNIT_MEAN + UNIT_SIGMA * Math.sqrt(n * UNIT_VAR);
}

/**
 * 经典模式里**同时**贴在场上互相接触的完全体数量上限。
 *
 * 完全体直径 461，容器内宽 1001、内高 1400 —— 面积上最多塞下约 8 个。
 * 共鸣要求两个完全体同时贴着，所以每个完全体一生中参与的共鸣对数
 * 受同屏数量限制。取 12（比实际宽松 50%）。
 */
const MAX_TOP_COEXISTING = 12;

export { UNIT_MEAN, UNIT_VAR, maxUnitsForDrops, MAX_TOP_COEXISTING };

/**
 * 校验一局成绩。返回 { ok, flags, upper, units }
 * ok=false 时这条记录照样入库，只是 suspicious=1，不上榜（保留证据，误杀可人工放行）。
 */
export function validateRun(p) {
  const flags = [];
  const { mode, score, maxLevel, merges, loopCount, durationMs, trace } = p;

  // ── 基本结构
  if (mode !== 'classic' && mode !== 'endless') flags.push(`未知模式 ${mode}`);
  if (!Number.isInteger(score) || score < 0) flags.push(`分数非法: ${score}`);
  if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > MAX_LEVEL) {
    flags.push(`最高等级非法: ${maxLevel}`);
  }
  // durationMs 只要求是有限数 —— 客户端算出来带小数很正常，不能因为小数就判作弊
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > MAX_RUN_MS) {
    flags.push(`对局时长非法: ${durationMs}ms`);
  }
  if (!Array.isArray(trace) || trace.length === 0) {
    return { ok: false, flags: ['缺少操作序列'], upper: 0, units: 0 };
  }
  if (trace.length > 20000) flags.push(`操作序列过长: ${trace.length}`);

  // ── 1. 等级序列：前 5 球固定，之后只能从随机池里出
  for (let i = 0; i < trace.length; i++) {
    const lv = trace[i]?.lv;
    if (mode === 'endless' && isEasterEggLevel(lv)) continue;
    if (!Number.isInteger(lv) || lv < 1 || lv > SPAWN_POOL[SPAWN_POOL.length - 1]) {
      flags.push(`第 ${i + 1} 球等级非法: ${lv}`);
      break;
    }
    if (i < SPAWN_TUTORIAL.length) {
      if (lv !== SPAWN_TUTORIAL[i]) {
        flags.push(`第 ${i + 1} 球应为等级 ${SPAWN_TUTORIAL[i]}，上报 ${lv}`);
        break;
      }
    } else if (!SPAWN_POOL.includes(lv)) {
      flags.push(`第 ${i + 1} 球等级 ${lv} 不在随机池内`);
      break;
    }
  }

  // ── 2. 时间戳递增且落在对局时长内
  let prev = -1;
  for (let i = 0; i < trace.length; i++) {
    const t = trace[i]?.t;
    if (!Number.isFinite(t) || t < 0) {
      flags.push(`第 ${i + 1} 球时间戳非法`);
      break;
    }
    if (t < prev) {
      flags.push(`第 ${i + 1} 球时间戳倒流`);
      break;
    }
    if (Number.isFinite(durationMs) && t > durationMs + 5000) {
      flags.push(`第 ${i + 1} 球时间戳超出对局时长`);
      break;
    }
    prev = t;
  }

  // ── 3. 投放速率：人不可能 450ms 一颗连点一整局
  if (Number.isFinite(durationMs) && durationMs > 0) {
    const maxDrops = Math.floor(durationMs / MIN_DROP_INTERVAL_MS) + DROP_COUNT_GRACE;
    if (trace.length > maxDrops) {
      flags.push(`投放 ${trace.length} 次，超出时长允许的 ${maxDrops} 次`);
    }
  }

  // ── 4. 合成次数不可能超过「投放数 - 1」
  //     每次投放 +1 球，每次合成 -1 球，场上至少留 1 球 ⇒ merges ≤ drops - 1
  //
  //     注意：外面用 Number.isInteger 判断，非整数会**整段跳过校验**。
  //     所以这里不能只依赖它 —— 非整数本身就是一个必须记的 flag。
  for (const [name, v] of [['merges', merges], ['loopCount', loopCount]]) {
    if (!Number.isInteger(v)) flags.push(`${name} 不是整数: ${v}`);
    else if (v < 0) flags.push(`${name} 为负: ${v}`);
  }
  const ordinaryDrops = trace.filter(e => !isEasterEggLevel(e?.lv)).length;
  const maxMerges = Math.max(0, ordinaryDrops - 1);
  if (Number.isInteger(merges) && merges > maxMerges) {
    flags.push(`合成 ${merges} 次，但只投放了 ${ordinaryDrops} 个普通球（上限 ${maxMerges}）`);
  }
  if (Number.isInteger(merges) && Number.isInteger(loopCount) && loopCount > merges) {
    flags.push(`循环 ${loopCount} 次多于合成 ${merges} 次`);
  }
  if (mode === 'classic' && Number.isFinite(loopCount) && loopCount > 0) {
    flags.push('经典模式不应出现循环计数');
  }

  // ── 5. 核心：分数上界
  //
  // ⚠️ 下面这行**必须**用可选链。曾经写成 `unit(e.lv)`，
  //    trace 里混一个 null 就让整个校验抛异常 → 500 + 内部错误外泄。
  let rawUnits = 0;
  for (const e of trace) if (!isEasterEggLevel(e?.lv)) rawUnits += unit(e?.lv ?? 0);

  // 按投放次数做统计封顶 —— 挡住"全部上报 Lv5"这种伪造。
  const unitsCap = maxUnitsForDrops(ordinaryDrops);
  const units = Math.min(rawUnits, unitsCap);
  const unitsClamped = rawUnits > unitsCap;
  if (unitsClamped) {
    flags.push(
      `折算单位 ${Math.round(rawUnits)} 超出 ${trace.length} 次投放的统计上界 ` +
      `${Math.round(unitsCap)}（等级分布不可能是这样）`,
    );
  }

  let bonusUpper = 0;
  // 无尽模式的循环会白送 Lv1，这些免费单位还能再参与合成，
  // 所以基础分的"有效投放量"要把它加回去。
  let unitsForBase = units;

  if (mode === 'classic') {
    // 一个完全体要吃 2^10 = 1024 个单位。
    //
    // ⚠️ 这里**不能**用 C(n,2)。数学上「n 个完全体两两共鸣」确实等于 C(n,2)，
    //    但 n 是由玩家自报的 trace 推出来的，二次项会被线性放大成刷分工具
    //    （实测 20000 颗 Lv5 → 312 个完全体 → 485 万共鸣分）。
    //    真正的约束是物理的：完全体直径 461、容器装不下几个，共鸣要求
    //    两个同时贴着，所以每个完全体一生参与的共鸣对数 ≤ 同屏上限。
    const maxTop = Math.floor(units / unit(MAX_LEVEL));
    // 两个约束都要满足，取更紧的那个：
    //   · 数学上：n 个完全体两两共鸣最多 C(n,2) 对
    //   · 物理上：共鸣要求两个完全体**同时**贴上，而同屏最多
    //             MAX_TOP_COEXISTING 个 —— 所以每诞生一个完全体，
    //             它最多和当时在场的那么多个各共鸣一次。
    //             （注意这里不能用 /2：每对只在第二个球诞生时计一次，不重复计。）
    const mathPairs = (maxTop * Math.max(0, maxTop - 1)) / 2;
    const physicalPairs = maxTop * (MAX_TOP_COEXISTING - 1);
    bonusUpper = RESONANCE_SCORE * Math.floor(Math.min(mathPairs, physicalPairs));
  } else {
    // 一次循环吃掉 2 个完全体（2048 单位）但吐回 1 个 Lv1，净消耗 2047 单位，
    // 所以 K ≤ units / 2047。
    const maxLoops = Math.floor(units / (2 * unit(MAX_LEVEL) - 1));
    bonusUpper = (RECYCLE_BASE * maxLoops * (maxLoops + 1)) / 2;
    unitsForBase = units + maxLoops;
  }

  const upper = (BASE_COEF * unitsForBase + bonusUpper) * TOLERANCE;

  if (Number.isInteger(score) && score > upper) {
    flags.push(
      `分数 ${score} 超过理论上界 ${Math.floor(upper)}` +
      `（投放 ${trace.length} 次，折算 ${units} 个基础单位）`,
    );
  }

  // ── 6. 最高等级和投放量是否自洽
  if (Number.isInteger(maxLevel) && maxLevel >= 1 && maxLevel <= MAX_LEVEL) {
    const need = unit(maxLevel);
    if (units < need && !(maxLevel === 1 && ordinaryDrops === 0)) {
      flags.push(`上报最高等级 ${maxLevel} 需要 ${need} 个单位，实际只有 ${units}`);
    }
  }

  // ── 7. 自动投放（定时器宏 / 固定网格）—— **只在完整 trace 上判**
  //
  // 2026-10-19 的教训：这条原来只挂在 checkpoint（对局中途）上，等于拿**半截 trace**
  // 去套一套按**完整 trace** 标定的阈值。真人开局前 60–120 次投放的落点最少只有 4 种
  // （玩家T 实测），中途判会把正常玩家当成脚本 —— 线上确实误标了 3 局
  // （#412/#414/#416，其中 #414 的最终 trace 有 647 个落点，纯属按住半截数据判的）。
  // 判据本身没问题，位置错了。放回这里：一局结束、trace 完整、标定成立。
  if (Array.isArray(trace) && trace.length >= BOT_RULES.minDrops) {
    const automated = detectAutomatedDrops(trace);
    if (automated) flags.push(describeAutomatedDrops(automated));
  }

  return { ok: flags.length === 0, flags, upper, units };
}

// ══════════════════════════════════════════ 昵称校验（与 web/src/nick.ts 一致）

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

const BANNED = [
  /(傻|煞|沙)\s*逼/i,
  /操\s*你|草\s*你|日\s*你/,
  /他妈|妈的|尼玛|泥马/,
  /nmsl|cnm|tmd/i,
  /fuck|shit|bitch|asshole/i,
  /加\s*(微信|wx|qq|群)/i,
  /代\s*刷|刷\s*分|外挂|脚本/,
  /出售|低价|私聊|广告位/,
  /https?:\/\//i,
  /www\./i,
];

export const NICK_MIN = 1;
export const NICK_MAX = 12;

function countEmoji(s) {
  const m = s.match(/\p{Extended_Pictographic}/gu);
  return m ? m.length : 0;
}

/** 返回 null = 合法；否则返回错误提示 */
export function validateNickname(raw) {
  if (typeof raw !== 'string') return '签名格式不对';
  const nick = raw.replace(INVISIBLE, '').replace(CONTROL, '').trim();
  if (!nick) return '签名不能是空的哦';
  if (/\s{2,}/.test(nick)) return '不要连续打空格';

  const len = Array.from(nick).length;
  if (len < NICK_MIN) return '太短啦';
  if (len > NICK_MAX) return `最多 ${NICK_MAX} 个字`;

  if (countEmoji(nick) > 3) return 'emoji 最多 3 个';
  if (!/[\p{L}\p{N}]/u.test(nick)) return '至少要有字母、数字或汉字';

  for (const re of BANNED) if (re.test(nick)) return '这个签名不能用，换一个吧';
  return null;
}

export function cleanNickname(raw) {
  return Array.from(String(raw).replace(INVISIBLE, '').replace(CONTROL, '').trim())
    .slice(0, NICK_MAX)
    .join('');
}
