// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); localStorage.clear(); });

it('clears old scores and continuations once while keeping nickname, identity, sound and discoveries', async () => {
  localStorage.setItem('yuanhuo-merge.v1', JSON.stringify({ clientId: 'existing-client', nickname: '原昵称', bestClassic: 5247, bestEndless: 8000, muted: true }));
  localStorage.setItem('yuanhuo-merge.continuation.v1', 'old-cloud-handle');
  localStorage.setItem('yuanhuo-merge.mockboard', 'old-local-results');
  localStorage.setItem('yuanhuo-merge.discoveries.v1', '["youth-secretary","welcome-gala"]');
  const { store } = await import('../web/src/storage');
  expect(store.get()).toMatchObject({ clientId: 'existing-client', nickname: '原昵称', bestClassic: 0, bestEndless: 0, muted: true, historyReset: '2026-10-17' });
  expect(localStorage.getItem('yuanhuo-merge.continuation.v1')).toBeNull();
  expect(localStorage.getItem('yuanhuo-merge.mockboard')).toBeNull();
  expect(localStorage.getItem('yuanhuo-merge.discoveries.v1')).toBe('["youth-secretary","welcome-gala"]');
});

it('preserves new scores and saved games after the reset has already been applied', async () => {
  let { store } = await import('../web/src/storage');
  const id = store.get().clientId;
  store.recordBest('classic', 120); store.recordBest('endless', 250);
  localStorage.setItem('yuanhuo-merge.continuation.v1', 'new-cloud-handle');
  vi.resetModules(); ({ store } = await import('../web/src/storage'));
  expect(store.get()).toMatchObject({ clientId: id, bestClassic: 120, bestEndless: 250 });
  expect(localStorage.getItem('yuanhuo-merge.continuation.v1')).toBe('new-cloud-handle');
});

it('still starts when browser storage is blocked', async () => {
  const blocked = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  const { store } = await import('../web/src/storage');
  expect(store.best('classic')).toBe(0); expect(store.get().clientId).toBeTruthy();
  blocked.mockRestore();
});
