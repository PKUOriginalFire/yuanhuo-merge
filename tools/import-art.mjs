import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Keep the supplied artwork intact. Only resize/encode web copies; cropping happens in Canvas.
const project = resolve(import.meta.dirname, '..');
const source = process.argv[2] ?? join(homedir(), 'Desktop', '元火美术资源');
const entries = JSON.parse(await readFile(join(import.meta.dirname, 'artwork.json'), 'utf8'));
const crops = {};
const report = [];
sharp.concurrency(2);
for (const [id, settings] of Object.entries(entries)) {
  const original = join(settings.sourceDirectory === 'qq-cache' ? join(tmpdir(), 'dsh-qq') : source, settings.source);
  const metadata = await sharp(original, { limitInputPixels: 400_000_000 }).metadata();
  const target = join(project, 'web/public/assets', settings.destination);
  await mkdir(dirname(target), { recursive: true });
  await sharp(original, { limitInputPixels: 400_000_000, sequentialRead: true })
    .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88, effort: 5 })
    .toFile(target);
  const crop = settings.crop;
  if (crop) {
    const [x, y, width, height] = crop;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > metadata.width || y + height > metadata.height) throw Error(`Invalid crop: ${id}`);
    crops[id] = { x: x / metadata.width, y: y / metadata.height, width: width / metadata.width, height: height / metadata.height };
  }
  if (settings.fit) crops[id] = { ...crops[id], fit: settings.fit };
  const buffer = await readFile(target);
  report.push({ id, source: settings.source, original: [metadata.width, metadata.height], destination: settings.destination, bytes: buffer.length, sourceSha256: createHash('sha256').update(await readFile(original)).digest('hex'), crop: crops[id], note: settings.note });
  console.log(JSON.stringify({ id, bytes: buffer.length, original: [metadata.width, metadata.height] }));
}
await writeFile(join(project, 'web/src/art-crops.json'), JSON.stringify(crops, null, 2) + '\n');
await mkdir(join(project, 'docs'), { recursive: true });
await writeFile(join(project, 'docs/art-import-20261014.json'), JSON.stringify(report, null, 2) + '\n');
