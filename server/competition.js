/**
 * 赛事截止 + 最终榜单。
 *
 * 两个概念是分开的，别混：
 *   - 「截止」只认一件事：COMPETITION_ENDS_AT 这个时间点。到点之后，
 *     /api/run/start 与 /api/run/submit 一律 403，别的一概不拦
 *     （resume / checkpoint 不改变比赛结果，拦了只会让正在存盘的页面报错）。
 *   - 「最终榜单」是一个静态文件，截止后用它替掉实时查询。这样就算数据库
 *     以后被人动了，展示出来的名次也不会变。
 *
 * 环境变量：
 *   COMPETITION_ENDS_AT   截止时刻（毫秒时间戳，或能被 Date.parse 解析的字符串）。
 *                         不设 = 比赛进行中。
 *   FINAL_BOARD_PATH      最终榜单 JSON 路径，默认 server/data/final-board.json。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseInstant(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

const ENDS_AT = parseInstant(process.env.COMPETITION_ENDS_AT);
const BOARD_PATH = process.env.FINAL_BOARD_PATH || join(HERE, 'data', 'final-board.json');

/** 比赛是否已截止 */
export function competitionClosed(now = Date.now()) {
  return ENDS_AT > 0 && now >= ENDS_AT;
}

/** 截止时刻（毫秒）；0 表示没设 */
export function competitionEndsAt() {
  return ENDS_AT;
}

let cached = null;
let loadedAt = 0;

/**
 * 读最终榜单。文件不存在或格式不对就返回 null —— 调用方退化回实时查询，
 * 而不是让排行榜直接 500。
 */
export function finalBoard() {
  if (cached && Date.now() - loadedAt < 30_000) return cached;
  try {
    const raw = readFileSync(BOARD_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.classic) || !Array.isArray(data.endless)) return null;
    const norm = (list) => list.map((r, i) => ({
      rank: i + 1,
      nickname: String(r.nickname || '匿名元火人'),
      tag: String(r.tag || 'anon'),
      score: Number(r.score) || 0,
      maxLevel: Number(r.maxLevel) || 0,
      at: Number(r.at) || 0,
    }));
    cached = { classic: norm(data.classic), endless: norm(data.endless), generatedAt: data.generatedAt || '' };
    loadedAt = Date.now();
    return cached;
  } catch {
    return null;
  }
}

/** 截止后给客户端看的文案。时间用北京时间，别让玩家自己换算。 */
export function closedMessage() {
  const t = ENDS_AT > 0
    ? new Date(ENDS_AT).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '';
  return t ? `本届比赛已于 ${t} 截止，最终榜单已公布。感谢参与！` : '本届比赛已截止，最终榜单已公布。感谢参与！';
}
