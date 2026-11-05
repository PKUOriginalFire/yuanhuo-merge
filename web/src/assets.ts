import { CONTAINER, WORLD, type GameMode } from './config';
import { CATALOG, EASTER_EGG_CATALOG, SECRET_CATALOG, type CatalogEntry } from './catalog';
import { isEasterEggLevel, type EasterEggLevel } from './easter-eggs';
import artCrops from './art-crops.json';
import { imageCrop, circleContainBox, type ImageFraming } from './image-crop';

export interface Sprite {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** 使用文字或场地占位时为 true。 */
  placeholder: boolean;
}

export interface AssetStore {
  themes: Record<GameMode, Sprite[]>;
  secrets: Record<GameMode, Sprite>;
  easterEggs: Record<EasterEggLevel, Sprite>;
  /** 兼容旧调用，下标 = level - 1，与 themes.classic 为同一数组。 */
  levels: Sprite[];
  background: Sprite | null;
  logo: Sprite | null;
  gameOver: Sprite | null;
  halo: Sprite | null;
  spark: Sprite | null;
  realCount: number;
  /** 已登记但未能加载的文件，仅供控制台诊断。 */
  missing: string[];
}

const BASE = import.meta.env.BASE_URL || '/';
const MANIFEST_TIMEOUT_MS = 5000;
const IMAGE_TIMEOUT_MS = 15000;
const artwork = artCrops as Record<string, ImageFraming>;
interface Manifest { files: ReadonlySet<string>; revision: string; versions: Record<string, string>; }
const asset = (name: string) => `${BASE}assets/${name}`.replace(/\/{2,}/g, '/');

/** 清单以 assets 下的相对路径登记正式素材；空清单不会请求图片。 */
async function loadManifest(): Promise<Manifest> {
  const empty = () => ({ files: new Set<string>(), revision: '', versions: {} });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(asset('manifest.json'), { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) return empty();
    const manifest: unknown = await response.json();
    let revision = '';
    const versions: Record<string, string> = {};
    if (manifest && !Array.isArray(manifest) && typeof manifest === 'object' && 'revision' in manifest) {
      const value = (manifest as { revision: unknown }).revision;
      if (typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value)) revision = value;
    }
    if (manifest && typeof manifest === 'object' && 'versions' in manifest && manifest.versions && typeof manifest.versions === 'object') {
      for (const [file, value] of Object.entries(manifest.versions)) {
        if (typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value)) versions[file] = value;
      }
    }
    const files = Array.isArray(manifest)
      ? manifest
      : manifest && typeof manifest === 'object' && 'files' in manifest
        ? (manifest as { files: unknown }).files
        : [];
    return { files: new Set(Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : []), revision, versions };
  } catch {
    return empty();
  } finally {
    clearTimeout(timeout);
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (result: HTMLImageElement | null) => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), IMAGE_TIMEOUT_MS);
    image.onload = () => finish(image.naturalWidth && image.naturalHeight ? image : null);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

async function loadSprite(name: string, manifest: Manifest, round: boolean): Promise<{ image: HTMLImageElement; framed: boolean } | null> {
  const base = name.replace(/\.(png|webp|jpe?g)$/i, '');
  const framed = `sprites/${base.split('/').at(-1)}.webp`;
  const files = [...(round ? [framed] : []), `${base}.webp`, `${base}.png`].filter((file) => manifest.files.has(file));
  for (const file of files) {
    const version = manifest.versions[file] || manifest.revision;
    const image = await loadImage(asset(file) + (version ? `?v=${version}` : ''));
    if (image) return { image, framed: file === framed };
  }
  return null;
}

function canvasSprite(width: number, height = width): { sprite: Sprite; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    sprite: { source: canvas, width, height, placeholder: true },
    ctx: canvas.getContext('2d')!,
  };
}

const PAPER_COLORS = [
  '#ead4b8', '#ecd3c2', '#e3d8c6', '#d6dfd0', '#e1d4e4', '#d6d9e7',
  '#ead3cf', '#e1dfbd', '#e4cebf', '#e3cba7', '#d8bf9c',
];

function circleBase(ctx: CanvasRenderingContext2D, size: number, color: string) {
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.485, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = size * 0.018;
  ctx.strokeStyle = '#80654b';
  ctx.stroke();
}

/** 名称排在圆内中央安全区，避免圆形裁切损失文字。 */
function centeredText(ctx: CanvasRenderingContext2D, lines: readonly string[], size: number, fontSize: number) {
  const font = (pixels: number) => `700 ${pixels}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.font = font(fontSize);
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
  if (widest > size * 0.68) fontSize *= size * 0.68 / widest;
  ctx.font = font(fontSize);
  ctx.fillStyle = '#513b2b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const gap = fontSize * 1.3;
  lines.forEach((line, index) => {
    ctx.fillText(line, size / 2, size / 2 + (index - (lines.length - 1) / 2) * gap);
  });
}

const POSTER_LINES: Record<string, readonly string[]> = {
  'autumn-welcome': ['秋季', '百团迎新'],
  'welcome-gala': ['迎新', '晚会'],
  lecture: ['高端', '讲座'],
  'band-live': ['乐队', '专场'],
  'vocaloid-meeting': ['V家', '例会'],
  'touhou-meeting': ['东方', '例会'],
  'cos-cafe': ['COS', '咖啡厅'],
  'spring-welcome': ['春季', '百团迎新'],
  'spring-gala': ['春季', '晚会'],
  anniversary: ['社庆'],
  'yuanhuo-logo': ['元火', '标志'],
  'night-run': ['医学部', '夜奔'],
};

function placeholderEntry(mode: GameMode, entry: CatalogEntry, index = 0, size = 256): Sprite {
  const { sprite, ctx } = canvasSprite(size);
  circleBase(ctx, size, PAPER_COLORS[index % PAPER_COLORS.length]);
  if (mode === 'classic') {
    // 尚未提供的海报使用圆形活动名称占位。
    centeredText(ctx, POSTER_LINES[entry.id] ?? [entry.label], size, size * 0.13);
  } else {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.41, 0, Math.PI * 2);
    ctx.lineWidth = size * 0.004;
    ctx.strokeStyle = 'rgba(81,59,43,0.3)';
    ctx.stroke();
    centeredText(ctx, [entry.label], size, size * 0.29);
  }
  return sprite;
}

/** 依据人工选择的人物区域铺满圆形；徽标保留完整轮廓。 */
function roundImage(image: HTMLImageElement, size = 512, framing?: ImageFraming): Sprite {
  const { sprite, ctx } = canvasSprite(size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#f5e7d4';
  ctx.fillRect(0, 0, size, size);
  if (framing?.fit === 'contain') {
    const box = circleContainBox(image.naturalWidth, image.naturalHeight, size);
    ctx.drawImage(image, box.x, box.y, box.width, box.height);
  } else {
    const crop = imageCrop(image.naturalWidth, image.naturalHeight, framing);
    ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, size, size);
  }
  ctx.restore();
  return { ...sprite, placeholder: false };
}

/** Static stage floor, painted once; boundaries still match the physics world. */
function placeholderBackground(): Sprite {
  const { sprite, ctx } = canvasSprite(WORLD.w, WORLD.h);
  ctx.fillStyle = '#25182f';
  ctx.fillRect(CONTAINER.left, CONTAINER.deathLineY, CONTAINER.right - CONTAINER.left, CONTAINER.floor - CONTAINER.deathLineY);
  ctx.strokeStyle = '#bca36e';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(CONTAINER.left, CONTAINER.deathLineY);
  ctx.lineTo(CONTAINER.left, CONTAINER.floor);
  ctx.lineTo(CONTAINER.right, CONTAINER.floor);
  ctx.lineTo(CONTAINER.right, CONTAINER.deathLineY);
  ctx.stroke();
  ctx.strokeStyle = '#6a5062';
  ctx.lineWidth = 2;
  ctx.strokeRect(CONTAINER.left - 15, CONTAINER.deathLineY - 15, CONTAINER.right - CONTAINER.left + 30, CONTAINER.floor - CONTAINER.deathLineY + 30);
  return sprite;
}

function placeholderHalo(size = 512): Sprite {
  const { sprite, ctx } = canvasSprite(size);
  const center = size / 2;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, 'rgba(255,252,240,0.95)');
  gradient.addColorStop(0.35, 'rgba(224,187,122,0.55)');
  gradient.addColorStop(1, 'rgba(186,142,86,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}

/** Ready immediately, while the same store is hydrated with artwork in the background. */
export function createAssetStore(): AssetStore {
  const theme = (mode: GameMode) => CATALOG[mode].map((entry, index) => placeholderEntry(mode, entry, index));
  const classic = theme('classic');
  return {
    themes: { classic, endless: theme('endless') }, levels: classic,
    secrets: { classic: placeholderEntry('classic', SECRET_CATALOG.classic), endless: placeholderEntry('endless', SECRET_CATALOG.endless) },
    easterEggs: { [-1]: placeholderEntry('endless', EASTER_EGG_CATALOG[-1], 4), [-2]: placeholderEntry('endless', EASTER_EGG_CATALOG[-2], 10) },
    background: placeholderBackground(), logo: null, gameOver: null, halo: placeholderHalo(), spark: placeholderHalo(128),
    realCount: 0, missing: [],
  };
}

export function spriteFor(assets: AssetStore, mode: GameMode, level: number): Sprite {
  return mode === 'endless' && isEasterEggLevel(level) ? assets.easterEggs[level] : assets.themes[mode][level - 1];
}

export async function loadAssets(onProgress?: (loaded: number, total: number) => void, assets = createAssetStore()): Promise<AssetStore> {
  const manifest = await loadManifest();
  const missing = assets.missing;
  let loaded = 0;
  const total = CATALOG.classic.length + CATALOG.endless.length + 2 + 5;
  const tick = () => onProgress?.(++loaded, total);

  const load = async (file: string, fallback: Sprite | null, round = false, framing?: ImageFraming): Promise<Sprite | null> => {
    const loaded = await loadSprite(file, manifest, round);
    let sprite: Sprite | null;
    if (loaded) {
      const { image, framed } = loaded;
      sprite = round && !framed ? roundImage(image, 512, framing) : {
        source: image, width: image.naturalWidth, height: image.naturalHeight, placeholder: false,
      };
      assets.realCount++;
    } else {
      sprite = fallback;
      const base = file.replace(/\.(png|webp)$/i, '');
      if ([`${base}.webp`, `${base}.png`, `sprites/${base.split('/').at(-1)}.webp`].some(name => manifest.files.has(name))) missing.push(file);
    }
    tick();
    return sprite;
  };

  const theme = (mode: GameMode) => Promise.all(CATALOG[mode].map(async (entry, index) => {
    assets.themes[mode][index] = (await load(entry.sprite, assets.themes[mode][index], true, artwork[entry.id]))!;
  }));
  const secret = async (mode: GameMode) => {
    assets.secrets[mode] = (await load(SECRET_CATALOG[mode].sprite, assets.secrets[mode], true, artwork[SECRET_CATALOG[mode].id]))!;
  };
  const extra = async (key: 'background' | 'logo' | 'gameOver' | 'halo' | 'spark', file: string) => {
    assets[key] = await load(file, assets[key]);
  };

  await Promise.all([
    theme('classic'), theme('endless'), secret('classic'), secret('endless'),
    extra('background', 'bg.png'), extra('logo', 'logo.png'), extra('gameOver', 'over.png'),
    extra('halo', 'halo.png'), extra('spark', 'spark.png'),
  ]);
  if (missing.length) console.info(`[assets] ${missing.length} 个已登记素材未能加载，使用占位。`);
  return assets;
}

/** 按目标直径居中绘制，可带旋转；保留原有调用接口。 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  x: number,
  y: number,
  targetDiameter: number,
  angle = 0,
) {
  const scale = targetDiameter / Math.max(sprite.width, sprite.height);
  const width = sprite.width * scale;
  const height = sprite.height * scale;
  if (angle === 0) {
    ctx.drawImage(sprite.source, x - width / 2, y - height / 2, width, height);
  } else {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(sprite.source, -width / 2, -height / 2, width, height);
    ctx.restore();
  }
}
