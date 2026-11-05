import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import sharp from 'sharp';

it('keeps all shipped circular sprites opaque inside and transparent outside, within the download budget', async () => {
  const report = JSON.parse(readFileSync('docs/sprite-performance-20261014.json', 'utf8'));
  expect(report.bytes).toBeLessThan(report.previousBytes * .25);
  for (const entry of report.files) {
    const { data, info } = await sharp(`web/public/assets/${entry.file}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(512); expect(info.height).toBe(512);
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alpha(0, 0)).toBe(0); expect(alpha(511, 0)).toBe(0); expect(alpha(0, 511)).toBe(0); expect(alpha(511, 511)).toBe(0);
    expect(alpha(256, 256)).toBe(255);
  }
});
