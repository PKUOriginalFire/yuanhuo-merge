// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

it('integrates lazy BGM with persisted mute and page visibility even when WebAudio is unavailable', async () => {
  localStorage.clear();
  localStorage.setItem('yuanhuo-merge.v1', JSON.stringify({ clientId: 'audio-test', muted: true }));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  const players: any[] = [];
  vi.stubGlobal('Audio', class {
    preload = ''; loop = false; volume = 1; muted = false; src = ''; paused = true; error = null;
    canPlayType() { return 'probably'; }
    play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
    pause = vi.fn(() => { this.paused = true; });
    constructor() { players.push(this); }
  });
  vi.stubGlobal('AudioContext', undefined);
  const audio = await import('../web/src/audio');
  expect(players).toHaveLength(0); expect(audio.isMuted()).toBe(true);
  audio.unlockAudio(); expect(players).toHaveLength(0);
  audio.setMuted(false); expect(players).toHaveLength(1);
  expect(players[0].src).toContain('bgm-musicbox.ogg'); expect(players[0].paused).toBe(false);
  audio.setMuted(true); expect(players[0].paused).toBe(true);
  audio.setMuted(false); expect(players[0].paused).toBe(false);
  window.dispatchEvent(new Event('pagehide')); expect(players[0].paused).toBe(true);
  window.dispatchEvent(new Event('pageshow')); expect(players[0].paused).toBe(false);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange')); expect(players[0].paused).toBe(true);
  expect(() => audio.sfx.drop()).not.toThrow();
  vi.unstubAllGlobals();
});
