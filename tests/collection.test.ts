// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UI } from '../web/src/ui/ui';
import { createDiscoveries } from '../web/src/discovery';
import { CATALOG, EASTER_EGG_CATALOG, SECRET_CATALOG } from '../web/src/catalog';
import { createAssetStore } from '../web/src/assets';

const draw = vi.fn();
beforeEach(() => {
  document.body.innerHTML = readFileSync('web/index.html', 'utf8');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => draw }) as CanvasRenderingContext2D);
});
describe('collection discovery locks', () => {
  it('shows eggs only in the endless catalogue, locked until discovered, with their exact introduction', () => {
    const found = createDiscoveries(); const ui = new UI(found);
    const drawing = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 180 }) : key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : draw });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawing as CanvasRenderingContext2D);
    ui.applyLogo(createAssetStore()); ui.showGuide('classic');
    expect(document.getElementById('guide-eggs')!.classList.contains('hidden')).toBe(true);
    ui.showGuide('endless');
    expect(document.querySelectorAll('#egg-collection button')).toHaveLength(2);
    for (const level of [-1, -2] as const) {
      const entry = EASTER_EGG_CATALOG[level];
      expect(document.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"]`)!.disabled).toBe(true);
      found.mark(entry.id); ui.showGuide('endless');
      document.querySelector<HTMLButtonElement>(`[data-entry-id="${entry.id}"]`)!.click();
      expect(document.getElementById('discovery-title')!.textContent).toBe(entry.name);
      expect(document.getElementById('discovery-description')!.textContent).toBe(entry.description);
      expect(entry.description).toContain(level === -1 ? '1/2000' : '1/5000');
      ui.closeDiscovery();
    }
  });
  it('hides artwork, names and description access until a real ball has appeared', () => {
    const found = createDiscoveries(); const ui = new UI(found);
    ui.showGuide('classic');
    const locked = document.querySelector<HTMLButtonElement>(`[data-entry-id="${CATALOG.classic[0].id}"]`)!;
    expect(locked.disabled).toBe(true);
    expect(locked.textContent).toContain('未解锁');
    expect(locked.textContent).not.toContain(CATALOG.classic[0].name);
    locked.click(); expect(ui.discoveryOpen).toBe(false);
    expect(document.querySelector<HTMLButtonElement>(`[data-entry-id="${SECRET_CATALOG.classic.id}"]`)!.disabled).toBe(true);
  });
  it('restores discovered entries, while the other mode and hidden entries stay locked', () => {
    const cache = new Map<string, string>();
    const storage = { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => { cache.set(key, value); } };
    createDiscoveries(storage).mark(CATALOG.classic[1].id);
    const ui = new UI(createDiscoveries(storage)); ui.showGuide('classic');
    const unlocked = document.querySelector<HTMLButtonElement>(`[data-entry-id="${CATALOG.classic[1].id}"]`)!;
    expect(unlocked.disabled).toBe(false); expect(unlocked.textContent).toContain(CATALOG.classic[1].name);
    ui.showGuide('endless'); expect([...document.querySelectorAll<HTMLButtonElement>('.collection-item')].every(button => button.disabled)).toBe(true);
  });
});
