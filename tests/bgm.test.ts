// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackgroundMusic } from '../web/src/bgm';

const sources = [{ url: '/music.ogg', type: 'audio/ogg; codecs=opus' }, { url: '/music.mp3', type: 'audio/mpeg' }];
let supportsOpus = true;
let players: FakeAudio[];
class FakeAudio {
  loop = false; preload = ''; volume = 1; muted = false; src = ''; paused = true; currentTime = 0;
  error: unknown = null;
  onerror: (() => void) | null = null;
  canPlayType = vi.fn((type: string) => type.includes('opus') && !supportsOpus ? '' : 'probably');
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn(() => { this.error = null; });
  constructor() { players.push(this); }
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => { players = []; supportsOpus = true; vi.stubGlobal('Audio', FakeAudio); });
afterEach(() => { vi.unstubAllGlobals(); });

it('does not create or download audio before a real gesture, and streams one looping player', async () => {
  const music = new BackgroundMusic(sources);
  music.setVisible(true); music.setMuted(false);
  expect(players).toHaveLength(0);
  music.unlock(); music.unlock(); await settle(); music.unlock();
  expect(players).toHaveLength(1);
  expect(players[0]).toMatchObject({ loop: true, preload: 'none', src: '/music.ogg' });
  expect(players[0].volume).toBeLessThan(0.5);
  expect(players[0].play).toHaveBeenCalledTimes(1);
});

it('keeps muted visits download-free and resumes at the same position when sound is enabled', async () => {
  const music = new BackgroundMusic(sources, true);
  music.unlock(); expect(players).toHaveLength(0);
  music.setMuted(false); await settle();
  players[0].currentTime = 42;
  music.setMuted(true);
  expect(players[0].paused).toBe(true); expect(players[0].muted).toBe(true);
  music.setMuted(false); await settle();
  expect(players).toHaveLength(1); expect(players[0].currentTime).toBe(42);
  expect(players[0].play).toHaveBeenCalledTimes(2);
});

it('pauses when hidden and resumes only if previously unlocked and unmuted', async () => {
  const music = new BackgroundMusic(sources, false, false);
  music.unlock(); expect(players).toHaveLength(0);
  music.setVisible(true); await settle(); players[0].currentTime = 19;
  music.setVisible(false); expect(players[0].paused).toBe(true);
  music.setVisible(true); await settle();
  expect(players[0].currentTime).toBe(19); expect(players[0].paused).toBe(false);
  music.setMuted(true); music.setVisible(false); music.setVisible(true);
  expect(players[0].paused).toBe(true);
});

it('selects MP3 directly when Opus is unsupported', () => {
  supportsOpus = false; const music = new BackgroundMusic(sources); music.unlock();
  expect(players[0].src).toBe('/music.mp3'); expect(players).toHaveLength(1);
});

it('falls back once after an Opus error instead of stopping the game or retrying forever', async () => {
  const music = new BackgroundMusic(sources); music.unlock(); await settle();
  players[0].onerror!(); await settle();
  expect(players[0].src).toBe('/music.mp3'); expect(players[0].play).toHaveBeenCalledTimes(2);
  players[0].onerror!(); await settle();
  expect(players[0].play).toHaveBeenCalledTimes(2); expect(players[0].paused).toBe(true);
});

it('contains autoplay rejection and permits a later user gesture to retry', async () => {
  const music = new BackgroundMusic(sources, true); music.unlock();
  music.setMuted(false); await settle(); music.setMuted(true);
  players[0].play.mockRejectedValueOnce(new DOMException('gesture required', 'NotAllowedError'));
  music.setMuted(false); await settle();
  expect(() => music.unlock()).not.toThrow(); await settle();
  expect(players[0].play).toHaveBeenCalledTimes(3);
});

it('cannot start late in the background when a pending play resolves after hiding', async () => {
  const music = new BackgroundMusic(sources, true); music.unlock(); music.setMuted(false); await settle(); music.setMuted(true);
  let release: () => void = () => {};
  players[0].play.mockImplementationOnce(() => new Promise<void>(done => { release = () => { players[0].paused = false; done(); }; }));
  music.setMuted(false); music.setVisible(false); release(); await settle();
  expect(players[0].paused).toBe(true);
});

it('never blocks game input when native audio is unavailable', () => {
  vi.stubGlobal('Audio', class { constructor() { throw new Error('audio unavailable'); } });
  const music = new BackgroundMusic(sources);
  expect(() => { music.unlock(); music.setMuted(true); music.setVisible(false); }).not.toThrow();
});
