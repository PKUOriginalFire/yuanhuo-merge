import { describe, expect, it } from 'vitest';
import { Game } from '../web/src/game';
import { LEVELS } from '../web/src/config';
import { validateRun } from '../server/validate.js';
import { ballDiameter, EASTER_EGGS, rollEasterEgg } from '../web/src/easter-eggs';

describe('endless easter eggs', () => {
  it('allocates separate intervals with exactly five and two wins per 10000 uniformly spaced draws', () => {
    const draws = Array.from({ length: 10000 }, (_, i) => rollEasterEgg((i + 0.5) / 10000));
    expect(draws.filter(lv => lv === -1)).toHaveLength(5);
    expect(draws.filter(lv => lv === -2)).toHaveLength(2);
    expect(rollEasterEgg(0)).toBe(-1);
    expect(rollEasterEgg(1 / 2000)).toBe(-2);
    expect(rollEasterEgg(1 / 2000 + 1 / 5000)).toBeNull();
    for (const egg of EASTER_EGGS) expect(ballDiameter(egg.level)).toBe(LEVELS[4].diameter);
  });

  it('does not treat eggs as score-producing units, tutorial ordinary balls, or merge opportunities', () => {
    const payload = { mode: 'endless', score: 0, maxLevel: 1, merges: 0, loopCount: 0, durationMs: 3000,
      trace: [-1, -2, 2, 2, -1].map((lv, i) => ({ lv, x: 0.5, t: i * 400 })) };
    expect(validateRun(payload)).toMatchObject({ ok: true, units: 4 });
    expect(validateRun({ ...payload, score: 100 }).ok).toBe(false);
    expect(validateRun({ ...payload, merges: 2 }).ok).toBe(false);
    expect(validateRun({ ...payload, mode: 'classic' }).ok).toBe(false);
    expect(validateRun({ ...payload, trace: [{ t: 0, x: 0.5, lv: -3 }] }).ok).toBe(false);
  });
  for (const [seed, level] of [[1972, -1], [4553, -2]]) {
    it(`replaces the ordinary held ball with egg ${level}, and discovers only on placement`, () => {
      const discovered: number[] = [];
      const game = new Game('endless', { onDiscover: lv => discovered.push(lv) }, seed);
      expect(game.heldLevel).toBe(level);
      expect(discovered).toEqual([]);
      game.start(); expect(game.drop()).toBe(true);
      const ball = game.listBalls()[0];
      expect(ball.level).toBe(level);
      expect(ball.body.circleRadius).toBe(LEVELS[4].diameter / 2);
      expect(discovered).toEqual([level]);
      expect(game.trace[0].lv).toBe(level);
      expect(game.maxLevelReached).toBe(1);
      expect(validateRun({ mode: 'endless', score: 0, maxLevel: 1, merges: 0, loopCount: 0, durationMs: 2000, trace: game.trace }).ok).toBe(true);
      const saved = game.snapshot();
      const restored = Game.restore(saved);
      expect(restored.snapshot()).toMatchObject({ heldLevel: saved.heldLevel, nextLevel: saved.nextLevel, randomState: saved.randomState, easterEggs: true });
      expect(restored.listBalls().map(b => b.level)).toEqual([level]);
      game.destroy(); restored.destroy();
    });
    it(`does not introduce egg ${level} into classic mode`, () => {
      const game = new Game('classic', {}, seed);
      expect(game.heldLevel).toBe(1); expect(game.nextLevel).toBe(1);
      expect(game.snapshot()).not.toHaveProperty('easterEggs'); game.destroy();
    });
  }

  it('keeps both types, including matching pairs, after collisions and stage clearing', () => {
    const game = new Game('endless', {}, 12345);
    const add = (level: number, x: number) => (game as any).addBall(level, x, 1400);
    add(-1, 300); add(-1, 380); add(-2, 500); add(-2, 580); add(5, 650);
    game.start(); game.update(17);
    expect(game.listBalls().map(b => b.level)).toEqual([-1, -1, -2, -2, 5]);
    expect(game.merges).toBe(0); expect(game.score).toBe(0);
    game.secretCount = 1; expect(game.useSecret(500, 1400)).toBe(1);
    expect(game.listBalls().map(b => b.level)).toEqual([-1, -1, -2, -2]);
    expect(game.merges).toBe(0); expect(game.score).toBe(0); game.destroy();
  });

  it('counts eggs above the death line as occupied space', () => {
    const game = new Game('endless', {}, 1972); game.start(); game.drop();
    game.update(801); game.update(2001);
    expect(game.status).toBe('over'); game.destroy();
  });

  it('preserves legacy generation when restoring a snapshot without opt-in', () => {
    const game = new Game('endless', {}, 1972);
    const state = game.snapshot(); delete state.easterEggs;
    state.heldLevel = state.nextLevel = 1;
    const restored = Game.restore(state);
    expect(restored.snapshot()).not.toHaveProperty('easterEggs');
    expect(restored.heldLevel).toBe(1); expect(restored.nextLevel).toBe(1);
    game.destroy(); restored.destroy();
  });
});
