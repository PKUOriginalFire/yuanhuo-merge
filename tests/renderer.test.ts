// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { Renderer } from '../web/src/renderer';
import { Effects } from '../web/src/effects';
import type { Game } from '../web/src/game';
import type { AssetStore } from '../web/src/assets';

it('renders frames without layout reads after HUD writes', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  Object.defineProperties(canvas, { clientWidth: { configurable: true, get: () => 1200 }, clientHeight: { configurable: true, get: () => 800 } });
  const renderer = new Renderer(canvas);
  Object.defineProperties(canvas, { clientWidth: { get: () => { throw Error('Forced layout'); } }, clientHeight: { get: () => { throw Error('Forced layout'); } } });
  expect(() => renderer.render({ mode: 'classic', status: 'ready', listBalls: () => [], overflowProgress: 0 } as unknown as Game, { background: null } as AssetStore, new Effects())).not.toThrow();
});
