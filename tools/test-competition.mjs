/**
 * 本地验证「赛事截止 + 冻结榜单」。
 *   node tools/test-competition.mjs <final-board.json>
 *
 * 起两个实例对着比：
 *   A: COMPETITION_ENDS_AT 已过 → 开局/提交必须 403，排行榜走冻结名单
 *   B: 不设 COMPETITION_ENDS_AT → 一切照旧（开局能过、排行榜走实时查询）
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const board = resolve(process.argv[2] || '');
const dir = mkdtempSync(join(tmpdir(), 'yh-comp-'));
copyFileSync(board, join(dir, 'final-board.json'));

const ROOT = resolve(import.meta.dirname, '..');
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

function launch(port, extraEnv) {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: join(dir, `db-${port}.db`),
      FINAL_BOARD_PATH: join(dir, 'final-board.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitUp(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`port ${port} 没起来`);
}

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const get = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const PAST = Date.now() - 60_000;   // 一分钟前截止

const A = launch(8899, { COMPETITION_ENDS_AT: String(PAST) });
const B = launch(8898, {});
const errs = [];
A.stderr.on('data', d => errs.push('A: ' + d));
B.stderr.on('data', d => errs.push('B: ' + d));

try {
  const hA = await waitUp(8899);
  await waitUp(8898);

  console.log('\n【实例 A：已截止】');
  ok('health 报告已截止', hA.competition?.ended === true, JSON.stringify(hA.competition));

  const board5 = await get(8899, '/api/leaderboard?mode=classic&top=5');
  ok('排行榜 200', board5.status === 200);
  ok('排行榜标记 closed', board5.body?.closed === true);
  ok('经典第 1 名是 玩家B 7492', board5.body?.rows?.[0]?.nickname === '玩家B' && board5.body?.rows?.[0]?.score === 7492,
    board5.body?.rows?.map(r => `${r.rank}.${r.nickname}:${r.score}`).join(' '));
  ok('只返回 5 行', board5.body?.rows?.length === 5);

  const boardE = await get(8899, '/api/leaderboard?mode=endless&top=3');
  ok('无尽第 1 名是猫猫 81085', boardE.body?.rows?.[0]?.score === 81085,
    boardE.body?.rows?.map(r => `${r.rank}.${r.nickname}:${r.score}`).join(' '));
  // 匿名玩家（「匿名元火人」）是不同的人，本来就该各占一行 —— UI 上会显示 #tag 区分。
  // 这里只查有名字的玩家不能重复出现。
  const endlessAll = (await get(8899, '/api/leaderboard?mode=endless&top=100')).body.rows;
  const named = endlessAll.map(r => r.nickname).filter(n => n !== '匿名元火人');
  const dupNamed = named.filter((n, i) => named.indexOf(n) !== i);
  ok('无尽榜里有名字的玩家不重复', dupNamed.length === 0, dupNamed.length ? '重复：' + dupNamed.join(',') : `${named.length} 个有名字的`);

  const classicAll = (await get(8899, '/api/leaderboard?mode=classic&top=100')).body.rows;
  const crossOverlap = classicAll.map(r => r.nickname).filter(n => n !== '匿名元火人' && named.includes(n));
  ok('两榜之间没有同一个人', crossOverlap.length === 0, crossOverlap.length ? '重叠：' + crossOverlap.join(',') : '零重叠');

  const startA = await post(8899, '/api/run/start', { clientId: randomUUID(), mode: 'classic', protocol: 2, easterEggs: 1, requestId: randomUUID() });
  ok('开局被拒（403）', startA.status === 403, `${startA.status} ${startA.body?.error || ''}`);
  ok('开局错误文案提到「截止」', /截止/.test(startA.body?.error || ''), startA.body?.error);

  const subA = await post(8899, '/api/run/submit', { clientId: randomUUID(), mode: 'classic', score: 100, maxLevel: 3, merges: 2, loopCount: 0, durationMs: 5000, trace: [] });
  ok('提交被拒（403）', subA.status === 403, `${subA.status} ${subA.body?.error || ''}`);
  ok('提交错误文案提到「截止」', /截止/.test(subA.body?.error || ''), subA.body?.error);

  console.log('\n【实例 B：未截止（对照）】');
  const hB = await get(8898, '/api/health');
  ok('health 报告未截止', hB.body?.competition?.ended === false, JSON.stringify(hB.body?.competition));
  const startB = await post(8898, '/api/run/start', { clientId: randomUUID(), mode: 'classic', protocol: 2, easterEggs: 1, requestId: randomUUID() });
  ok('开局放行（200）', startB.status === 200, `${startB.status} ${startB.body?.error || ''}`);
  const boardB = await get(8898, '/api/leaderboard?mode=classic&top=5');
  ok('未截止时排行榜 closed=false', boardB.body?.closed === false);
  ok('未截止时排行榜走实时查询（空库 → 0 行）', boardB.body?.rows?.length === 0, `rows=${boardB.body?.rows?.length}`);
} finally {
  A.kill(); B.kill();
  await new Promise(r => setTimeout(r, 400));
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (errs.length) {
  console.log('\n（子进程 stderr 摘录）');
  console.log(errs.join('').split('\n').slice(0, 6).join('\n'));
}
process.exit(failed.length ? 1 : 0);
