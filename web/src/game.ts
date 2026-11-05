import Matter from 'matter-js';
import { SecretSchedule, SECRET_RULES } from './secret.js';
import { ballDiameter, isEasterEggLevel, rollEasterEgg } from './easter-eggs.js';
import {
  CONTAINER, DROP, FLAGS, MAX_LEVEL, MODES, PHYSICS, SCORE, SPAWN,
  type GameMode,
} from './config.js';

const { Engine, Bodies, Body, Composite, Events } = Matter;

/** 一次投放记录，用于服务端防作弊校验 */
export interface TraceEntry {
  /** 相对开局的时间戳 ms */
  t: number;
  /** 归一化落点 0..1 */
  x: number;
  /** 投放的等级 */
  lv: number;
}

/** 场上的一颗球 */
export interface Ball {
  id: number;
  level: number;
  body: Matter.Body;
  /** 出生时间（performance.now），用于投放宽限期 */
  bornAt: number;
}

/** 表现层事件 —— 渲染和音效订阅这些，不参与逻辑 */
export interface GameEvents {
  onDiscover?: (level: number) => void;
  onSecret?: (count: number) => void;
  /** 球落定（投放） */
  onDrop?: (ball: Ball) => void;
  /** 普通合成 */
  onMerge?: (level: number, x: number, y: number, gained: number) => void;
  /** 经典模式：两个完全体共鸣（球不动） */
  onResonate?: (x: number, y: number, gained: number) => void;
  /** 无尽模式：完全体循环回最小 */
  onRecycle?: (x: number, y: number, loop: number, gained: number) => void;
  /** 分数变化 */
  onScore?: (score: number) => void;
  /** 游戏结束 */
  onGameOver?: (reason: 'overflow') => void;
}

interface QueuedMerge {
  a: Ball;
  b: Ball;
}

export interface GameSnapshot {
  version: 1;
  easterEggs?: true;
  mode: GameMode;
  status: Game['status'];
  score: number; merges: number; loopCount: number; maxLevelReached: number;
  heldLevel: number; nextLevel: number; heldX: number; spawnCount: number;
  now: number; elapsed: number; accumulator: number; dropCooldownUntil: number;
  overLineSince: number | null; engineTime: number; randomState: number;
  secretCount: number; secretCycle: number; trace: TraceEntry[]; resonatedPairs: string[];
  balls: { id: number; level: number; x: number; y: number; vx: number; vy: number; angle: number; angularVelocity: number; deltaTime: number; bornAt: number }[];
}

export class Game {
  readonly mode: GameMode;
  readonly events: GameEvents;

  private engine: Matter.Engine;
  private balls = new Map<number, Ball>();
  private mergeQueue: QueuedMerge[] = [];
  private consumed = new Set<number>();

  /** 经典模式：已经共鸣过的球对，key = "小id-大id" */
  private resonatedPairs = new Set<string>();

  score = 0;
  merges = 0;
  loopCount = 0;
  maxLevelReached = 1;
  status: 'ready' | 'playing' | 'over' = 'ready';

  /** 待投放 / 下一个 */
  heldLevel: number;
  nextLevel: number;
  heldX: number;
  private dropCooldownUntil = 0;
  private spawnCount = 0;

  private elapsed = 0;
  private accumulator = 0;
  private overLineSince: number | null = null;
  private now = 0;

  readonly trace: TraceEntry[] = [];
  secretCount = 0;
  secretAim: { x: number; y: number } | null = null;
  private readonly secretSchedule: SecretSchedule;
  private randomState: number;
  private readonly easterEggs: boolean;

  constructor(mode: GameMode, events: GameEvents = {}, seed = Math.floor(Math.random() * 0x100000000), enableEasterEggs = true) {
    this.mode = mode;
    this.easterEggs = mode === 'endless' && enableEasterEggs;
    this.randomState = seed >>> 0;
    this.secretSchedule = new SecretSchedule(mode, () => this.random());
    this.events = events;
    this.engine = Engine.create({
      gravity: { x: 0, y: PHYSICS.gravity, scale: 0.001 },
    });
    this.engine.positionIterations = PHYSICS.positionIterations;
    this.engine.velocityIterations = PHYSICS.velocityIterations;

    this.buildWalls();
    Events.on(this.engine, 'collisionStart', this.onCollisionStart);

    this.heldLevel = this.levelForDrop(0);
    this.nextLevel = this.levelForDrop(1);
    this.heldX = (CONTAINER.left + CONTAINER.right) / 2;
  }

  // ────────────────────────────────────────────── 世界构建

  private buildWalls() {
    const { left, right, floor, wallThickness: t } = CONTAINER;
    const wallOpts: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      restitution: PHYSICS.wallRestitution,
      friction: PHYSICS.friction,
      label: 'wall',
    };
    const innerW = right - left;
    const cx = (left + right) / 2;
    // 墙做得极厚 + 延伸很高，防止高速球穿透或从上方飞出
    const walls = [
      Bodies.rectangle(left - t / 2, floor - 1000, t, 3000, wallOpts),
      Bodies.rectangle(right + t / 2, floor - 1000, t, 3000, wallOpts),
      Bodies.rectangle(cx, floor + t / 2, innerW + t * 2, t, wallOpts),
    ];
    Composite.add(this.engine.world, walls);
  }

  private makeBallBody(level: number, x: number, y: number): Matter.Body {
    const r = ballDiameter(level) / 2;
    return Bodies.circle(x, y, r, {
      label: 'ball',
      restitution: PHYSICS.restitution,
      friction: PHYSICS.friction,
      frictionStatic: PHYSICS.frictionStatic,
      frictionAir: PHYSICS.frictionAir,
      density: PHYSICS.density,
      slop: PHYSICS.slop,
    });
  }

  private addBall(level: number, x: number, y: number, bornAt?: number, discover = true): Ball {
    const body = this.makeBallBody(level, x, y);
    const ball: Ball = {
      id: body.id,
      level,
      body,
      bornAt: bornAt ?? this.now,
    };
    Composite.add(this.engine.world, body);
    this.balls.set(body.id, ball);
    if (level > this.maxLevelReached) this.maxLevelReached = level;
    if (discover) this.events.onDiscover?.(level);
    return ball;
  }

  private removeBall(ball: Ball) {
    Composite.remove(this.engine.world, ball.body);
    this.balls.delete(ball.id);
    this.consumed.add(ball.id);
  }

  // ────────────────────────────────────────────── 投放

  get canDrop(): boolean {
    return this.status === 'playing' && this.now >= this.dropCooldownUntil;
  }

  setAimX(x: number) {
    this.heldX = Math.min(
      CONTAINER.right - DROP.padX,
      Math.max(CONTAINER.left + DROP.padX, x),
    );
  }

  /** 投放当前球。返回是否真的投放了 */
  drop(): boolean {
    if (!this.canDrop) return false;
    const level = this.heldLevel;
    const x = this.heldX;
    const ball = this.addBall(level, x, DROP.y);
    Body.setVelocity(ball.body, { x: 0, y: 0 });
    Body.setAngularVelocity(ball.body, 0);

    this.trace.push({
      t: Math.round(this.elapsed),
      x: Number(((x - CONTAINER.left) / (CONTAINER.right - CONTAINER.left)).toFixed(4)),
      lv: level,
    });

    this.spawnCount++;
    this.heldLevel = this.nextLevel;
    this.nextLevel = this.levelForDrop(this.spawnCount + 1);
    this.dropCooldownUntil = this.now + DROP.cooldownMs;
    this.events.onDrop?.(ball);
    this.awardSecrets(true);
    return true;
  }

  /** 前 5 球固定，之后按权重随机 —— 服务端用同一套规则校验 */
  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }

  private levelForDrop(i: number): number {
    const ordinary = this.ordinaryLevelForDrop(i);
    return this.easterEggs ? rollEasterEgg(this.random()) ?? ordinary : ordinary;
  }

  private ordinaryLevelForDrop(i: number): number {
    if (i < SPAWN.tutorial.length) return SPAWN.tutorial[i];
    const total = SPAWN.weights.reduce((a, b) => a + b, 0);
    let r = this.random() * total;
    for (let k = 0; k < SPAWN.pool.length; k++) {
      r -= SPAWN.weights[k];
      if (r <= 0) return SPAWN.pool[k];
    }
    return SPAWN.pool[0];
  }

  private awardSecrets(roll = false) {
    const count = this.secretSchedule.poll(this.score, roll);
    if (count) {
      this.secretCount += count;
      this.events.onSecret?.(this.secretCount);
    }
  }

  setSecretAim(x: number, y: number) {
    this.secretAim = this.isSecretTarget(x, y) ? { x, y } : null;
  }

  cancelSecretAim() { this.secretAim = null; }

  private isSecretTarget(x: number, y: number) {
    return Number.isFinite(x) && Number.isFinite(y)
      && x >= CONTAINER.left && x <= CONTAINER.right && y >= DROP.y && y <= CONTAINER.floor;
  }

  /** null means cancelled; zero means a valid empty area. Clearing never changes scoring or trace. */
  useSecret(x: number, y: number): number | null {
    if (this.status !== 'playing' || this.secretCount === 0 || !this.isSecretTarget(x, y)) return null;
    let removed = 0;
    for (const ball of this.balls.values()) {
      if (isEasterEggLevel(ball.level)) continue;
      const radius = ballDiameter(ball.level) / 2;
      if (Math.hypot(ball.body.position.x - x, ball.body.position.y - y) <= SECRET_RULES.radius + radius) {
        this.removeBall(ball); removed++;
      }
    }
    this.secretCount--;
    this.secretAim = null;
    this.checkOverflow();
    return removed;
  }

  // ────────────────────────────────────────────── 碰撞 → 合成

  private onCollisionStart = (e: Matter.IEventCollision<Matter.Engine>) => {
    if (this.status !== 'playing') return;
    for (const pair of e.pairs) {
      const a = this.balls.get(pair.bodyA.id);
      const b = this.balls.get(pair.bodyB.id);
      if (!a || !b) continue;
      if (isEasterEggLevel(a.level) || isEasterEggLevel(b.level)) continue;
      if (a.level !== b.level) continue;
      if (this.consumed.has(a.id) || this.consumed.has(b.id)) continue;

      if (a.level === MAX_LEVEL) {
        // 最高级相撞 —— 两种模式在这里分道扬镳
        if (MODES[this.mode].maxCollision === 'resonate') {
          const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
          if (this.resonatedPairs.has(key)) continue;
          this.resonatedPairs.add(key);
          const gained = MODES[this.mode].resonanceScore;
          this.score += gained;
          this.events.onScore?.(this.score);
          this.events.onResonate?.(
            (a.body.position.x + b.body.position.x) / 2,
            (a.body.position.y + b.body.position.y) / 2,
            gained,
          );
        } else {
          this.mergeQueue.push({ a, b });
        }
      } else {
        this.mergeQueue.push({ a, b });
      }
    }
  };

  /** 物理步进之后再处理合成，避免在碰撞回调里增删刚体 */
  private processMergeQueue() {
    if (this.mergeQueue.length === 0) return;
    const queue = this.mergeQueue;
    this.mergeQueue = [];

    for (const { a, b } of queue) {
      if (isEasterEggLevel(a.level) || isEasterEggLevel(b.level)) continue;
      if (this.consumed.has(a.id) || this.consumed.has(b.id)) continue;
      if (!this.balls.has(a.id) || !this.balls.has(b.id)) continue;

      const x = (a.body.position.x + b.body.position.x) / 2;
      const y = (a.body.position.y + b.body.position.y) / 2;

      this.removeBall(a);
      this.removeBall(b);
      this.merges++;

      if (a.level === MAX_LEVEL) {
        // 无尽模式：两个完全体 → 一个最小球，循环计数递增，分数递增
        this.loopCount++;
        const gained = MODES[this.mode].recycleBaseScore * this.loopCount;
        this.score += gained;
        const nb = this.addBall(1, x, y);
        Body.setVelocity(nb.body, { x: 0, y: -2 });
        this.events.onScore?.(this.score);
        this.events.onRecycle?.(x, y, this.loopCount, gained);
      } else {
        const newLevel = a.level + 1;
        const gained = SCORE.perMerge(newLevel);
        this.score += gained;
        const nb = this.addBall(newLevel, x, y);
        // 合成后给一点向上的初速，手感更"弹"
        Body.setVelocity(nb.body, { x: 0, y: -1.5 });
        this.events.onScore?.(this.score);
        this.events.onMerge?.(newLevel, x, y, gained);
      }
    }
  }

  // ────────────────────────────────────────────── 主循环

  update(dtMs: number) {
    this.now += dtMs;
    if (this.status !== 'playing') return;

    this.elapsed += dtMs;

    // 固定步长积分，保证不同刷新率下手感一致
    this.accumulator += dtMs * FLAGS.speed;
    let steps = 0;
    while (this.accumulator >= PHYSICS.fixedDeltaMs && steps < PHYSICS.maxSubSteps) {
      Engine.update(this.engine, PHYSICS.fixedDeltaMs);
      this.accumulator -= PHYSICS.fixedDeltaMs;
      steps++;
    }
    if (steps >= PHYSICS.maxSubSteps) this.accumulator = 0;

    this.processMergeQueue();
    this.awardSecrets();
    this.checkOverflow();
  }

  /** 越线判定：任意球顶越过死亡线并持续 deathGraceMs 才判负 */
  private checkOverflow() {
    let over = false;
    let matureOver = false;
    for (const ball of this.balls.values()) {
      const top = ball.body.position.y - ballDiameter(ball.level) / 2;
      if (top < CONTAINER.deathLineY) {
        over = true;
        if (this.now - ball.bornAt >= CONTAINER.spawnGraceMs) matureOver = true;
      }
    }
    if (!over) {
      this.overLineSince = null;
      return;
    }
    if (!matureOver) {
      this.overLineSince = null;
      return;
    }
    if (this.overLineSince === null) {
      this.overLineSince = this.now;
      return;
    }
    if (this.now - this.overLineSince >= CONTAINER.deathGraceMs) {
      this.status = 'over';
      this.events.onGameOver?.('overflow');
    }
  }

  // ────────────────────────────────────────────── 生命周期

  start() {
    if (this.status !== 'ready') return;
    this.status = 'playing';
  }

  /** 是否正处在越线宽限期（渲染层拿它闪红警告） */
  get overflowWarning(): boolean {
    return this.overLineSince !== null;
  }

  get overflowProgress(): number {
    if (this.overLineSince === null) return 0;
    return Math.min(1, (this.now - this.overLineSince) / CONTAINER.deathGraceMs);
  }

  get durationMs(): number {
    return Math.round(this.elapsed);
  }

  listBalls(): Ball[] {
    return [...this.balls.values()];
  }

  snapshot(): GameSnapshot {
    return {
      version: 1, mode: this.mode, status: this.status,
      ...(this.easterEggs ? { easterEggs: true as const } : {}),
      score: this.score, merges: this.merges, loopCount: this.loopCount, maxLevelReached: this.maxLevelReached,
      heldLevel: this.heldLevel, nextLevel: this.nextLevel, heldX: this.heldX, spawnCount: this.spawnCount,
      now: this.now, elapsed: this.elapsed, accumulator: this.accumulator, dropCooldownUntil: this.dropCooldownUntil,
      overLineSince: this.overLineSince, engineTime: this.engine.timing.timestamp, randomState: this.randomState,
      secretCount: this.secretCount, secretCycle: this.secretSchedule.checkpoint(),
      trace: this.trace.map(entry => ({ ...entry })), resonatedPairs: [...this.resonatedPairs],
      balls: this.listBalls().map(({ id, level, body, bornAt }) => ({
        id, level, x: body.position.x, y: body.position.y, vx: body.velocity.x, vy: body.velocity.y,
        angle: body.angle, angularVelocity: body.angularVelocity, deltaTime: (body as Matter.Body & { deltaTime: number }).deltaTime, bornAt,
      })),
    };
  }

  /** Restore a server-validated checkpoint or a local demonstration game. */
  static restore(state: GameSnapshot, events: GameEvents = {}): Game {
    if (state.version !== 1 || !MODES[state.mode]) throw new Error('对局版本不兼容');
    const game = new Game(state.mode, events, state.randomState, state.easterEggs === true);
    for (const key of ['score', 'merges', 'loopCount', 'maxLevelReached', 'heldLevel', 'nextLevel', 'heldX', 'spawnCount', 'now', 'elapsed', 'accumulator', 'dropCooldownUntil', 'overLineSince', 'randomState', 'secretCount'] as const) {
      // The server bounds and validates online checkpoints before returning them.
      (game as unknown as Record<string, unknown>)[key] = state[key];
    }
    game.status = state.status;
    game.secretSchedule.restore(state.secretCycle);
    game.trace.push(...state.trace.map(entry => ({ ...entry })));
    game.engine.timing.timestamp = state.engineTime;
    const ids = new Map<number, number>();
    for (const ball of state.balls) {
      const restored = game.addBall(ball.level, ball.x, ball.y, ball.bornAt, false);
      (restored.body as Matter.Body & { deltaTime: number }).deltaTime = ball.deltaTime;
      Body.setAngle(restored.body, ball.angle);
      Body.setVelocity(restored.body, { x: ball.vx, y: ball.vy });
      Body.setAngularVelocity(restored.body, ball.angularVelocity);
      ids.set(ball.id, restored.id);
    }
    for (const pair of state.resonatedPairs) {
      const [a, b] = pair.split('-').map(id => ids.get(Number(id)));
      if (a !== undefined && b !== undefined) game.resonatedPairs.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
    return game;
  }

  destroy() {
    Events.off(this.engine, 'collisionStart', this.onCollisionStart);
    Composite.clear(this.engine.world, false, true);
    Engine.clear(this.engine);
    this.balls.clear();
  }
}
