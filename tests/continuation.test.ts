// @vitest-environment jsdom
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { RunConnection } from '../web/src/continuation';
import { Game } from '../web/src/game';
import { createRunSessions } from '../server/sessions.js';

const connections: RunConnection[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => { connections.splice(0).forEach(c => c.clear()); dbs.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); localStorage.clear(); });
function fixture(delay?: (body: any) => Promise<void>) {
  const db = new DatabaseSync(':memory:'); dbs.push(db); const backend = createRunSessions(db, Game);
  const ids: string[] = []; let lose = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); let result;
    if (url.endsWith('/start')) result = backend.start(body.clientId, body.mode, body.requestId, body.protocol, body.easterEggs === 1);
    else if (url.endsWith('/resume')) result = backend.resume(body.clientId, body.id, body.key, body.claimId, body);
    else {
      result = backend.checkpoint(body.clientId, body); ids.push(body.requestId);
      if (lose) { lose = false; throw new TypeError('Lost acknowledgement'); }
      if (delay) await delay(body);
    }
    return new Response(JSON.stringify(result), { status: 200 });
  }));
  const connection = new RunConnection(); connections.push(connection);
  return { connection, ids, lose: () => { lose = true; } };
}
it('retries the same checkpoint and restores the cached unsent tail without rerolling', async () => {
  const f = fixture(); const run = await f.connection.start('classic'); const game = Game.restore(run.state); game.drop();
  f.lose(); await f.connection.flush(game.snapshot(), true); expect(f.ids[0]).toBe(f.ids[1]);
  for (let i = 0; i < 30; i++) game.update(1000 / 60); game.drop();
  const latest = game.snapshot(); f.connection.save(latest, true);
  const reload = new RunConnection(); connections.push(reload); const restored = await reload.restore();
  expect(restored.state).toEqual(latest); expect(restored.active).toBe(false); game.destroy();
});
it('opts into rare endless balls at start and resume without changing already generated previews', async () => {
  const f = fixture(); const run = await f.connection.start('endless');
  expect(run.state.easterEggs).toBe(true);
  const restored = await f.connection.restore();
  expect(restored.state).toEqual(run.state);
  const requests = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
  expect(requests.map(body => body.easterEggs)).toEqual([1, 1]);
});
it('coalesces saves during latency and never overwrites the newer local state with old responses', async () => {
  let release: () => void = () => {}; let calls = 0;
  const f = fixture(async () => { if (++calls === 1) await new Promise<void>(resolve => { release = resolve; }); });
  const run = await f.connection.start('classic'); const game = Game.restore(run.state); game.drop();
  const pending = f.connection.flush(game.snapshot(), true);
  for (let i = 0; i < 30; i++) game.update(1000 / 60); expect(game.drop()).toBe(true);
  const latest = game.snapshot(); f.connection.save(latest, true); release(); await pending;
  expect(calls).toBe(2); expect(f.connection.current!.state).toEqual(latest);
  expect(JSON.parse(localStorage.getItem('yuanhuo-merge.continuation.v1')!).state).toEqual(latest); game.destroy();
});
it('ignores a late save response after a newer restore has rotated the lease', async () => {
  let release: () => void = () => {};
  const f = fixture(async () => { await new Promise<void>(resolve => { release = resolve; }); });
  const run = await f.connection.start('classic'); const game = Game.restore(run.state); game.drop();
  const pending = f.connection.flush(game.snapshot(), true);
  await Promise.resolve(); const recovered = await f.connection.restore(); release();
  await expect(pending).rejects.toThrow(/切换/);
  expect(f.connection.credentials().lease).toBe(recovered.lease); game.destroy();
});
