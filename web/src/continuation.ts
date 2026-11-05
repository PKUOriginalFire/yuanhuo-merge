import type { GameMode } from './config';
import type { GameSnapshot } from './game';
import { ApiError, req } from './api';
import { store } from './storage';

const KEY = 'yuanhuo-merge.continuation.v1';
interface Handle { id: string; key: string; lease?: string; state?: GameSnapshot; }
export interface RunReply extends Handle { lease: string; revision: number; protocol: number; active: boolean; state: GameSnapshot; }
interface Checkpoint { state: GameSnapshot; active: boolean; }

function savedHandle(): Handle | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw && typeof raw.id === 'string' && typeof raw.key === 'string' && raw.key.length === 64
      ? { id: raw.id, key: raw.key, lease: raw.lease, state: raw.state } : null;
  } catch { return null; }
}
async function post<T>(path: string, body: object, keepalive = false): Promise<T> {
  const init = { method: 'POST', body: JSON.stringify({ ...body, clientId: store.get().clientId }), keepalive };
  try { return await req<T>(path, init); }
  catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error;
    // Retry the exact same checkpoint/id, including when only the acknowledgement was lost.
    return req<T>(path, init);
  }
}

export class RunConnection {
  current: RunReply | null = null;
  onConflict: ((error: Error) => void) | null = null;
  private generation = 0;
  private pending: Checkpoint | null = null;
  private job: (Checkpoint & { id: string; key: string; lease: string; revision: number; requestId: string }) | null = null;
  private sending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private blocked = false;
  get available() { return !!savedHandle(); }
  credentials() {
    const run = this.current;
    if (!run) throw new Error('请先恢复对局');
    return { id: run.id, key: run.key, lease: run.lease, revision: run.revision };
  }
  private cache() {
    const run = this.current;
    if (!run) return;
    try { localStorage.setItem(KEY, JSON.stringify({ id: run.id, key: run.key, lease: run.lease, state: run.state })); } catch { /* Server saves remain usable when local storage is unavailable/full. */ }
  }
  private reset() {
    this.generation++; clearTimeout(this.timer); this.timer = undefined; this.pending = this.job = null; this.sending = null; this.blocked = false;
    return this.generation;
  }
  private remember(reply: RunReply) { this.current = reply; this.cache(); return reply; }
  async start(mode: GameMode) {
    const generation = this.reset();
    const reply = await post<RunReply>('/run/start', { mode, protocol: 2, easterEggs: 1, requestId: crypto.randomUUID() });
    if (generation !== this.generation) throw new Error('对局已切换');
    return this.remember(reply);
  }
  async restore() {
    const handle = savedHandle();
    if (!handle) throw new Error('没有可恢复的对局');
    const generation = this.reset();
    const reply = await post<RunReply>('/run/resume', { ...handle, protocol: 2, easterEggs: 1, claimId: crypto.randomUUID() });
    if (generation !== this.generation) throw new Error('对局已切换');
    return this.remember(reply);
  }
  /** Saving never blocks input or replaces the live Game. Coalesce while a request is outstanding. */
  save(state: GameSnapshot, active: boolean) {
    if (!this.current) return;
    this.current.state = state; this.current.active = active; this.pending = { state, active }; this.cache();
    if (!this.timer && !this.sending && !this.blocked) this.schedule(250);
  }
  private schedule(ms: number) {
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain().catch(() => {}); }, ms);
  }
  private drain(keepalive = false): Promise<void> {
    if (this.sending) return this.sending;
    if (this.blocked) return Promise.reject(new Error('存档需要重新恢复'));
    const generation = this.generation;
    const task = (async () => {
      while (this.pending || this.job) {
        if (!this.job) { this.job = { ...this.credentials(), ...this.pending!, requestId: crypto.randomUUID() }; this.pending = null; }
        const reply = await post<RunReply>('/run/checkpoint', this.job, keepalive);
        if (generation !== this.generation) throw new Error('对局已切换');
        // Only credentials advance. Never apply an old acknowledgement to the live Game or local cache.
        this.current!.revision = reply.revision; this.job = null;
      }
    })();
    this.sending = task;
    void task.catch(error => {
      if (generation !== this.generation) return;
      if (error instanceof ApiError && [400, 403, 409].includes(error.status)) { this.blocked = true; this.onConflict?.(error); }
      else if (!this.timer) this.schedule(3000);
    }).finally(() => { if (generation === this.generation) this.sending = null; });
    return task;
  }
  async flush(state: GameSnapshot, active: boolean) {
    this.save(state, active); clearTimeout(this.timer); this.timer = undefined;
    await this.drain();
  }
  suspend(state?: GameSnapshot) {
    if (!this.current) return;
    this.save(state || this.current.state, false);
    clearTimeout(this.timer); this.timer = undefined;
    // Keepalive has a 64 KiB budget; the cache also recovers unsent progress on return.
    if (!this.sending && JSON.stringify(this.pending).length < 48000) void this.drain(true).catch(() => {});
  }
  clear() {
    this.reset(); this.current = null;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }
}
