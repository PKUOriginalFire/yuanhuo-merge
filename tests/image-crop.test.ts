import { describe, expect, it } from 'vitest';
import { imageCrop, circleContainBox } from '../web/src/image-crop';

describe('original artwork framing', () => {
  it('uses the selected face region instead of the centre of a tall poster', () => {
    expect(imageCrop(2000, 2828, { x: 600 / 2000, y: 450 / 2828, width: 900 / 2000, height: 900 / 2828 }))
      .toEqual({ x: 600, y: 450, width: 900, height: 900 });
  });
  it('keeps pixel proportions square for landscape and portrait images', () => {
    for (const [width, height] of [[1280, 853], [5079, 6732]]) {
      const crop = imageCrop(width, height);
      expect(crop.width).toBe(crop.height);
      expect(crop.x).toBeGreaterThanOrEqual(0); expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(height);
    }
  });
  it('clamps a selected region to the source without introducing blank padding', () => {
    const crop = imageCrop(1000, 600, { x: -0.1, y: 0.2, width: 1.5, height: 1.5 });
    expect(crop.width).toBe(crop.height);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y + crop.height).toBeLessThanOrEqual(600);
  });
  it('keeps all four emblem corners inside the circular badge', () => {
    const box = circleContainBox(1928, 1676, 512);
    for (const x of [box.x, box.x + box.width]) for (const y of [box.y, box.y + box.height]) {
      expect(Math.hypot(x - 256, y - 256)).toBeLessThanOrEqual(256);
    }
  });
});
