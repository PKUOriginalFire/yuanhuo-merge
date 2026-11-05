/**
 * 往数据库灌一批演示数据，方便看排行榜 UI。
 *
 * 运行：node server/seed.js [人数] [--reset]
 *   --reset  先清空 run / player 表再灌
 *
 * 数据是用贪心最优模拟器造的真实轨迹，**能通过防作弊校验**，
 * 所以顺便也验证了"正常玩家不会上榜失败"。
 */

import { db, getOrCreatePlayer, insertRun } from './db.js';
import { validateRun } from './validate.js';
import { simulate } from '../tools/simulate.js';

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const COUNT = Number(args.find((a) => /^\d+$/.test(a))) || 24;

/** 元火动漫社风格的假昵称 */
const NICKS = [
  '元火娘本娘', '未名湖的猫', '副社大人', '熬夜画稿中', '痛包收藏家',
  'Cos部新人', '同人本印刷机', '应援棒挥断手', '手办墙已满', '漫展限定',
  '会画画的咸鱼', '声优厨', '作画崩坏', '分镜杀手', '周边狂魔',
  '周三例会常客', '元火老咸鱼', '刚入社的', '社刊编辑', '隔壁桌的',
  '一只咕咕咕', '摸鱼冠军', '社恐但来了', '毕业了还来', '带新人的',
  '社费已交', '借了PSP不还', '点歌台常驻', '正在补番', '永远的新人',
];

function pickNick(i) {
  const base = NICKS[i % NICKS.length];
  return i < NICKS.length ? base : `${base}${Math.floor(i / NICKS.length) + 1}`;
}

if (RESET) {
  db.exec('DELETE FROM run; DELETE FROM player; DELETE FROM nickname_log;');
  console.log('已清空原有数据');
}

const now = Date.now();
let ok = 0;
let flagged = 0;

for (let i = 0; i < COUNT; i++) {
  const clientId = `seed-${String(i).padStart(3, '0')}-seedseedseed`;
  const player = getOrCreatePlayer(clientId);
  const nick = pickNick(i);

  db.prepare('UPDATE player SET nickname = ?, created_at = ? WHERE id = ?')
    .run(nick, now - Math.floor(Math.random() * 30 * 86400000), player.id);

  // 每人打 1~3 局，水平参差
  const runs = 1 + Math.floor(Math.random() * 3);
  for (let r = 0; r < runs; r++) {
    const mode = Math.random() < 0.5 ? 'classic' : 'endless';
    // 水平分布：新手 20~120 球，普通 100~400，高手 400~900
    const tier = Math.random();
    const drops = tier < 0.4
      ? 20 + Math.floor(Math.random() * 100)
      : tier < 0.85
        ? 100 + Math.floor(Math.random() * 300)
        : 400 + Math.floor(Math.random() * 500);

    // 真人做不到贪心最优，打个折
    const sim = simulate(mode, drops, i * 977 + r * 31 + 7, 1400 + Math.random() * 900);
    const factor = 0.55 + Math.random() * 0.4;
    const scaled = {
      ...sim,
      score: Math.max(1, Math.round(sim.score * factor)),
      merges: Math.max(0, Math.round(sim.merges * factor)),
      loopCount: Math.max(0, Math.round(sim.loopCount * factor)),
    };

    const v = validateRun(scaled);
    if (!v.ok) {
      flagged++;
      console.warn(`  ⚠️ 造的数据没通过校验（不该发生）: ${v.flags[0]}`);
    }

    insertRun({
      playerId: player.id,
      mode,
      score: scaled.score,
      maxLevel: scaled.maxLevel,
      merges: scaled.merges,
      loopCount: scaled.loopCount,
      durationMs: scaled.durationMs,
      drops: scaled.trace.length,
      trace: JSON.stringify(scaled.trace).slice(0, 200000),
      suspicious: false, // 造的数据一定是"干净的"
      flagReason: null,
      ipHash: null,
    });
    ok++;
  }
}

const s = db.prepare(`
  SELECT (SELECT COUNT(*) FROM player) AS players, (SELECT COUNT(*) FROM run) AS runs
`).get();

console.log(`\n灌入完成：${s.players} 个玩家，${s.runs} 局记录（本次新增 ${ok} 局，异常 ${flagged} 条）`);
for (const mode of ['classic', 'endless']) {
  const top = db.prepare(`
    SELECT p.nickname, MAX(r.score) AS best
    FROM run r JOIN player p ON p.id = r.player_id
    WHERE r.mode = ? AND r.suspicious = 0
    GROUP BY r.player_id ORDER BY best DESC LIMIT 3
  `).all(mode);
  console.log(`  ${mode.padEnd(8)} 前三：` + top.map((t, i) => `${i + 1}.${t.nickname} ${t.best}`).join('  '));
}
console.log('');
