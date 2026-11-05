import { BOARD, MODES, type GameMode } from '../config';
import { CATALOG, EASTER_EGG_CATALOG, SECRET_CATALOG, entryFor, type CatalogEntry } from '../catalog';
import { EASTER_EGGS } from '../easter-eggs';
import type { BoardRow } from '../api';
import { Renderer } from '../renderer';
import { drawSprite, type AssetStore, type Sprite } from '../assets';
import { discoveries } from '../discovery';
import { cleanNickname, validateNickname } from '../nick';

export type ScreenName = 'loading' | 'home' | 'mode' | 'game' | 'result' | 'board';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[ui] 找不到元素 #${id}`);
  return el as T;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface ResultData {
  mode: GameMode;
  score: number;
  maxLevel: number;
  merges: number;
  loopCount: number;
  durationMs: number;
  rank: number | null;
  isRecord: boolean;
}

interface ModalFrame { element: HTMLElement; returnFocus: HTMLElement | null; }

/** 页面、图鉴和介绍弹窗；首次发现与收藏持久化由 App 管理。 */
export class UI {
  onGuideClosed?: () => void;
  private readonly app = $('app');
  private readonly screens: Record<ScreenName, HTMLElement>;
  private current: ScreenName = 'loading';
  private mode: GameMode = 'classic';
  private guideMode: GameMode = 'classic';
  private assets: AssetStore | null = null;
  private readonly nextCanvas = $<HTMLCanvasElement>('hud-next-canvas');
  private readonly secretCanvas = $<HTMLCanvasElement>('secret-canvas');
  private readonly discoveryCanvas = $<HTMLCanvasElement>('discovery-preview');
  private readonly modalGuide = $('modal-guide');
  private readonly modalDiscovery = $('modal-discovery');
  private readonly modalStack: ModalFrame[] = [];
  private nickResolve: ((v: string | null) => void) | null = null;
  private discoveryResolve: (() => void) | null = null;
  private discoveryEntry: CatalogEntry | null = null;
  revision = 0;

  readonly el = {
    hud: $('hud'), hudScore: $('hud-score'), hudBest: $('hud-best'),
    hudMode: $('hud-mode'), hudLoop: $('hud-loop'), hudLoopN: $('hud-loop-n'),
    hudNextName: $('hud-next-name'), btnPause: $('btn-pause'), btnMute: $('btn-mute'),
    loadingFill: $('loading-fill'), loadingTip: $('loading-tip'),
    homeLogo: $<HTMLImageElement>('home-logo'), homeTitleFallback: $('home-title-fallback'),
    bestClassic: $('best-classic'), bestEndless: $('best-endless'), assetWarn: $('asset-warn'),
    btnPlay: $('btn-play'), btnBoard: $('btn-board'),
    modeBestClassic: $('mode-best-classic'), modeBestEndless: $('mode-best-endless'),
    resultTitle: $('result-title'), resultScore: $('result-score'), resultMaxLv: $('result-maxlv'),
    resultMerges: $('result-merges'), resultTime: $('result-time'), resultLoop: $('result-loop'),
    resultLoopWrap: $('result-loop-wrap'), resultRankBox: $('result-rank-box'),
    resultRank: $('result-rank'), resultBestBox: $('result-best-box'),
    btnAgain: $('btn-again'), btnResultBoard: $('btn-result-board'), btnResultHome: $('btn-result-home'),
    boardList: $('board-list'), boardNote: $('board-note'), btnBoardRefresh: $('btn-board-refresh'),
    modalNick: $('modal-nick'), nickInput: $<HTMLInputElement>('nick-input'),
    nickHint: $('nick-hint'), nickRankHint: $('nick-rank-hint'),
    btnNickOk: $('btn-nick-ok'), btnNickClose: $('btn-nick-close'),
    modalPause: $('modal-pause'), btnResume: $('btn-resume'), btnRestart: $('btn-restart'), btnQuit: $('btn-quit'),
    btnSecret: $<HTMLButtonElement>('btn-secret'), secretCount: $('secret-count'),
  };

  constructor(private readonly discovered: Pick<typeof discoveries, 'has'> = discoveries) {
    this.screens = {
      loading: $('screen-loading'), home: $('screen-home'), mode: $('screen-mode'),
      result: $('screen-result'), board: $('screen-board'), game: document.createElement('div'),
    };
    $('btn-guide-close').addEventListener('click', () => this.hideGuide());
    $('btn-discovery-continue').addEventListener('click', () => this.closeDiscovery());
    this.el.btnNickOk.addEventListener('click', () => this.submitNick());
    this.el.btnNickClose.addEventListener('click', () => this.requestNickClose());
    $('btn-nick-edit').addEventListener('click', () => this.continueNick());
    $('btn-nick-confirm-close').addEventListener('click', () => this.resolveNick(null));
    this.el.nickInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.submitNick(); }
    });
    this.el.nickInput.addEventListener('input', () => {
      this.el.nickInput.removeAttribute('aria-invalid');
      this.el.nickHint.classList.remove('error');
      this.el.nickHint.textContent = '中文、字母、数字都可以，最多 12 个字';
    });
    document.querySelectorAll<HTMLElement>('[data-guide-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.guideMode = tab.dataset.guideTab === 'endless' ? 'endless' : 'classic';
        this.renderGuide();
      });
    });
    this.bindTabKeys('.board-tabs [role="tab"]');
    this.bindTabKeys('.guide-tabs [role="tab"]');
    window.addEventListener('keydown', (event) => this.handleModalKey(event), true);
    this.syncModalState();
  }

  show(name: ScreenName) {
    if (name !== this.current) {
      this.revision++;
      this.closeDiscovery();
      this.hideGuide();
      this.resolveNick(null);
      this.hidePause();
    }
    this.current = name;
    this.app.dataset.screen = name;
    for (const [key, el] of Object.entries(this.screens)) {
      if (key !== 'game') el.classList.toggle('hidden', key !== name);
    }
    this.el.hud.classList.toggle('hidden', name !== 'game');
    this.syncModalState();
  }

  get screen(): ScreenName { return this.current; }
  get modalOpen(): boolean { return this.modalStack.length > 0; }
  get guideOpen(): boolean { return this.modalStack.some((m) => m.element === this.modalGuide); }
  get discoveryOpen(): boolean { return this.modalStack.some((m) => m.element === this.modalDiscovery); }

  setLoading(progress: number, tip?: string) {
    const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    this.el.loadingFill.style.width = `${percent}%`;
    this.el.loadingFill.parentElement?.setAttribute('aria-valuenow', String(percent));
    if (tip) this.el.loadingTip.textContent = tip;
  }

  setHomeBests(classic: number, endless: number) {
    this.el.bestClassic.textContent = String(classic);
    this.el.bestEndless.textContent = String(endless);
    this.el.modeBestClassic.textContent = String(classic);
    this.el.modeBestEndless.textContent = String(endless);
  }

  applyLogo(assets: AssetStore) {
    this.assets = assets;
    if (assets.logo) {
      const src = assets.logo.source;
      this.el.homeLogo.src = src instanceof HTMLImageElement ? src.src : (src as HTMLCanvasElement).toDataURL();
      this.el.homeLogo.classList.remove('hidden');
      this.el.homeTitleFallback.classList.add('hidden');
    }
    document.querySelectorAll<HTMLCanvasElement>('canvas[data-level]').forEach((canvas) => {
      const mode = canvas.dataset.previewMode === 'endless' ? 'endless' : 'classic';
      Renderer.drawPreview(canvas, assets, Number(canvas.dataset.level), 112, mode);
    });
    if (this.guideOpen) this.renderGuide();
    if (this.discoveryOpen && this.discoveryEntry) {
      for (const mode of ['classic', 'endless'] as const) {
        const index = CATALOG[mode].findIndex(entry => entry.id === this.discoveryEntry!.id);
        const sprite = index >= 0 ? assets.themes[mode][index] : SECRET_CATALOG[mode].id === this.discoveryEntry.id ? assets.secrets[mode] : null;
        if (sprite) this.drawEntryPreview(this.discoveryCanvas, sprite, 256);
      }
    }
  }

  setHudScore(score: number) { this.el.hudScore.textContent = String(score); }
  setHudBest(best: number) { this.el.hudBest.textContent = `最高 ${best}`; }
  setHudMode(mode: GameMode) {
    this.mode = mode;
    this.el.hudMode.textContent = MODES[mode].label;
    this.el.hudLoop.classList.toggle('hidden', mode !== 'endless');
  }
  setHudLoop(n: number) { this.el.hudLoopN.textContent = String(n); }
  setHudNext(assets: AssetStore, level: number, mode: GameMode = this.mode) {
    this.assets = assets;
    Renderer.drawPreview(this.nextCanvas, assets, level, 52, mode);
    this.el.hudNextName.textContent = entryFor(mode, level).name;
  }

  setSecret(mode: GameMode, count: number) {
    this.mode = mode;
    const available = Math.max(0, Math.floor(count));
    const entry = SECRET_CATALOG[mode];
    this.el.secretCount.textContent = String(available);
    $('secret-name').textContent = entry.name;
    this.el.btnSecret.classList.toggle('hidden', available === 0);
    this.el.btnSecret.disabled = available === 0;
    this.el.btnSecret.setAttribute('aria-label', `${entry.name}，${available} 个。拖入场地清除；也可按回车选择，再用方向键和空格使用。`);
    if (this.assets) this.drawEntryPreview(this.secretCanvas, this.assets.secrets[mode], 52);
  }

  setMuted(muted: boolean) {
    document.querySelectorAll<HTMLElement>('[data-sound]').forEach((button) => {
      button.setAttribute('aria-label', muted ? '打开声音' : '关闭声音');
      button.setAttribute('aria-pressed', String(!muted));
      const use = button.querySelector('use');
      if (use) use.setAttribute('href', muted ? '#i-muted' : '#i-sound');
      const label = button.querySelector<HTMLElement>('[data-sound-label]');
      if (label) label.textContent = muted ? '声音关' : '声音开';
    });
  }

  showResult(d: ResultData) {
    this.mode = d.mode;
    this.el.resultTitle.textContent = d.isRecord ? '新纪录' : '本局结束';
    this.el.resultScore.textContent = String(d.score);
    this.el.resultMaxLv.textContent = entryFor(d.mode, d.maxLevel).name;
    this.el.resultMerges.textContent = String(d.merges);
    this.el.resultTime.textContent = fmtTime(d.durationMs);
    this.el.resultLoop.textContent = String(d.loopCount);
    this.el.resultLoopWrap.classList.toggle('hidden', d.mode !== 'endless');
    const ranked = d.rank !== null && d.rank <= BOARD.topN;
    if (ranked) this.el.resultRank.textContent = `第 ${d.rank} 名`;
    this.el.resultRankBox.classList.toggle('hidden', !ranked);
    this.el.resultBestBox.classList.toggle('hidden', !d.isRecord);
    this.show('result');
  }

  setResultSync(text: string) { $('result-sync').textContent = text; }

  renderBoard(rows: BoardRow[], mode: GameMode, myNick: string, note = '') {
    this.el.boardNote.textContent = note;
    this.el.boardList.innerHTML = rows.length ? rows.map((r) => {
      const name = entryFor(mode, Math.max(1, Math.min(11, r.maxLevel))).name;
      return `<div class="board-row${myNick && r.nickname === myNick ? ' is-me' : ''}">
        <div class="board-rank">${r.rank}</div>
        <div class="board-nick">${escapeHtml(r.nickname)}<small>#${escapeHtml(r.tag)} · ${escapeHtml(name)}</small></div>
        <div class="board-score">${r.score.toLocaleString('zh-CN')}</div>
      </div>`;
    }).join('') : '<div class="board-empty">暂无成绩</div>';
    this.el.boardList.scrollTop = 0;
  }

  setBoardLoading() { this.el.boardList.innerHTML = '<div class="board-empty">加载中…</div>'; }
  setTabs(mode: GameMode) {
    document.querySelectorAll<HTMLElement>('.board-tabs .tab').forEach((tab) => {
      const active = tab.dataset.tab === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
  }

  askNickname(rank: number, defaultNick: string, errorMsg = ''): Promise<string | null> {
    this.resolveNick(null);
    this.el.nickRankHint.textContent = `你排在第 ${rank} 名`;
    this.el.nickInput.value = defaultNick;
    this.el.nickHint.textContent = errorMsg || '中文、字母、数字都可以，最多 12 个字';
    this.el.nickHint.classList.toggle('error', !!errorMsg);
    this.el.nickInput.removeAttribute('aria-invalid');
    return new Promise((resolve) => {
      this.nickResolve = resolve;
      this.openModal(this.el.modalNick, this.el.nickInput);
    });
  }

  resolveNick(value: string | null) {
    this.closeModal(this.el.modalNick);
    $('nick-dismiss').classList.add('hidden'); $('nick-fields').classList.remove('hidden');
    const resolve = this.nickResolve;
    this.nickResolve = null;
    resolve?.(value);
  }
  private submitNick() {
    if (!this.nickResolve || !$('nick-dismiss').classList.contains('hidden')) return;
    const value = this.nickValue;
    const error = !cleanNickname(value) ? '请输入昵称后再保存' : validateNickname(value);
    if (error) { this.nickError(error); this.el.nickInput.focus({ preventScroll: true }); return; }
    this.resolveNick(cleanNickname(value));
  }
  requestNickClose() {
    if (!this.nickResolve) return;
    $('nick-dismiss-message').textContent = cleanNickname(this.nickValue)
      ? '昵称尚未保存，确定放弃填写？'
      : '还没填写昵称，关闭后成绩将匿名显示。确定关闭？';
    $('nick-fields').classList.add('hidden'); $('nick-dismiss').classList.remove('hidden');
    $('btn-nick-edit').focus({ preventScroll: true });
  }
  private continueNick() {
    $('nick-dismiss').classList.add('hidden'); $('nick-fields').classList.remove('hidden');
    this.el.nickInput.focus({ preventScroll: true });
  }
  nickError(msg: string) { this.el.nickHint.textContent = msg; this.el.nickHint.classList.add('error'); this.el.nickInput.setAttribute('aria-invalid', 'true'); }
  get nickValue(): string { return this.el.nickInput.value; }
  showPause() { this.openModal(this.el.modalPause, this.el.btnResume); }
  hidePause() { this.closeModal(this.el.modalPause); }

  showGuide(mode: GameMode = this.mode) {
    this.guideMode = mode;
    this.renderGuide();
    this.openModal(this.modalGuide, $('btn-guide-close'));
  }
  hideGuide() {
    const wasOpen = this.guideOpen;
    if (this.guideOpen && this.discoveryOpen) this.closeDiscovery();
    this.closeModal(this.modalGuide);
    if (wasOpen) this.onGuideClosed?.();
  }

  showDiscovery(entry: CatalogEntry, sprite: Sprite): Promise<void> {
    this.closeDiscovery();
    this.discoveryEntry = entry;
    $('discovery-title').textContent = entry.name;
    $('discovery-description').textContent = entry.description;
    const status = $('discovery-status');
    status.textContent = entry.status || '';
    status.classList.toggle('hidden', !entry.status);
    this.drawEntryPreview(this.discoveryCanvas, sprite, 256);
    return new Promise((resolve) => {
      this.discoveryResolve = resolve;
      this.openModal(this.modalDiscovery, $('btn-discovery-continue'));
    });
  }
  closeDiscovery() {
    this.closeModal(this.modalDiscovery);
    this.discoveryEntry = null;
    const resolve = this.discoveryResolve;
    this.discoveryResolve = null;
    resolve?.();
  }

  private renderGuide() {
    const mode = this.guideMode;
    document.querySelectorAll<HTMLElement>('[data-guide-tab]').forEach((tab) => {
      const active = tab.dataset.guideTab === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $('guide-mode-rule').textContent = mode === 'classic'
      ? '经典模式：两颗最高级球共鸣后保留，每对奖励 100 分。'
      : '无尽模式：两颗最高级球合成一级球，第 n 次循环奖励 500 × n 分。';
    const collection = $('collection');
    collection.setAttribute('aria-label', mode === 'classic' ? '活动图鉴' : '岗位图鉴');
    collection.replaceChildren();
    CATALOG[mode].forEach((entry, index) => {
      collection.append(this.makeCatalogButton(entry, this.assets?.themes[mode][index], index + 1));
    });
    $('secret-collection').replaceChildren(this.makeCatalogButton(SECRET_CATALOG[mode], this.assets?.secrets[mode]));
    $('guide-eggs').classList.toggle('hidden', mode !== 'endless');
    $('egg-collection').replaceChildren(...(mode === 'endless' ? EASTER_EGGS.map(egg =>
      this.makeCatalogButton(EASTER_EGG_CATALOG[egg.level], this.assets?.easterEggs[egg.level], undefined, '彩蛋')) : []));
  }

  private makeCatalogButton(entry: CatalogEntry, sprite?: Sprite, level?: number, lockedLabel = '隐藏道具'): HTMLButtonElement {
    const unlocked = this.discovered.has(entry.id);
    const button = document.createElement('button');
    button.className = `collection-item${unlocked ? '' : ' is-locked'}`;
    button.type = 'button';
    button.disabled = !unlocked;
    button.dataset.entryId = entry.id;
    button.setAttribute('aria-label', unlocked ? `${entry.name}${entry.status ? `，${entry.status}` : ''}，阅读介绍` : `${level ? `第 ${level} 级` : lockedLabel}，未解锁`);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    if (unlocked && sprite) this.drawEntryPreview(canvas, sprite, 80);
    if (!unlocked) {
      const unknown = document.createElement('span');
      unknown.className = 'collection-unknown'; unknown.textContent = '?'; unknown.setAttribute('aria-hidden', 'true');
      button.append(unknown);
    }
    const name = document.createElement('span');
    name.className = 'collection-name';
    name.textContent = unlocked ? entry.name : '未解锁';
    if (unlocked) button.append(canvas);
    button.append(name);
    if (level) {
      const number = document.createElement('small');
      number.textContent = `Lv.${level}`;
      button.append(number);
    } else if (unlocked && entry.status) {
      const status = document.createElement('small');
      status.textContent = entry.status;
      button.append(status);
    }
    button.addEventListener('click', () => { if (this.discovered.has(entry.id) && sprite) void this.showDiscovery(entry, sprite); });
    return button;
  }

  private drawEntryPreview(canvas: HTMLCanvasElement, sprite: Sprite, size: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = sprite.width / sprite.height;
    const width = ratio >= 1 ? size : Math.round(size * ratio);
    const height = ratio >= 1 ? Math.round(size / ratio) : size;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.aspectRatio = `${width} / ${height}`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawSprite(ctx, sprite, width / 2, height / 2, size);
  }

  private openModal(element: HTMLElement, focus: HTMLElement) {
    if (this.modalStack.some((frame) => frame.element === element)) return;
    this.modalStack.push({ element, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    element.classList.remove('hidden');
    this.syncModalState();
    focus.focus({ preventScroll: true });
  }

  private closeModal(element: HTMLElement) {
    const index = this.modalStack.findIndex((frame) => frame.element === element);
    if (index < 0) return;
    const wasTop = index === this.modalStack.length - 1;
    const [frame] = this.modalStack.splice(index, 1);
    element.classList.add('hidden');
    this.syncModalState();
    if (wasTop) {
      const target = frame.returnFocus;
      if (target?.isConnected && !target.closest('[inert]') && target.getClientRects().length) target.focus({ preventScroll: true });
      else this.focusable(this.modalStack.at(-1)?.element)[0]?.focus({ preventScroll: true });
    }
  }

  private syncModalState() {
    const top = this.modalStack.at(-1)?.element;
    Array.from(this.app.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) return;
      if (child.classList.contains('modal')) {
        child.inert = child !== top;
        if (child === top) child.removeAttribute('aria-hidden');
        else child.setAttribute('aria-hidden', 'true');
      } else child.inert = !!top || (child.id === 'game-canvas' && this.current !== 'game');
    });
  }

  private focusable(element?: HTMLElement): HTMLElement[] {
    if (!element) return [];
    return Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
  }

  private handleModalKey(event: KeyboardEvent) {
    const top = this.modalStack.at(-1)?.element;
    if (!top) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (top === this.modalDiscovery) this.closeDiscovery();
      else if (top === this.modalGuide) this.hideGuide();
      else if (top === this.el.modalNick) {
        if ($('nick-dismiss').classList.contains('hidden')) this.requestNickClose(); else this.continueNick();
      }
      else if (top === this.el.modalPause) this.el.btnResume.click();
    } else if (event.key === 'Tab') {
      const items = this.focusable(top);
      const first = items[0];
      const last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  }

  private bindTabKeys(selector: string) {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(selector));
    tabs.forEach((tab, index) => tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    }));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
