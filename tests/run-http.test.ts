import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Game } from '../web/src/game';

const directory = mkdtempSync(join(tmpdir(), 'yuanhuo-session-test-'));
const database = join(directory, 'test.db');
let child: ChildProcess;
let base: string;
beforeAll(async () => {
  child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', DB_PATH: database, ADMIN_TOKEN: '', HOST: '127.0.0.1', SERVE_STATIC: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 8000);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}`)); });
    child.stdout!.on('data', data => { const match = String(data).match(/http:\/\/127.0.0.1:(\d+)/); if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timer); done(); } });
  });
});
afterAll(async () => {
  if (child?.exitCode === null) { const ended = new Promise<void>(done => child.once('exit', () => done())); child.kill(); await ended; }
  const root = resolve(directory);
  if (root.startsWith(resolve(tmpdir()) + '\\yuanhuo-session-test-') || root.startsWith(resolve(tmpdir()) + '/yuanhuo-session-test-')) rmSync(root, { recursive: true, force: true });
});

const clientId = `http-test-${crypto.randomUUID()}`;
async function post(path: string, payload: object) {
  const result = await fetch(base + '/api/run/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, clientId }) });
  return { status: result.status, data: await result.json() };
}

it('round-trips both endless egg identities over the real HTTP API, with opt-in and preview preservation', async () => {
  for (const seed of [1972, 4553]) {
    const begin = await post('start', { mode: 'endless', protocol: 2, easterEggs: 1, requestId: crypto.randomUUID() });
    expect(begin.status).toBe(200); expect(begin.data.state.easterEggs).toBe(true);
    // Force a known random seed only inside this isolated test database, never through a public route.
    const seeded = new Game('endless', {}, seed); seeded.start();
    const db = new DatabaseSync(database);
    db.prepare('UPDATE live_game SET state=? WHERE id=?').run(JSON.stringify(seeded.snapshot()), begin.data.id); db.close();
    const claim = await post('resume', { id: begin.data.id, key: begin.data.key, protocol: 2, easterEggs: 1, claimId: crypto.randomUUID() });
    const game = Game.restore(claim.data.state); expect(game.heldLevel).toBe(seed === 1972 ? -1 : -2); game.drop();
    const saved = await post('checkpoint', { ...claim.data, state: game.snapshot(), active: true, requestId: crypto.randomUUID() });
    expect(saved.status).toBe(200);
    const restored = await post('resume', { ...saved.data, protocol: 2, easterEggs: 1, claimId: crypto.randomUUID() });
    expect(restored.status).toBe(200); expect(restored.data.state).toEqual(saved.data.state);
    expect(restored.data.state.balls[0].level).toBe(seed === 1972 ? -1 : -2);
    game.destroy(); seeded.destroy();
  }
});

it('authorizes the real HTTP continuation and commits its SERVER score exactly once', async () => {
  const begin = await post('start', { mode: 'classic', requestId: crypto.randomUUID() }); expect(begin.status).toBe(200);
  const first = begin.data;
  const action = { ...first, requestId: crypto.randomUUID(), action: { kind: 'drop', x: 500 }, active: true, score: 999999 };
  const dropped = await post('sync', action); expect(dropped.status).toBe(200); expect(dropped.data.state.trace).toHaveLength(1);
  const repeated = await post('sync', action); expect(repeated.data.revision).toBe(dropped.data.revision);
  const stale = await post('sync', { ...action, requestId: crypto.randomUUID(), action: { kind: 'drop', x: 900 } }); expect(stale.status).toBe(409);
  const claim = await post('resume', { id: first.id, key: first.key, claimId: crypto.randomUUID() }); expect(claim.status).toBe(200);
  expect((await post('sync', { ...dropped.data, requestId: crypto.randomUUID(), action: { kind: 'none' }, active: true })).status).toBe(409);
  expect((await post('resume', { id: first.id, key: '你'.repeat(64), claimId: crypto.randomUUID() })).status).toBe(403);
  expect((await post('submit', { ...claim.data, score: 999999 })).status).toBe(409);

  const db = new DatabaseSync(database);
  const state = claim.data.state; state.status = 'over'; state.elapsed = 3000;
  db.prepare('UPDATE live_game SET state=? WHERE id=?').run(JSON.stringify(state), first.id);
  const finished = await post('submit', { ...claim.data, mode: 'endless', score: 999999, merges: 999999 });
  expect(finished.status).toBe(200); expect(finished.data.ok).toBe(true);
  expect((await post('submit', { ...claim.data, score: 888888 })).data).toEqual(finished.data);
  const rows = db.prepare('SELECT mode,score FROM run').all();
  expect(rows).toEqual([{ mode: 'classic', score: 0 }]); db.close();
});

it('flags a fabricated snapshot instead of killing it with a 400, and keeps it off the board', async () => {
  const begin = await post('start', { mode: 'classic', protocol: 2, requestId: crypto.randomUUID() });
  const db = new DatabaseSync(database);
  // 本地把物理跑了几秒，服务端的 started_at 还停在刚刚 —— 把会话起点往前挪，让时间预算跟上。
  db.prepare('UPDATE live_game SET started_at=? WHERE id=?').run(Date.now() - 20000, begin.data.id);
  const game = Game.restore(begin.data.state);
  for (let i = 0; i < 8; i++) { for (let k = 0; k < 26; k++) game.update(1000 / 60); game.setAimX(300 + i * 60); game.drop(); }
  const real = game.snapshot();
  // 渗透测试的构造：balls 清空、merges 拉满、分数按 10×merges 给（数据自洽，但物理是假的）
  const fake = { ...real, balls: [], merges: real.spawnCount, score: 10 * real.spawnCount, maxLevelReached: 11, status: 'over' as const };
  const saved = await post('checkpoint', { ...begin.data, state: fake, active: false, requestId: crypto.randomUUID() });
  expect(saved.status).toBe(200);
  const submitted = await post('submit', saved.data);
  expect(submitted.status).toBe(200);
  expect(submitted.data.ok).toBe(false);
  expect(submitted.data.reason).toMatch(/复核/);
  const row = db.prepare('SELECT score, suspicious, flag_reason FROM run ORDER BY id DESC LIMIT 1').get() as any;
  expect(row.suspicious).toBe(1);
  expect(row.flag_reason).toMatch(/守恒|理论上界/);
  const board = await fetch(`${base}/api/leaderboard?mode=classic&top=5`).then(r => r.json());
  expect(board.rows.every((r: any) => r.score !== row.score)).toBe(true);
  db.close(); game.destroy();
});

it('does not flag an abandoned empty run as fraud', async () => {
  const begin = await post('start', { mode: 'classic', protocol: 2, requestId: crypto.randomUUID() });
  const db = new DatabaseSync(database);
  const state = begin.data.state; state.status = 'over';
  db.prepare('UPDATE live_game SET state=? WHERE id=?').run(JSON.stringify(state), begin.data.id);
  const submitted = await post('submit', { ...begin.data, state });
  expect(submitted.data.ok).toBe(true);
  const row = db.prepare('SELECT score, suspicious FROM run ORDER BY id DESC LIMIT 1').get() as any;
  expect(row).toEqual({ score: 0, suspicious: 0 });
  db.close();
});

it('saves protocol 2 via HTTP and submits the checkpoint once, including after restoring a completed game', async () => {
  const begin = await post('start', { mode: 'classic', protocol: 2, requestId: crypto.randomUUID() });
  expect(begin.status).toBe(200); expect(begin.data.protocol).toBe(2);
  const game = Game.restore(begin.data.state); game.drop();
  const saved = await post('checkpoint', { ...begin.data, state: game.snapshot(), active: true, requestId: crypto.randomUUID() });
  expect(saved.status).toBe(200); expect(saved.data.state.trace).toHaveLength(1);
  const db = new DatabaseSync(database);
  const before = (db.prepare('SELECT COUNT(*) n FROM run').get() as any).n;
  const state = saved.data.state;
  state.status = 'over'; state.now = state.elapsed = state.engineTime = 3000;
  db.prepare('UPDATE live_game SET state=? WHERE id=?').run(JSON.stringify(state), begin.data.id);
  const resumed = await post('resume', { id: begin.data.id, key: begin.data.key, protocol: 2, claimId: crypto.randomUUID() });
  const restored = Game.restore(resumed.data.state);
  const final = await post('checkpoint', { ...resumed.data, state: restored.snapshot(), active: false, requestId: crypto.randomUUID() });
  expect(final.status).toBe(200);
  const result = await post('submit', { ...final.data, score: 999999 }); expect(result.data.ok).toBe(true);
  expect((await post('submit', final.data)).data).toEqual(result.data);
  expect(db.prepare('SELECT score FROM run').all()).toHaveLength(before + 1);
  db.close(); game.destroy(); restored.destroy();
});
