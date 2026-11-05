import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

// Build the existing native circular rendering at game resolution. Keep full posters intact.
const project = resolve(import.meta.dirname, '..');
const root = resolve(project, 'web/public/assets');
const entries = JSON.parse(await readFile(resolve(project, 'tools/artwork.json'), 'utf8'));
const crops = JSON.parse(await readFile(resolve(project, 'web/src/art-crops.json'), 'utf8'));
const size = 512;
const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="256" cy="256" r="256" fill="white"/></svg>`);
const report = [];
await mkdir(resolve(root, 'sprites'), { recursive: true });
for (const [id, entry] of Object.entries(entries)) {
  const input = resolve(root, entry.destination);
  const meta = await sharp(input).metadata();
  const crop = crops[id]; let pipeline;
  if (crop?.fit === 'contain') {
    const scale = size * .96 / Math.hypot(meta.width, meta.height);
    const width = Math.round(meta.width * scale), height = Math.round(meta.height * scale);
    const logo = await sharp(input).resize(width, height).png().toBuffer();
    pipeline = sharp({ create: { width: size, height: size, channels: 4, background: '#f5e7d4' } })
      .composite([{ input: logo, left: Math.round((size - width) / 2), top: Math.round((size - height) / 2) }, { input: mask, blend: 'dest-in' }]);
  } else {
    const left = Math.round((crop?.x ?? 0) * meta.width), top = Math.round((crop?.y ?? 0) * meta.height);
    const side = Math.min(meta.width - left, meta.height - top, Math.round((crop?.width ?? 1) * meta.width), Math.round((crop?.height ?? 1) * meta.height));
    pipeline = sharp(input).extract({ left, top, width: side, height: side }).resize(size, size)
      .flatten({ background: '#f5e7d4' }).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]);
  }
  const file = `sprites/${id}.webp`;
  const data = await pipeline.webp({ quality: 84, alphaQuality: 100, effort: 6 }).toBuffer();
  await writeFile(resolve(root, file), data);
  const original = await readFile(input);
  report.push({ id, file, bytes: data.length, previousBytes: original.length, pixels: size * size, previousPixels: meta.width * meta.height });
}
const result = { files: report, bytes: report.reduce((n, f) => n + f.bytes, 0), previousBytes: report.reduce((n, f) => n + f.previousBytes, 0), decodedPixels: report.reduce((n, f) => n + f.pixels, 0), previousDecodedPixels: report.reduce((n, f) => n + f.previousPixels, 0) };
await writeFile(resolve(project, 'docs/sprite-performance-20261014.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
