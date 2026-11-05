// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { CATALOG } from '../web/src/catalog';
import type { AssetStore } from '../web/src/assets';
import type { Game } from '../web/src/game';
import type { Renderer } from '../web/src/renderer';

let releaseAssets: () => void;
let fixture: AssetStore;
vi.mock('../web/src/assets', async importActual => ({
  ...await importActual(),
  createAssetStore: () => fixture,
  loadAssets: () => new Promise<AssetStore>(resolve => { releaseAssets = () => resolve(fixture); }),
}));
vi.mock('../web/src/audio', () => ({ isMuted: () => true, setMuted: () => {}, unlockAudio: () => {}, sfx: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../web/src/api', async importActual => ({ ...await importActual(), mockMode: true }));

it('opens the home page before image downloads finish, then uses a held mouse drag and release to drop exactly once', async () => {
  document.body.innerHTML = readFileSync('web/index.html', 'utf8'); localStorage.clear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.stubGlobal('requestAnimationFrame', vi.fn()); vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  const sprite = { source: document.createElement('canvas'), width: 512, height: 512, placeholder: false };
  fixture = { themes: { classic: Array(11).fill(sprite), endless: Array(11).fill(sprite) }, secrets: { classic: sprite, endless: sprite }, easterEggs: { [-1]: sprite, [-2]: sprite }, levels: Array(11).fill(sprite), background: null, logo: null, gameOver: null, halo: null, spark: null, realCount: 12, missing: [] };
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  let captured: number | null = null;
  canvas.setPointerCapture = id => { captured = id; }; canvas.hasPointerCapture = id => id === captured; canvas.releasePointerCapture = () => { captured = null; };
  await import('../web/src/main');
  expect(document.getElementById('app')!.dataset.screen).toBe('home');
  releaseAssets!(); await Promise.resolve();
  document.getElementById('btn-play')!.click(); document.querySelector<HTMLButtonElement>('[data-mode="classic"]')!.click();
  const app = (window as unknown as { __yuanhuo: { app: { game: Game; renderer: Renderer; loop(timestamp: number): void } } }).__yuanhuo.app;
  const game = app.game; const initial = game.heldX;
  const send = (target: EventTarget, type: string, x: number, button = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 42, isPrimary: true, button, clientX: x, clientY: 220, pointerType: 'mouse' }); target.dispatchEvent(event);
  };
  send(window, 'pointermove', 400); expect(game.heldX).toBe(initial);
  send(canvas, 'pointerdown', 420); send(window, 'pointermove', 550);
  const aimed = game.heldX; expect(aimed).not.toBe(initial); expect(game.trace).toHaveLength(0);
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); expect(game.heldX).toBe(aimed);
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); expect(game.trace).toHaveLength(0);
  send(window, 'pointerup', 550); expect(game.trace).toHaveLength(1);
  send(window, 'pointerup', 550); expect(game.trace).toHaveLength(1);
  expect(document.getElementById('discovery-title')!.textContent).toBe(CATALOG.classic[0].name);
  document.getElementById('btn-discovery-continue')!.click(); await Promise.resolve();
  game.update(401);
  send(canvas, 'pointerdown', 420); expect(captured).toBe(42); send(window, 'pointercancel', 550); expect(captured).toBeNull(); send(window, 'pointerup', 550); expect(game.trace).toHaveLength(1);
  send(canvas, 'pointerdown', 420, 2); send(window, 'pointerup', 550, 2); expect(game.trace).toHaveLength(1);
  const render = vi.spyOn(app.renderer, 'render'); const update = vi.spyOn(game, 'update');
  app.loop(performance.now()); expect(render).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLButtonElement>('#hud [data-guide]')!.click();
  const first = document.querySelector<HTMLButtonElement>(`[data-entry-id="${CATALOG.classic[0].id}"]`)!;
  expect(first.disabled).toBe(false);
  expect(document.querySelector<HTMLButtonElement>(`[data-entry-id="${CATALOG.classic[1].id}"]`)!.disabled).toBe(true);
  app.loop(performance.now()); expect(render).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
  document.getElementById('btn-guide-close')!.click();
  app.loop(performance.now()); expect(render).toHaveBeenCalledTimes(2);
  game.destroy();
});
