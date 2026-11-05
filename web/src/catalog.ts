import type { GameMode } from './config';
import { EASTER_EGGS, isEasterEggLevel, type EasterEggLevel } from './easter-eggs';

export interface CatalogEntry {
  id: string;
  name: string;
  label: string;
  description: string;
  sprite: string;
  status?: string;
}

export const CATALOG: Record<GameMode, readonly CatalogEntry[]> = {
  classic: [
    activity('autumn-welcome', '秋季百团迎新', '嘿嘿…新鲜的元火子…嘿嘿…'),
    activity('welcome-gala', '迎新晚会', '“移除了黑幕”'),
    activity('lecture', '高端讲座', '“外联你发一下力啊外联”'),
    activity('band-live', '乐队专场', '超伟大对吧，十人十色！'),
    activity('vocaloid-meeting', 'V家例会', '我去，（）'),
    activity('touhou-meeting', '东方例会', '“求真向北，幻想指南”'),
    activity('cos-cafe', 'COS咖啡厅', '“得！劲！魔！法！”'),
    activity('spring-welcome', '春季百团迎新', '其实就是补录（不'),
    activity('spring-gala', '春季晚会', '难～忘～今～宵～'),
    activity('anniversary', '社庆', '元火又长大一岁，但是元火娘永远17岁'),
    activity('yuanhuo-logo', '元火标志', '欧耶，圆圆的火！'),
  ],
  endless: [
    role('animation', '动研部', '动研', '“两口一串”“频率没那么低”'),
    role('publicity', '宣传部', '宣传', '这是语C！这是女同！这是小甜饼！'),
    role('organization', '组织部', '组织', '是啊，吃什么'),
    role('practice', '实践部', '实践', '会画画…到底是…什么感觉…'),
    role('cos', 'COS部', 'COS', '会考斯…到底是…什么感觉…'),
    role('technology', '技术部', '技术', '所有agent全部启动启动启动！还有这个！'),
    role('daily-vice', '日常副社', '日常', '人称小活'),
    role('outreach-vice', '外联副社', '外联', '我高端讲座呐？'),
    role('venue-finance-vice', '场财副社', '场财', '又名社宠、吉祥物'),
    role('activities-vice', '大活副社', '大活', '大就是好！好就是大！'),
    role('president', '社长', '社长', '元火子们的妈妈'),
  ],
};

export const SECRET_CATALOG: Record<GameMode, CatalogEntry> = {
  classic: {
    id: 'night-run',
    name: '医学部夜奔',
    label: '夜奔',
    description: '哎我草早苗怎么这么坏啊',
    sprite: 'secrets/night-run.webp',
    status: '停办、复活赛中',
  },
  endless: {
    id: 'stage',
    name: '舞台部',
    label: '舞台',
    description: '自！刎！归！天！',
    sprite: 'secrets/stage.webp',
    status: '已解散',
  },
};

export const EASTER_EGG_CATALOG = Object.fromEntries(EASTER_EGGS.map(egg => [egg.level, {
  id: egg.level === -1 ? 'youth-secretary' : 'chair', name: egg.name, label: egg.name,
  description: `这是什么？\n\n没什么用的彩蛋，但是出现概率只有${egg.probability}，你可以把它截图发在大群里来证明你很幸运`,
  sprite: '',
}])) as Record<EasterEggLevel, CatalogEntry>;

export function entryFor(mode: GameMode, level: number): CatalogEntry {
  if (mode === 'endless' && isEasterEggLevel(level)) return EASTER_EGG_CATALOG[level];
  const entry = CATALOG[mode][level - 1];
  if (!Number.isInteger(level) || !entry) {
    throw new RangeError(`无效的 ${mode} 等级：${level}`);
  }
  return entry;
}

function activity(id: string, name: string, description: string): CatalogEntry {
  return { id, name, label: name, description, sprite: `activities/${id}.webp` };
}

function role(id: string, name: string, label: string, description: string): CatalogEntry {
  return { id, name, label, description, sprite: `roles/${id}.webp` };
}
