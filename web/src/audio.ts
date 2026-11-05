/**
 * 合成音效使用 WebAudio；BGM 使用按需加载的原生流式音频。
 */

import { store } from './storage';
import { BackgroundMusic } from './bgm';
import musicOpus from './audio/bgm-musicbox.ogg?url';
import musicMp3 from './audio/bgm-musicbox.mp3?url';

const music = new BackgroundMusic([
  { url: musicOpus, type: 'audio/ogg; codecs=opus' },
  { url: musicMp3, type: 'audio/mpeg' },
], store.get().muted, !document.hidden);
document.addEventListener('visibilitychange', () => music.setVisible(!document.hidden));
window.addEventListener('pagehide', () => music.setVisible(false));
window.addEventListener('pageshow', () => music.setVisible(!document.hidden));

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unlocked = false;

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = store.get().muted ? 0 : 0.5;
    master.connect(ctx.destination);
  } catch {
    return null;
  }
  return ctx;
}

/**
 * iOS / 微信里 AudioContext 必须由用户手势解锁，否则全程静音。
 * 在第一次 pointerdown 时调这个。
 */
export function unlockAudio() {
  music.unlock();
  const c = ensure();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  if (!unlocked) {
    // 播一个 0 音量的极短音，把音频管线"顶"开
    const o = c.createOscillator();
    const g = c.createGain();
    g.gain.value = 0;
    o.connect(g).connect(master!);
    o.start();
    o.stop(c.currentTime + 0.01);
    unlocked = true;
  }
}

export function setMuted(muted: boolean) {
  store.setMuted(muted);
  music.setMuted(muted);
  if (master) master.gain.value = muted ? 0 : 0.5;
}

export function isMuted(): boolean {
  return store.get().muted;
}

interface ToneOpts {
  freq: number;
  /** 结束频率（做滑音） */
  toFreq?: number;
  dur?: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function tone({ freq, toFreq, dur = 0.12, type = 'sine', gain = 0.3, delay = 0 }: ToneOpts) {
  const c = ensure();
  if (!c || c.state !== 'running') return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (toFreq) o.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master!);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/** 五声音阶，等级越高音越高，合成连锁听起来会很舒服 */
const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

export const sfx = {
  /** 投放 */
  drop() {
    tone({ freq: 300, toFreq: 150, dur: 0.09, type: 'triangle', gain: 0.22 });
  },
  /** 合成：音高随等级上升 */
  merge(level: number) {
    const f = PENTATONIC[Math.min(PENTATONIC.length - 1, level - 1)];
    tone({ freq: f, dur: 0.13, type: 'sine', gain: 0.3 });
    tone({ freq: f * 2, dur: 0.1, type: 'sine', gain: 0.12, delay: 0.02 });
  },
  /** 经典模式：共鸣 */
  resonate() {
    [0, 0.06, 0.12, 0.2].forEach((d, i) => {
      tone({ freq: 523.25 * Math.pow(1.26, i), dur: 0.5, type: 'sine', gain: 0.22, delay: d });
    });
    tone({ freq: 130.81, dur: 0.9, type: 'triangle', gain: 0.14 });
  },
  /** 无尽模式：循环 */
  recycle(loop: number) {
    tone({ freq: 220, toFreq: 1760, dur: 0.42, type: 'sawtooth', gain: 0.16 });
    const base = 523.25 * Math.min(3, 1 + (loop - 1) * 0.12);
    [0, 0.08, 0.16].forEach((d, i) => {
      tone({ freq: base * Math.pow(1.2, i), dur: 0.3, type: 'sine', gain: 0.2, delay: d });
    });
  },
  /** 破纪录 */
  record() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone({ freq: f, dur: 0.28, type: 'triangle', gain: 0.24, delay: i * 0.09 });
    });
  },
  /** 失败 */
  gameOver() {
    [440, 370, 311, 233].forEach((f, i) => {
      tone({ freq: f, dur: 0.42, type: 'sawtooth', gain: 0.16, delay: i * 0.14 });
    });
  },
  /** UI 点击 */
  click() {
    tone({ freq: 660, toFreq: 880, dur: 0.06, type: 'square', gain: 0.12 });
  },
};
