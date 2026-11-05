import { describe, expect, it, vi } from 'vitest';
import { createDiscoveries } from '../web/src/discovery';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('first discovery cache', () => {
  it('writes the cache only on a new discovery, so repeated merges do not block a frame', () => {
    const setItem = vi.fn();
    const found = createDiscoveries({ getItem: () => null, setItem });
    expect(found.mark('autumn-welcome')).toBe(true);
    expect(found.mark('autumn-welcome')).toBe(false);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
  it('persists stable content IDs across instances without sharing modes', () => {
    const storage = memory();
    const first = createDiscoveries(storage);
    expect(first.has('classic:autumn-fair')).toBe(false);
    first.mark('classic:autumn-fair');
    const restored = createDiscoveries(storage);
    expect(restored.has('classic:autumn-fair')).toBe(true);
    expect(restored.has('endless:animation')).toBe(false);
  });
  it('recovers malformed cache and remains usable when storage is blocked', () => {
    const first = createDiscoveries({ getItem: () => '{broken', setItem: () => { throw Error('blocked'); } });
    first.mark('classic:secret-night-run');
    expect(first.has('classic:secret-night-run')).toBe(true);
  });
  it('rejects a malformed array containing non-string values', () => {
    const first = createDiscoveries({ getItem: () => '[null,42,"endless:stage"]', setItem: () => {} });
    expect(first.has('endless:stage')).toBe(true);
  });
});
