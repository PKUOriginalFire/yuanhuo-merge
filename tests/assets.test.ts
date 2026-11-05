// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { loadAssets } from '../web/src/assets';

it('loads the small framed sprite, without downloading a full poster or invalidating it for unrelated changes', async () => {
  const urls: string[] = [];
  const drawing = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: (_target, key) => key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : key === 'measureText' ? () => ({ width: 10 }) : drawing }) as CanvasRenderingContext2D);
  const framed = 'sprites/autumn-welcome.webp';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ files: [framed, 'activities/autumn-welcome.webp'], revision: '1234567890abcdef', versions: { [framed]: 'abcdef1234567890' } }) })));
  vi.stubGlobal('Image', class {
    naturalWidth = 512; naturalHeight = 512; onload: (() => void) | null = null; onerror = null;
    set src(url: string) { urls.push(url); queueMicrotask(() => this.onload?.()); }
  });
  const assets = await loadAssets();
  expect(urls).toEqual(['/assets/sprites/autumn-welcome.webp?v=abcdef1234567890']);
  expect(assets.themes.classic[0].placeholder).toBe(false);
  expect(assets.realCount).toBe(1); expect(assets.missing).toEqual([]);
});
