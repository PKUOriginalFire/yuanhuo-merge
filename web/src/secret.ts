import type { GameMode } from './config';

export const SECRET_RULES = { start: 1000, end: 3000, period: 3000, chance: 0.005, radius: 180 } as const;

/** One award per score window. Deadlines are checked on score changes as well as drops. */
export class SecretSchedule {
  private cycle = 0;
  constructor(private readonly mode: GameMode, private readonly random = Math.random) {}

  checkpoint(): number { return this.cycle; }
  restore(cycle: number) { this.cycle = cycle; }

  poll(score: number, roll = false): number {
    let awarded = 0;
    if (!Number.isFinite(score) || score < 0) return 0;
    while (this.mode === 'endless' || this.cycle === 0) {
      const offset = this.cycle * SECRET_RULES.period;
      if (score >= offset + SECRET_RULES.end) {
        awarded++; this.cycle++;
        continue;
      }
      if (roll && score >= offset + SECRET_RULES.start && this.random() < SECRET_RULES.chance) {
        awarded++; this.cycle++;
      }
      break;
    }
    return awarded;
  }
}
