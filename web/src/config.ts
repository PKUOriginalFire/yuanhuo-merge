/**
 * 合成大元火 —— 全部可调常量
 *
 * 设计原则：任何需要"调手感"的数字都放在这个文件里，逻辑代码不出现魔法数字。
 * 改完保存，Vite 热更新立刻生效，不需要重启。
 */

/** 虚拟坐标系。宽固定 1125（iPhone @3x 设计稿），渲染时整体缩放到屏幕 */
export const WORLD = { w: 1125, h: 2000 } as const;

/**
 * 罐子（容器）几何 —— 决定物理边界和死亡线
 *
 * ⚠️ 如果你有现成的背景图，罐子口和罐底必须和这里对齐。
 *    启动时加 ?debug=1 会画出青色边界框和红色死亡线，照着对就行。
 */
export const CONTAINER = {
  /** 左内壁 x */
  left: 62,
  /** 右内壁 x（内宽 = right - left = 1001） */
  right: 1063,
  /** 地面 y */
  floor: 1940,
  /** 罐口 y，同时也是死亡线：球顶越过这条线并持续 deathGraceMs 就判负 */
  deathLineY: 540,
  /** 墙体厚度（做得很厚是为了防止高速小球穿透） */
  wallThickness: 400,
  /** 越线后需要持续多久才判负（避免误判、给玩家抢救机会） */
  deathGraceMs: 2000,
  /** 新投放球的宽限期：刚掉下来还没落稳时不算越线 */
  spawnGraceMs: 800,
} as const;

/** 待投放球（悬在罐口上方跟着手指走的那颗） */
export const DROP = {
  /** 悬停高度 y */
  y: 430,
  /** 投放冷却，防止连点刷球 */
  cooldownMs: 400,
  /** 左右限制，避免球心贴到屏幕上 */
  padX: 30,
} as const;

/**
 * 11 个等级。
 *
 * diameter 是 @1125 宽设计稿的直径，约 ×1.166 递增。
 * sprite 指向 web/public/assets/ 下的文件名 —— 直接换成你的美术图即可，
 * 尺寸不用改：渲染时按 diameter / 贴图实际宽度 自动缩放。
 *
 * 形象方案（已定稿）：Lv1-4 社团周边小物件，Lv5-11 元火娘 7 个形态。
 */
export interface LevelConfig {
  level: number;
  diameter: number;
  sprite: string;
  name: string;
  /** 占位图配色（美术图缺失时用），换成正式图后可忽略 */
  color: string;
}

export const LEVELS: readonly LevelConfig[] = [
  { level: 1,  diameter:  90, sprite: 'lv01.png', name: '元火社徽',   color: '#ff7043' },
  { level: 2,  diameter: 106, sprite: 'lv02.png', name: '荧光棒',     color: '#ffa726' },
  { level: 3,  diameter: 125, sprite: 'lv03.png', name: '吧唧',       color: '#ffd54f' },
  { level: 4,  diameter: 147, sprite: 'lv04.png', name: '同人本',     color: '#aed581' },
  { level: 5,  diameter: 173, sprite: 'lv05.png', name: '元火娘·日常', color: '#4fc3f7' },
  { level: 6,  diameter: 204, sprite: 'lv06.png', name: '元火娘·水手服', color: '#4dd0e1' },
  { level: 7,  diameter: 240, sprite: 'lv07.png', name: '元火娘·女仆', color: '#7986cb' },
  { level: 8,  diameter: 283, sprite: 'lv08.png', name: '元火娘·巫女', color: '#ba68c8' },
  { level: 9,  diameter: 333, sprite: 'lv09.png', name: '元火娘·魔法少女', color: '#f06292' },
  { level: 10, diameter: 392, sprite: 'lv10.png', name: '元火娘·偶像', color: '#ff8a65' },
  { level: 11, diameter: 461, sprite: 'lv11.png', name: '元火娘·完全体', color: '#ff5252' },
] as const;

/**
 * ⚠️ 尺寸不是随便定的，Lv11 的直径有一个硬约束：
 *
 *   容器内宽 − 2 × Lv11直径  <  Lv1直径
 *   即 1001 − 2×461 = 79  <  90  ✓
 *
 * 这样两个完全体并排时中间的空隙（79px）塞不下最小的球（90px），
 * 堆叠一定会把它们挤到一起 → 经典模式的「共鸣」才可能触发。
 *
 * 如果哪天改了 CONTAINER 的宽度或 Lv11 直径，务必重新验算这个不等式，
 * 否则经典模式的共鸣会变成一个永远触发不了的死功能。
 */

/** 最高等级（= LEVELS.length），两个最大球相撞触发的就是它 */
export const MAX_LEVEL = LEVELS.length;

/** 下一个球的生成规则 */
export const SPAWN = {
  /** 前 5 球固定，当新手引导 */
  tutorial: [1, 1, 2, 2, 3],
  /** 之后从这些等级里加权随机 */
  pool: [1, 2, 3, 4, 5],
  weights: [35, 25, 20, 12, 8],
} as const;

/** 合成得分：合成出等级 n 的球 → +n 分 */
export const SCORE = {
  /** 合成出等级 n 的球得 n 分 */
  perMerge: (n: number) => n,
} as const;

/** 两种模式 */
export type GameMode = 'classic' | 'endless';

export interface ModeRule {
  id: GameMode;
  label: string;
  /** 一句话说明，直接显示在模式选择页 */
  desc: string;
  /** 两个最高级球相撞时的行为 */
  maxCollision: 'resonate' | 'recycle';
  /** ○ resonate：两球相撞一次给的分（球不动、不合并、不消失） */
  resonanceScore: number;
  /** ○ recycle：变回 Lv1 的基准分，实际得分 = base × 循环次数 */
  recycleBaseScore: number;
}

export const MODES: Record<GameMode, ModeRule> = {
  classic: {
    id: 'classic',
    label: '经典模式',
    desc: '两个完全体相撞会「共鸣」并永久留在场上，考的是空间管理',
    maxCollision: 'resonate',
    resonanceScore: 100,
    recycleBaseScore: 0,
  },
  endless: {
    id: 'endless',
    label: '无尽模式',
    desc: '两个完全体相撞会变回元火社徽，可以一直循环冲分',
    maxCollision: 'recycle',
    resonanceScore: 0,
    recycleBaseScore: 500,
  },
};

/** Matter.js 物理参数 —— 手感全在这里 */
export const PHYSICS = {
  gravity: 1.0,
  /** 球与球之间的弹性 */
  restitution: 0.2,
  /** 球与墙壁的弹性 */
  wallRestitution: 0.15,
  friction: 0.5,
  frictionStatic: 0.6,
  /** 空气阻力，调大一点可以抑制大球堆的抖动 */
  frictionAir: 0.0005,
  /** 密度恒定 → 质量随面积增长，大球天然更沉 */
  density: 0.001,
  slop: 0.02,
  /** 固定步长，保证不同刷新率下手感一致 */
  fixedDeltaMs: 1000 / 60,
  /** 单帧最多补几步，防止切后台回来时炸掉 */
  maxSubSteps: 4,
  velocityIterations: 6,
  positionIterations: 8,
} as const;

/** 运行时开关（由 URL 参数覆盖，见 main.ts） */
export const FLAGS: {
  /** ?debug=1 画出物理边界 / 死亡线 / 碰撞体，用来和背景图的罐子对齐 */
  debug: boolean;
  /** ?mock=1 用前端本地假排行榜，后端没起来也能调 UI */
  mock: boolean;
  /** ?speed=2 加速物理（调试用） */
  speed: number;
} = {
  debug: false,
  mock: false,
  speed: 1,
};

/** 排行榜 */
export const BOARD = {
  /** 每榜显示多少名 */
  topN: 50,
  /** 分数排进前多少名才弹签名框 */
  promptRank: 100,
  /** 昵称长度限制 */
  nickMin: 1,
  nickMax: 12,
} as const;
