/**
 * 本地存储：匿名身份 + 昵称 + 个人最好成绩。
 * 不做登录 —— 用 localStorage 里的一个 uuid 当身份，够社团内部游戏用了。
 */

const KEY = 'yuanhuo-merge.v1';
// One-time play-history reset requested by the owner. Keep identity and discoveries.
const PLAY_HISTORY_RESET = '2026-10-17';

export interface LocalState {
  /** 匿名身份，随请求一起提交，服务端用它区分玩家 */
  clientId: string;
  /** 上次用的签名，下次自动填进输入框 */
  nickname: string;
  bestClassic: number;
  bestEndless: number;
  muted: boolean;
  historyReset: string;
}

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const DEFAULTS: LocalState = {
  clientId: '',
  nickname: '',
  bestClassic: 0,
  bestEndless: 0,
  muted: false,
  historyReset: '',
};

function read(): LocalState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = read();

if (state.historyReset !== PLAY_HISTORY_RESET) {
  state.bestClassic = state.bestEndless = 0;
  state.historyReset = PLAY_HISTORY_RESET;
  try {
    localStorage.removeItem('yuanhuo-merge.continuation.v1');
    localStorage.removeItem('yuanhuo-merge.mockboard');
  } catch { /* Unavailable browser storage must not block play. */ }
  persist();
}

if (!state.clientId) {
  state.clientId = uuid();
  persist();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

export const store = {
  get(): LocalState {
    return state;
  },
  setNickname(nick: string) {
    state.nickname = nick;
    persist();
  },
  setMuted(m: boolean) {
    state.muted = m;
    persist();
  },
  /** 刷新最高分，返回是否破纪录 */
  recordBest(mode: 'classic' | 'endless', score: number): boolean {
    const k = mode === 'classic' ? 'bestClassic' : 'bestEndless';
    if (score > state[k]) {
      state[k] = score;
      persist();
      return true;
    }
    return false;
  },
  best(mode: 'classic' | 'endless'): number {
    return mode === 'classic' ? state.bestClassic : state.bestEndless;
  },
};
