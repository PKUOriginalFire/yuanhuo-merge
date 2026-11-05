// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { Game } from '../web/src/game';

const pending = vi.hoisted(() => ({
  connection: null as any, reply: null as any,
  finish: vi.fn(), begin: vi.fn(), clear: vi.fn(),
}));
vi.mock('../web/src/api', async load => ({ ...await load(), mockMode: false, submitRun: (...args: unknown[]) => pending.finish(...args) }));
vi.mock('../web/src/continuation', () => ({ RunConnection: class {
  current = { id: 'old-game' }; available = true;
  constructor() { pending.connection = this; }
  credentials() { return { id: this.current.id }; }
  start(mode: string) { return pending.begin(mode); }
  clear() { pending.clear(); }
  suspend() {}
  save() {}
  async flush() {}
} }));
vi.mock('../web/src/audio', () => ({ isMuted: () => true, setMuted: () => {}, unlockAudio: () => {}, sfx: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../web/src/assets', async load => ({ ...await load(), createAssetStore: () => {
  const sprite = { source: document.createElement('canvas'), width: 512, height: 512, placeholder: true };
  return { themes: { classic: Array(11).fill(sprite), endless: Array(11).fill(sprite) }, secrets: { classic: sprite, endless: sprite }, easterEggs: { [-1]: sprite, [-2]: sprite }, levels: Array(11).fill(sprite), background: null, logo: null, gameOver: null, halo: null, spark: null, realCount: 0, missing: [] };
}, loadAssets: () => new Promise(() => {}) }));

it('does not clear a new continuation when the previous result arrives during a new start', async () => {
  document.body.innerHTML = readFileSync('web/index.html', 'utf8'); localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', vi.fn()); vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  let finish: (value: any) => void = () => {};
  let begin: (value: any) => void = () => {};
  pending.finish.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  pending.begin.mockImplementation(() => new Promise(resolve => { begin = resolve; }));
  await import('../web/src/main');
  const app = (window as any).__yuanhuo.app;
  // Saving is deliberately unresolved: local input and physics must still progress immediately.
  const playing = new Game('classic'); playing.start(); app.installGame('classic', playing.snapshot()); playing.destroy();
  const local = app.game;
  app.drop(); expect(local.trace).toHaveLength(1); expect(app.networkBusy).toBe(false);
  document.getElementById('btn-discovery-continue')!.click(); for (let i = 0; i < 5; i++) await Promise.resolve();
  local.update(401); app.drop(); expect(local.trace).toHaveLength(2); expect(app.game).toBe(local);
  const game = new Game('classic'); game.start(); game.status = 'over';
  app.installGame('classic', game.snapshot()); game.destroy();
  const finishing = app.onGameOver(); for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(pending.finish).toHaveBeenCalledTimes(1);
  const starting = app.startOnline('endless');
  finish({ ok: true, rank: 1, improved: true, promptSignature: false }); await finishing;
  expect(pending.clear).not.toHaveBeenCalled();
  const next = new Game('endless'); next.start();
  pending.connection.current = { id: 'new-game' }; begin({ id: 'new-game', state: next.snapshot() });
  await starting; expect(app.game.mode).toBe('endless'); app.game.destroy(); next.destroy();
});
