import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Game } from '../web/src/game';
import { createRunSessions } from '../server/sessions.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  let time = 1_000_000;
  const sessions = createRunSessions(db, Game, () => time);
  const start = sessions.start('test-client-id', 'classic', 'start-request-1');
  const sync = (run: any, action: any = { kind: 'none' }, active = true, requestId = crypto.randomUUID()) => sessions.sync('test-client-id', { ...run, state: { score: 999999 }, action, active, requestId });
  return { db, sessions, start, sync, clock: (ms: number) => { time += ms; } };
}

describe('server-owned single continuation', () => {
  it('records a drop once even when its response is lost and the request is retried', () => {
    const f = fixture();
    const first = f.sync(f.start, { kind: 'drop', x: 500 }, true, 'drop-request-1');
    const retry = f.sync(f.start, { kind: 'drop', x: 500 }, true, 'drop-request-1');
    expect(retry.state.trace).toHaveLength(1); expect(retry.revision).toBe(first.revision);
    expect(retry.state.score).toBe(0);
    expect(() => f.sync(f.start, { kind: 'drop', x: 800 })).toThrow(/旧|版本/);
    expect(() => f.sync(f.start, { kind: 'drop', x: 800 }, true, 'drop-request-1')).toThrow(/操作/);
  });
  it('resumes the latest server state and invalidates the previous tab', () => {
    const f = fixture(); const dropped = f.sync(f.start, { kind: 'drop', x: 500 }); f.clock(600);
    const restored = f.sessions.resume('test-client-id', f.start.id, f.start.key, 'claim-page-2');
    expect(restored.state.trace).toHaveLength(1); expect(restored.state.elapsed).toBeGreaterThan(550);
    expect(restored.active).toBe(false);
    expect(() => f.sync(dropped)).toThrow(/其他页面/);
    expect(f.sessions.resume('test-client-id', f.start.id, f.start.key, 'claim-page-2').revision).toBe(restored.revision);
    expect(() => f.sessions.resume('other-client', f.start.id, f.start.key, 'claim-page-3')).toThrow();
  });
  it('cannot escape an impending loss by leaving and restoring', () => {
    const f = fixture(); const dropped = f.sync(f.start, { kind: 'drop', x: 500 });
    // Place an already-old ball above the line in the SERVER fixture, never in a client request.
    const state = dropped.state; state.now = state.elapsed = 3000; state.overLineSince = 1200;
    state.balls[0].bornAt = 0; state.balls[0].y = 460;
    f.db.prepare('UPDATE live_game SET state = ? WHERE id = ?').run(JSON.stringify(state), dropped.id);
    f.clock(400);
    const restored = f.sessions.resume('test-client-id', dropped.id, dropped.key, 'claim-after-loss');
    expect(restored.state.status).toBe('over');
    expect(() => f.sync(restored, { kind: 'drop', x: 600 })).toThrow(/结束/);
  });
  it('never refunds a spent tool or rerolls the next balls when resumed', () => {
    const f = fixture(); const state = f.start.state; state.secretCount = 1; state.secretCycle = 1;
    f.db.prepare('UPDATE live_game SET state = ? WHERE id = ?').run(JSON.stringify(state), f.start.id);
    const spent = f.sync(f.start, { kind: 'secret', x: 500, y: 1500 });
    const restored = f.sessions.resume('test-client-id', spent.id, spent.key, 'claim-after-tool');
    expect(restored.state.secretCount).toBe(0); expect(restored.state.secretCycle).toBe(1);
    expect(restored.state.nextLevel).toBe(spent.state.nextLevel);
  });
  it('commits a finished game once and ignores the claimed client score', () => {
    const f = fixture(); let writes = 0;
    expect(() => f.sessions.finish('test-client-id', f.start, () => { writes++; })).toThrow(/结束/);
    const state = f.start.state; state.status = 'over'; state.score = 12;
    f.db.prepare('UPDATE live_game SET state = ? WHERE id = ?').run(JSON.stringify(state), f.start.id);
    const commit = (trusted: any) => { writes++; return { ok: true, score: trusted.score }; };
    const first = f.sessions.finish('test-client-id', { ...f.start, score: 999999 }, commit);
    expect(first.score).toBe(12);
    expect(f.sessions.finish('test-client-id', f.start, commit)).toEqual(first); expect(writes).toBe(1);
  });
  it('does not revive an abandoned game when a new one has been started', () => {
    const f = fixture(); f.sessions.start('test-client-id', 'endless', 'start-request-2');
    expect(() => f.sessions.resume('test-client-id', f.start.id, f.start.key, 'old-claim')).toThrow(/放弃/);
  });
  it('rejects malformed credentials and never trusts a client timer or tool inventory', () => {
    const f = fixture();
    expect(() => f.sessions.resume('test-client-id', f.start.id, '你'.repeat(64), 'invalid-key')).toThrow(/浏览器/);
    const forged = f.sync({ ...f.start, elapsed: 999999, secretCount: 9 }, { kind: 'secret', x: 500, y: 1500 });
    expect(forged.state.secretCount).toBe(0); expect(forged.state.elapsed).toBe(0);
  });
});
