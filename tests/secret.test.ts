import { describe, expect, it } from 'vitest';
import { SecretSchedule } from '../web/src/secret';

describe('secret score windows', () => {
  it('does not roll before the first window', () => {
    const schedule = new SecretSchedule('classic', () => 0);
    expect(schedule.poll(999, true)).toBe(0);
    expect(schedule.poll(1000, true)).toBe(1);
  });
  it('guarantees one classic tool at the deadline, without a new drop', () => {
    const schedule = new SecretSchedule('classic', () => 1);
    expect(schedule.poll(1000, true)).toBe(0);
    expect(schedule.poll(2999, true)).toBe(0);
    expect(schedule.poll(3000)).toBe(1);
    expect(schedule.poll(9000, true)).toBe(0);
  });
  it('does not award the same classic window twice after a rare roll', () => {
    const schedule = new SecretSchedule('classic', () => 0.004);
    expect(schedule.poll(1500, true)).toBe(1);
    expect(schedule.poll(3000)).toBe(0);
  });
  it('opens endless windows at 1000 then 4000 and guarantees at 3000 then 6000', () => {
    const schedule = new SecretSchedule('endless', () => 1);
    expect(schedule.poll(3000)).toBe(1);
    expect(schedule.poll(3999, true)).toBe(0);
    expect(schedule.poll(4000, true)).toBe(0);
    expect(schedule.poll(6000)).toBe(1);
    expect(schedule.poll(6000)).toBe(0);
  });
  it('preserves guarantees when one score change crosses several deadlines', () => {
    const schedule = new SecretSchedule('endless', () => 1);
    expect(schedule.poll(9500)).toBe(3);
    expect(schedule.poll(9500)).toBe(0);
    expect(schedule.poll(10000, true)).toBe(0);
  });
});
