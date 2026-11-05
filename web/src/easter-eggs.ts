import { LEVELS } from './config.js';

/** Reserved identities outside the ordinary merge chain. */
export const EASTER_EGGS = [
  { level: -1, name: '团支书', probability: '1/2000', chance: 1 / 2000 },
  { level: -2, name: '理事长', probability: '1/5000', chance: 1 / 5000 },
] as const;
export type EasterEggLevel = typeof EASTER_EGGS[number]['level'];

export function isEasterEggLevel(level: unknown): level is EasterEggLevel {
  return level === -1 || level === -2;
}

/** Disjoint intervals keep both advertised probabilities exact per generated slot. */
export function rollEasterEgg(random: number): EasterEggLevel | null {
  let threshold = 0;
  for (const egg of EASTER_EGGS) {
    threshold += egg.chance;
    if (random < threshold) return egg.level;
  }
  return null;
}

export function ballDiameter(level: number): number {
  return LEVELS[isEasterEggLevel(level) ? 4 : level - 1].diameter;
}
