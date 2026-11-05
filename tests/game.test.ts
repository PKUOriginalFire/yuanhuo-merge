import { describe, expect, it } from 'vitest';
import { Game } from '../web/src/game';
import { validateRun } from '../server/validate.js';

describe('real game sequence and secret clearing', () => {
  it('resets an old overflow timer when clearing leaves only newborn balls above the line', () => {
    const game = new Game('classic'); game.start(); game.setAimX(200); game.drop();
    game.update(800); game.update(1000);
    const old = game.listBalls()[0];
    game.setAimX(900); game.drop(); game.secretCount = 1;
    expect(game.useSecret(old.body.position.x, old.body.position.y)).toBe(1);
    expect(game.overflowProgress).toBe(0);
    game.update(800); game.update(1900);
    expect(game.status).toBe('playing');
    game.update(101); expect(game.status).toBe('over'); game.destroy();
  });
  for (const mode of ['classic', 'endless'] as const) it(`keeps real ${mode} gameplay with clearing acceptable to the backend`, () => {
    const game = new Game(mode); game.start();
    for (let i = 0; i < 16 && game.status === 'playing'; i++) {
      game.setAimX(160 + (i % 4) * 220); game.drop();
      for (let frame = 0; frame < 27; frame++) game.update(1000 / 60);
      if (i === 10) { game.secretCount = 1; game.useSecret(500, 1700); }
    }
    const verdict = validateRun({ mode, score: game.score, maxLevel: game.maxLevelReached, merges: game.merges, loopCount: game.loopCount, durationMs: game.durationMs, trace: game.trace });
    expect(verdict.flags).toEqual([]); expect(verdict.ok).toBe(true); game.destroy();
  });
  it('produces the exact five tutorial drops accepted by the backend', () => {
    const game = new Game('classic');
    game.start();
    for (let i = 0; i < 5; i++) { game.drop(); game.update(401); }
    expect(game.trace.map(t => t.lv)).toEqual([1, 1, 2, 2, 3]);
    game.destroy();
  });
  it('discovers actual balls, without marking the preview', () => {
    const discovered: number[] = [];
    const game = new Game('endless', { onDiscover: level => discovered.push(level) }, 12345);
    expect(discovered).toEqual([]);
    game.start(); game.drop();
    expect(discovered).toEqual([1]);
    game.destroy();
  });
  it('clears intersecting balls without changing score, merges or normal trace', () => {
    const game = new Game('endless');
    game.start(); game.drop();
    const ball = game.listBalls()[0];
    game.score = 3000; game.update(0);
    expect(game.secretCount).toBe(1);
    const before = [game.score, game.merges, game.loopCount, game.trace.length];
    expect(game.useSecret(ball.body.position.x, ball.body.position.y)).toBe(1);
    expect(game.listBalls()).toHaveLength(0);
    expect([game.score, game.merges, game.loopCount, game.trace.length]).toEqual(before);
    expect(game.secretCount).toBe(0);
    game.destroy();
  });
  it('does not spend a tool when released outside the board', () => {
    const game = new Game('classic'); game.start(); game.score = 3000; game.update(0);
    expect(game.useSecret(-100, 1200)).toBeNull();
    expect(game.secretCount).toBe(1);
    expect(game.useSecret(500, 1400)).toBe(0);
    expect(game.secretCount).toBe(0);
    game.destroy();
  });
  it('does not use tools after game over', () => {
    const game = new Game('classic'); game.start(); game.score = 3000; game.update(0); game.status = 'over';
    expect(game.useSecret(500, 1400)).toBeNull();
    expect(game.secretCount).toBe(1); game.destroy();
  });
});
