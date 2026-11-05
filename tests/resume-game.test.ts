import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { Game } from '../web/src/game';

const step = (game: Game, n: number) => { for (let i = 0; i < n; i++) game.update(1000 / 60); };

describe('continuing the same physical game', () => {
  it('preserves moving balls, cooldown, score, trace and the future random sequence', () => {
    const game = new Game('endless', {}, 12345); game.start();
    for (let i = 0; i < 9; i++) { game.setAimX(200 + i % 3 * 250); game.drop(); step(game, 25); }
    game.drop(); step(game, 4);
    const state = game.snapshot(); const copy = Game.restore(state);
    expect(copy.snapshot()).toMatchObject({ score: state.score, trace: state.trace, heldLevel: state.heldLevel, nextLevel: state.nextLevel, secretCycle: state.secretCycle });
    expect(copy.canDrop).toBe(false);
    expect(copy.listBalls().map(b => [b.level, b.body.position, b.body.velocity, b.bornAt]))
      .toEqual(game.listBalls().map(b => [b.level, b.body.position, b.body.velocity, b.bornAt]));
    for (let i = 0; i < 5; i++) { step(game, 25); step(copy, 25); game.drop(); copy.drop(); expect(copy.nextLevel).toBe(game.nextLevel); }
    game.destroy(); copy.destroy();
  });

  it('does not reset an almost-expired overflow countdown on restoration', () => {
    const game = new Game('classic'); game.start(); game.drop();
    const ball = game.listBalls()[0]; Matter.Body.setStatic(ball.body, true);
    step(game, 160);
    expect(game.overflowProgress).toBeGreaterThan(0);
    const state = game.snapshot(); const copy = Game.restore(state);
    for (const b of copy.listBalls()) Matter.Body.setStatic(b.body, true);
    expect(copy.overflowProgress).toBeCloseTo(game.overflowProgress);
    step(game, 50); step(copy, 50);
    expect(copy.status).toBe('over'); expect(game.status).toBe('over');
    game.destroy(); copy.destroy();
  });

  it('keeps a consumed hidden tool consumed and its guaranteed award already claimed', () => {
    const game = new Game('classic'); game.start(); game.score = 3000; game.update(0);
    expect(game.secretCount).toBe(1); game.useSecret(500, 1400);
    const copy = Game.restore(game.snapshot()); copy.update(0);
    expect(copy.secretCount).toBe(0); expect(copy.snapshot().secretCycle).toBe(1);
    game.destroy(); copy.destroy();
  });
});
