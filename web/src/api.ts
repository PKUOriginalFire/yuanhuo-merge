/**
 * 后端接口封装。
 *
 * ?mock=1 使用本地演示榜；在线接口错误由界面说明。
 */

import { BOARD, type GameMode } from './config';
import { store } from './storage';
import type { TraceEntry } from './game';

export interface BoardRow {
  rank: number;
  nickname: string;
  /** 昵称后 4 位，用于区分重名 */
  tag: string;
  score: number;
  maxLevel: number;
  /** 达成时间戳 */
  at: number;
}

export interface SubmitPayload {
  id?: string;
  key?: string;
  lease?: string;
  revision?: number;
  mode: GameMode;
  score: number;
  maxLevel: number;
  merges: number;
  loopCount: number;
  durationMs: number;
  trace: TraceEntry[];
}

export interface SubmitResult {
  ok: boolean;
  /** 上榜后的名次；没上榜为 null */
  rank: number | null;
  /** 是否刷新了个人最好成绩 */
  improved: boolean;
  /** 是否应该弹签名框 */
  promptSignature: boolean;
  /** 被判定为异常时给的原因（前端只做展示，不阻止玩家） */
  reason?: string;
}

const API = '/api';
const MOCK_KEY = 'yuanhuo-merge.mockboard';

const isMock = new URLSearchParams(location.search).get('mock') === '1';

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
    signal: controller.signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error || `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

// ────────────────────────────────────────── mock 实现

interface MockRow {
  nickname: string;
  score: number;
  maxLevel: number;
  at: number;
}

function mockAll(): Record<GameMode, MockRow[]> {
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { classic: [], endless: [] };
}

function mockSave(data: Record<GameMode, MockRow[]>) {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

function mockBoard(mode: GameMode, selfNick: string): BoardRow[] {
  void selfNick;
  const rows = mockAll()[mode].slice().sort((a, b) => b.score - a.score).slice(0, BOARD.topN);
  return rows.map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname,
    tag: 'demo',
    score: r.score,
    maxLevel: r.maxLevel,
    at: r.at,
  }));
}

// ────────────────────────────────────────── 对外接口

export async function fetchLeaderboard(mode: GameMode, selfNick = ''): Promise<BoardRow[]> {
  if (isMock) return mockBoard(mode, selfNick);
  const r = await req<{ rows: BoardRow[] }>(`/leaderboard?mode=${mode}&top=${BOARD.topN}`);
  return r.rows;
}

export async function submitRun(p: SubmitPayload): Promise<SubmitResult> {
  const payload = { ...p, clientId: store.get().clientId };

  if (isMock) {
    const all = mockAll();
    const nick = store.get().nickname || '匿名元火人';
    const best = Math.max(0, ...all[p.mode].filter(row => row.nickname === nick).map(row => row.score));
    const improved = p.score > best;
    if (improved) {
      all[p.mode] = all[p.mode].filter(row => row.nickname !== nick);
      all[p.mode].push({ nickname: nick, score: p.score, maxLevel: p.maxLevel, at: Date.now() });
      mockSave(all);
    }
    const board = mockBoard(p.mode, nick);
    const rank = board.findIndex((r) => r.nickname === nick && r.score === p.score) + 1;
    return {
      ok: true,
      rank: rank > 0 ? rank : null,
      improved,
      promptSignature: !store.get().nickname && rank > 0 && rank <= BOARD.promptRank,
    };
  }

  try {
    return await req<SubmitResult>('/run/submit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[api] 提交失败，本局成绩只记在本地：', (e as Error).message);
    const improved = p.score > store.best(p.mode);
    return { ok: false, rank: null, improved, promptSignature: false, reason: (e as Error).message };
  }
}

/** 签名提交后再拿一次名次（因为签名会影响榜单展示） */
export async function submitNickname(nick: string): Promise<void> {
  if (isMock) {
    const all = mockAll();
    const previous = store.get().nickname || '匿名元火人';
    for (const mode of ['classic', 'endless'] as const) for (const row of all[mode]) if (row.nickname === previous) row.nickname = nick;
    mockSave(all);
  } else {
    await req('/nickname', {
      method: 'POST',
      body: JSON.stringify({ clientId: store.get().clientId, nickname: nick }),
    });
  }
  store.setNickname(nick);
}

export const mockMode = isMock;
