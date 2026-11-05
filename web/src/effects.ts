import { LEVELS, WORLD } from './config';
import type { AssetStore } from './assets';

/**
 * 纯表现层特效：光环、粒子、飘字、震屏。
 *
 * 全部活在"世界坐标"里（1125×2000），所以缩放屏幕不影响观感。
 * 不参与任何游戏逻辑，出问题最多是好不好看，不会影响判定。
 *
 * ⚠️ 关于 grow 的单位（踩过的坑）：
 *    一开始把 grow 写成"每帧增量"，却按"总增量"的量级去赋值，
 *    结果一个合成光环膨胀了 80 倍半径，半屏糊成白色。
 *    现在统一用 **growTotal = 整个生命周期内的总尺寸变化**，
 *    内部再除以生命周期帧数，既不会写错也不受帧率影响。
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  /** 当前尺寸（世界像素） */
  size: number;
  /** 整个生命周期内尺寸的总变化量，正=变大，负=变小 */
  growTotal: number;
  rot: number;
  /** 每帧旋转增量（弧度） */
  vr: number;
  kind: 'halo' | 'spark';
  color: string;
  gravity: number;
  /** 绘制不透明度上限，防止叠加过曝 */
  alpha: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

const FRAME = 1000 / 60;
/** 特效再多也不至于糊屏 */
const MAX_PARTICLES = 320;

export class Effects {
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  /** 当前帧的震屏偏移量（世界像素） */
  shakeAmount = 0;
  private shakeDecay = 0.86;

  private add(p: Particle) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  addText(x: number, y: number, text: string, color = '#fff6c9', size = 52) {
    if (this.texts.length > 40) this.texts.shift();
    // 连锁合成时一堆飘字会叠成一坨看不清，这里往上错开
    let ty = y;
    for (let guard = 0; guard < 8; guard++) {
      const clash = this.texts.some(
        (t) => Math.abs(t.x - x) < size * 1.9 && Math.abs(t.y - ty) < size * 1.05,
      );
      if (!clash) break;
      ty -= size * 1.15;
    }
    this.texts.push({ x, y: ty, text, life: 1100, maxLife: 1100, color, size });
  }

  shake(power: number) {
    this.shakeAmount = Math.max(this.shakeAmount, power);
    this.shakeDecay = 0.9 - Math.min(0.12, power / 400);
  }

  /** 普通合成：一圈扩散光环 + 几颗星星 */
  spawnMerge(level: number, x: number, y: number) {
    const color = LEVELS[level - 1].color;
    const radius = LEVELS[level - 1].diameter / 2;

    // 光环：从 0.7R 扩散到 3R 后淡出。alpha 压到 0.55，
    // 否则连锁合成时多个光环用 lighter 叠加会把画面糊白。
    this.add({
      x, y, vx: 0, vy: 0,
      life: 420, maxLife: 420,
      size: radius * 0.7, growTotal: radius * 2.3,
      rot: 0, vr: 0, kind: 'halo', color, gravity: 0, alpha: 0.55,
    });

    const n = Math.min(3 + level, 10);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const sp = 2.4 + Math.random() * 3.4;
      const size = 12 + Math.random() * 16;
      this.add({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.5,
        life: 620 + Math.random() * 320, maxLife: 940,
        size, growTotal: -size * 0.85,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.28,
        kind: 'spark', color, gravity: 0.16, alpha: 1,
      });
    }

    this.shake(Math.min(12, 3 + level * 0.8));
    this.addText(x, y - radius * 0.4, `+${level}`, '#fff6c9', 42 + level * 2);
  }

  /** 经典模式：两个完全体「共鸣」——球不动，但这下要有排面 */
  spawnResonate(x: number, y: number) {
    const color = LEVELS[LEVELS.length - 1].color;

    for (let ring = 0; ring < 3; ring++) {
      const life = 560 + ring * 170;
      this.add({
        x, y, vx: 0, vy: 0,
        life, maxLife: life,
        size: 80 + ring * 50, growTotal: 360 + ring * 120,
        rot: 0, vr: 0, kind: 'halo', color, gravity: 0,
        alpha: 0.5 - ring * 0.1,
      });
    }

    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 7;
      const size = 14 + Math.random() * 22;
      this.add({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.4,
        life: 900 + Math.random() * 500, maxLife: 1400,
        size, growTotal: -size * 0.9,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
        kind: 'spark', color, gravity: 0.2, alpha: 1,
      });
    }

    this.shake(22);
    this.addText(x, y - 96, '元火娘 · 共鸣！', '#ffd86b', 70);
  }

  /** 无尽模式：完全体循环回最小球 */
  spawnRecycle(x: number, y: number, loop: number, gained: number) {
    this.add({
      x, y, vx: 0, vy: 0,
      life: 700, maxLife: 700,
      size: 60, growTotal: 300,
      rot: 0, vr: 0, kind: 'halo', color: '#ff8a65', gravity: 0, alpha: 0.55,
    });

    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      const size = 12 + Math.random() * 18;
      this.add({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 800 + Math.random() * 400, maxLife: 1200,
        size, growTotal: -size * 0.9,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
        kind: 'spark', color: '#ffcc80', gravity: 0.24, alpha: 1,
      });
    }

    this.shake(18);
    this.addText(x, y - 76, `第 ${loop} 次循环`, '#8ef2c4', 62);
    this.addText(x, y - 16, `+${gained}`, '#fff6c9', 54);
  }

  update(dtMs: number) {
    const k = dtMs / FRAME;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dtMs;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vy += p.gravity * k;
      p.vx *= 1 - 0.012 * k;

      // growTotal 是"整个生命周期的总变化量"，换算成每帧增量
      const frames = p.maxLife / FRAME;
      p.size = Math.max(1, p.size + (p.growTotal / frames) * k);

      p.rot += p.vr * k;

      // 掉出世界就回收
      if (p.y > WORLD.h + 300 || p.x < -400 || p.x > WORLD.w + 400) {
        this.particles.splice(i, 1);
      }
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dtMs;
      t.y -= 0.9 * k;
      if (t.life <= 0) this.texts.splice(i, 1);
    }

    if (this.shakeAmount > 0) {
      this.shakeAmount *= Math.pow(this.shakeDecay, k);
      if (this.shakeAmount < 0.4) this.shakeAmount = 0;
    }
  }

  render(ctx: CanvasRenderingContext2D, assets: AssetStore) {
    const halo = assets.halo;
    const spark = assets.spark;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      // 先快后慢的淡出，看起来更像能量扩散
      const fade = Math.pow(t, 1.6);
      ctx.globalAlpha = Math.max(0, Math.min(1, fade * p.alpha));
      const img = p.kind === 'halo' ? halo : spark;
      if (!img) continue;
      if (p.rot) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(img.source, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.drawImage(img.source, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.restore();

    // 飘字（普通叠加，不用 lighter，否则字会糊）
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of this.texts) {
      const p = t.life / t.maxLife;
      // 出现时有一个小小的放大弹跳
      const pop = p > 0.82 ? 1 + (1 - (1 - p) / 0.18) * 0.25 : 1;
      ctx.globalAlpha = Math.min(1, p * 2.2);
      ctx.font = `900 ${t.size * pop}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(40,10,0,0.72)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.restore();
  }

  clear() {
    this.particles.length = 0;
    this.texts.length = 0;
    this.shakeAmount = 0;
  }
}
