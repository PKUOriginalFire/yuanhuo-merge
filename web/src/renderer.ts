import { CONTAINER, DROP, FLAGS, WORLD, type GameMode } from './config';
import type { AssetStore } from './assets';
import { drawSprite, spriteFor } from './assets';
import { ballDiameter } from './easter-eggs';
import type { Game } from './game';
import type { Effects } from './effects';
import { SECRET_RULES } from './secret';

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private width = 0;
  private height = 0;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d')!; this.resize();
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.width = width; this.height = height;
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    this.scale = Math.min(width / WORLD.w, height / WORLD.h);
    this.offsetX = (width - WORLD.w * this.scale) / 2; this.offsetY = (height - WORLD.h * this.scale) / 2;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = document.documentElement.style;
    style.setProperty('--world-left', `${this.offsetX}px`); style.setProperty('--world-top', `${this.offsetY}px`);
    style.setProperty('--world-width', `${WORLD.w * this.scale}px`); style.setProperty('--world-height', `${WORLD.h * this.scale}px`);
  }
  toWorld(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.offsetX) / this.scale, y: (clientY - rect.top - this.offsetY) / this.scale };
  }
  render(game: Game, assets: AssetStore, fx: Effects) {
    const ctx = this.ctx; const mode = game.mode ?? 'classic';
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    const shake = this.reducedMotion.matches ? 0 : fx.shakeAmount;
    ctx.translate(this.offsetX + (Math.random() * 2 - 1) * shake * this.scale, this.offsetY + (Math.random() * 2 - 1) * shake * this.scale); ctx.scale(this.scale, this.scale);
    if (assets.background) ctx.drawImage(assets.background.source, 0, 0, WORLD.w, WORLD.h);
    this.drawDeathLine(game);
    for (const ball of game.listBalls()) drawSprite(ctx, spriteFor(assets, mode, ball.level), ball.body.position.x, ball.body.position.y, ballDiameter(ball.level), ball.body.angle);
    if (game.status === 'playing') {
      ctx.save(); ctx.globalAlpha = game.canDrop ? 0.45 : 0.2; ctx.strokeStyle = '#e4cf92'; ctx.lineWidth = 3; ctx.setLineDash([14, 16]);
      ctx.beginPath(); ctx.moveTo(game.heldX, CONTAINER.deathLineY); ctx.lineTo(game.heldX, CONTAINER.floor); ctx.stroke(); ctx.restore();
      ctx.save(); ctx.globalAlpha = game.canDrop ? 1 : 0.45;
      drawSprite(ctx, spriteFor(assets, mode, game.heldLevel), game.heldX, DROP.y, ballDiameter(game.heldLevel)); ctx.restore();
    }
    fx.render(ctx, assets);
    if (game.secretAim) {
      const { x, y } = game.secretAim;
      ctx.save(); ctx.beginPath(); ctx.rect(CONTAINER.left, DROP.y, CONTAINER.right - CONTAINER.left, CONTAINER.floor - DROP.y); ctx.clip();
      ctx.fillStyle = '#dfc78433'; ctx.strokeStyle = '#f1dda1'; ctx.lineWidth = 5; ctx.setLineDash([14, 12]);
      ctx.beginPath(); ctx.arc(x, y, SECRET_RULES.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); drawSprite(ctx, assets.secrets[mode], x, y, 100); ctx.restore();
    }
    if (FLAGS.debug) {
      ctx.strokeStyle = '#188b86'; ctx.lineWidth = 3; ctx.strokeRect(CONTAINER.left, CONTAINER.deathLineY, CONTAINER.right - CONTAINER.left, CONTAINER.floor - CONTAINER.deathLineY);
      for (const ball of game.listBalls()) { ctx.beginPath(); ctx.arc(ball.body.position.x, ball.body.position.y, ballDiameter(ball.level) / 2, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.restore();
  }
  private drawDeathLine(game: Game) {
    const ctx = this.ctx; ctx.save(); ctx.strokeStyle = game.overflowProgress ? '#ff8caa' : '#bfa477'; ctx.lineWidth = 4; ctx.setLineDash([16, 18]);
    ctx.beginPath(); ctx.moveTo(CONTAINER.left, CONTAINER.deathLineY); ctx.lineTo(CONTAINER.right, CONTAINER.deathLineY); ctx.stroke();
    if (game.overflowProgress) { ctx.setLineDash([]); ctx.fillStyle = '#ffb0c5'; ctx.font = '28px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'right'; ctx.fillText(`越线 ${((1 - game.overflowProgress) * 2).toFixed(1)} 秒`, CONTAINER.right - 10, CONTAINER.deathLineY - 22); }
    ctx.restore();
  }
  static drawPreview(canvas: HTMLCanvasElement, assets: AssetStore, level: number, size = 96, mode: GameMode = 'classic') {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = size * dpr; canvas.height = size * dpr;
    const ctx = canvas.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size, size);
    drawSprite(ctx, spriteFor(assets, mode, level), size / 2, size / 2, size * 0.9);
  }
}
