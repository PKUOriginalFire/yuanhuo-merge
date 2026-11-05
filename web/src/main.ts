import './ui/style.css';
import { mountTheatre } from './ui/theatre';
import { BOARD, CONTAINER, FLAGS, MODES, type GameMode } from './config';
import { createAssetStore, loadAssets, spriteFor, type AssetStore, type Sprite } from './assets';
import { entryFor, SECRET_CATALOG, type CatalogEntry } from './catalog';
import { discoveries } from './discovery';
import { Game, type GameEvents, type GameSnapshot } from './game';
import { RunConnection } from './continuation';
import { Renderer } from './renderer';
import { Effects } from './effects';
import { UI } from './ui/ui';
import { store } from './storage';
import { fetchLeaderboard, submitRun, submitNickname, mockMode, ApiError } from './api';
import { isMuted, setMuted, sfx, unlockAudio } from './audio';
import { cleanNickname, validateNickname } from './nick';

class App {
  private ui = new UI();
  private renderer = new Renderer(document.getElementById('game-canvas') as HTMLCanvasElement);
  private effects = new Effects();
  private assets!: AssetStore;
  private game: Game | null = null;
  private mode: GameMode = 'classic';
  private paused = false;
  private activePointer: number | null = null;
  private draggingSecret = false;
  private lastTs = 0;
  private hudScore = -1;
  private hudNext = 0;
  private hudLoop = -1;
  private hudSecret = -1;
  private submitting = false;
  private runVersion = 0;
  private boardRequest = 0;
  private boardMode: GameMode = 'classic';
  private discoveryQueue: { entry: CatalogEntry; sprite: () => Sprite }[] = [];
  private presentingDiscovery = false;
  private connection = new RunConnection();
  private networkBusy = false;
  private needsRecovery = false;
  private physicsTime = 0;
  private resumeAfterGuide = false;
  private lastSave = 0;

  async boot() {
    mountTheatre();
    this.connection.onConflict = error => {
      if (!this.game || this.game.status !== 'playing') return;
      this.paused = true; this.needsRecovery = true; this.cancelAim(); this.ui.showPause();
      document.getElementById('pause-sync')!.textContent = `存档冲突，请点继续恢复：${error.message}`;
    };
    const query = new URLSearchParams(location.search);
    FLAGS.debug = query.get('debug') === '1'; FLAGS.mock = mockMode;
    document.getElementById('progress-hint')!.classList.toggle('hidden', mockMode);
    const speed = Number(query.get('speed')); if (FLAGS.debug && speed > 0 && speed <= 8) FLAGS.speed = speed;
    this.assets = createAssetStore(); this.bindGlobal();
    this.ui.applyLogo(this.assets); this.ui.setMuted(isMuted()); this.ui.setHomeBests(store.best('classic'), store.best('endless'));
    this.renderer.render({ mode: 'classic', status: 'ready', canDrop: false, listBalls: () => [], overflowProgress: 0 } as unknown as Game, this.assets, this.effects);
    requestAnimationFrame(this.loop); this.ui.show('home'); this.refreshContinuation();
    await loadAssets(undefined, this.assets);
    this.ui.applyLogo(this.assets);
    if (this.game) {
      this.hudNext = 0; this.hudSecret = -1; this.syncHud();
      this.renderer.render(this.game, this.assets, this.effects);
    }
  }
  private bindGlobal() {
    window.addEventListener('resize', () => { this.cancelAim(); this.renderer.resize(); });
    window.addEventListener('orientationchange', () => setTimeout(() => this.renderer.resize(), 250));
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { passive: true }); window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.ui.screen === 'game') this.pause(); });
    window.addEventListener('pagehide', () => { this.cancelAim(); if (!mockMode) this.connection.suspend(this.game?.snapshot()); });
    window.addEventListener('pageshow', event => {
      if (event.persisted && !mockMode && this.connection.available) { this.runVersion++; this.networkBusy = false; void this.restoreOnline(); }
    });
    window.addEventListener('blur', () => this.cancelAim()); window.addEventListener('keydown', event => this.onKey(event));
    const canvas = this.renderer.canvas;
    canvas.addEventListener('pointerdown', event => this.onPointerDown(event, false));
    document.getElementById('btn-secret')!.addEventListener('pointerdown', event => this.onPointerDown(event, true));
    document.getElementById('btn-secret')!.addEventListener('click', event => {
      if ((event as MouseEvent).detail === 0 && this.canControl() && this.game!.secretCount) {
        this.draggingSecret = true;
        this.game!.setSecretAim((CONTAINER.left + CONTAINER.right) / 2, CONTAINER.floor - 350);
        this.renderer.canvas.focus({ preventScroll: true });
      }
    });
    window.addEventListener('pointermove', event => this.onPointerMove(event)); window.addEventListener('pointerup', event => this.onPointerUp(event));
    window.addEventListener('pointercancel', event => { if (event.pointerId === this.activePointer) this.cancelAim(); });
    for (const element of [canvas, document.getElementById('btn-secret')!]) element.addEventListener('lostpointercapture', event => { if ((event as PointerEvent).pointerId === this.activePointer) this.cancelAim(); });
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.ui.el.btnPlay.addEventListener('click', () => { sfx.click(); this.ui.show('mode'); });
    document.getElementById('btn-continue')!.addEventListener('click', () => { void this.restoreOnline(); });
    this.ui.el.btnBoard.addEventListener('click', () => { sfx.click(); void this.openBoard(); });
    document.querySelectorAll('[data-sound]').forEach(button => button.addEventListener('click', () => { setMuted(!isMuted()); this.ui.setMuted(isMuted()); }));
    this.ui.onGuideClosed = () => {
      if (this.resumeAfterGuide) { this.resumeAfterGuide = false; this.saveProgress(); }
    };
    document.querySelectorAll('[data-guide]').forEach(button => button.addEventListener('click', () => {
      this.cancelAim();
      if (!mockMode && this.ui.screen === 'game' && !this.paused) {
        this.resumeAfterGuide = true;
        this.saveProgress(false);
      }
      this.ui.showGuide(this.mode);
    }));
    document.querySelectorAll<HTMLElement>('.mode-card').forEach(card => card.addEventListener('click', () => { const mode = card.dataset.mode as GameMode; if (MODES[mode]) this.startGame(mode); }));
    document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => this.goHome()));
    this.ui.el.btnAgain.addEventListener('click', () => this.startGame(this.mode));
    this.ui.el.btnResultHome.addEventListener('click', () => this.goHome());
    this.ui.el.btnResultBoard.addEventListener('click', () => { this.boardMode = this.mode; void this.openBoard(); });
    document.getElementById('btn-board-refresh')!.addEventListener('click', () => { void this.loadBoard(this.boardMode); });
    document.querySelectorAll<HTMLElement>('.tab[data-tab]').forEach(tab => tab.addEventListener('click', () => { this.boardMode = tab.dataset.tab as GameMode; this.ui.setTabs(this.boardMode); void this.loadBoard(this.boardMode); }));
    this.ui.el.btnPause.addEventListener('click', () => this.pause()); this.ui.el.btnResume.addEventListener('click', () => this.resume());
    this.ui.el.btnRestart.addEventListener('click', () => this.startGame(this.mode)); this.ui.el.btnQuit.addEventListener('click', () => this.goHome());
  }
  private canControl() { return this.ui.screen === 'game' && !this.networkBusy && !this.paused && !this.ui.modalOpen && !this.presentingDiscovery && this.game?.status === 'playing'; }
  private onPointerDown(event: PointerEvent, secret: boolean) {
    if (!this.canControl() || !event.isPrimary || event.button !== 0 || this.activePointer !== null || (secret && !this.game!.secretCount)) return;
    event.preventDefault(); this.activePointer = event.pointerId; this.draggingSecret = secret;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = this.renderer.toWorld(event.clientX, event.clientY);
    if (secret) this.game!.setSecretAim(point.x, point.y); else this.game!.setAimX(point.x);
  }
  private onPointerMove(event: PointerEvent) {
    if (event.pointerId !== this.activePointer || !this.canControl()) return;
    event.preventDefault(); const point = this.renderer.toWorld(event.clientX, event.clientY);
    if (this.draggingSecret) this.game!.setSecretAim(point.x, point.y); else this.game!.setAimX(point.x);
  }
  private onPointerUp(event: PointerEvent) {
    if (event.pointerId !== this.activePointer || event.button !== 0) return;
    const secret = this.draggingSecret; const point = this.renderer.toWorld(event.clientX, event.clientY);
    this.cancelAim(); if (!this.canControl()) return; event.preventDefault();
    if (secret) { this.useTool(point.x, point.y); }
    else { this.game!.setAimX(point.x); this.drop(); }
  }
  private cancelAim() {
    const pointer = this.activePointer; this.activePointer = null; this.draggingSecret = false; this.game?.cancelSecretAim();
    for (const element of [this.renderer.canvas, document.getElementById('btn-secret')!]) if (pointer !== null && element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
  }
  private drop() {
    if (this.game?.drop()) { sfx.drop(); this.syncHud(); this.saveProgress(); void this.presentDiscoveries(); }
  }
  private useTool(x: number, y: number) {
    if (this.game!.useSecret(x, y) !== null) { sfx.resonate(); this.effects.shake(4); this.syncHud(); this.saveProgress(); }
  }
  private onKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.activePointer !== null || this.draggingSecret) this.cancelAim(); else if (this.ui.discoveryOpen) this.ui.closeDiscovery();
      else if (this.ui.guideOpen) this.ui.hideGuide(); else if (!this.ui.el.modalNick.classList.contains('hidden')) this.ui.requestNickClose();
      else if (this.ui.screen === 'game') this.paused ? this.resume() : this.pause(); return;
    }
    if (!this.canControl() || (event.target as HTMLElement).closest('input,button,textarea') || event.repeat) return;
    const step = event.shiftKey ? 80 : 28;
    if (this.draggingSecret && this.game!.secretAim) {
      const aim = this.game!.secretAim;
      const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (delta[event.key]) {
        const [dx, dy] = delta[event.key];
        this.game!.setSecretAim(Math.max(CONTAINER.left, Math.min(CONTAINER.right, aim.x + dx)), Math.max(430, Math.min(CONTAINER.floor, aim.y + dy)));
        event.preventDefault();
      } else if (event.key === ' ' || event.key === 'Enter') {
        const { x, y } = aim; this.cancelAim(); this.useTool(x, y); event.preventDefault();
      }
      return;
    }
  }
  private enqueueDiscovery(entry: CatalogEntry, sprite: () => Sprite) {
    if (discoveries.mark(entry.id)) this.discoveryQueue.push({ entry, sprite });
  }
  private async presentDiscoveries() {
    if (this.presentingDiscovery || this.ui.modalOpen || !this.discoveryQueue.length || !['game', 'result'].includes(this.ui.screen)) return;
    const run = this.runVersion; this.presentingDiscovery = true; this.cancelAim();
    const wasPaused = this.paused;
    this.saveProgress(false);
    while (run === this.runVersion && this.discoveryQueue.length) { const item = this.discoveryQueue.shift()!; await this.ui.showDiscovery(item.entry, item.sprite()); }
    if (run === this.runVersion) {
      this.presentingDiscovery = false; this.lastTs = performance.now();
      if (!wasPaused && !document.hidden && !this.needsRecovery) this.saveProgress();
    }
  }
  private destroyGame() {
    this.resumeAfterGuide = false;
    this.runVersion++; this.cancelAim(); this.ui.hidePause(); this.ui.hideGuide(); this.ui.closeDiscovery();
    this.discoveryQueue = []; this.presentingDiscovery = false; this.paused = false; this.game?.destroy(); this.game = null; this.effects.clear();
  }
  private startGame(mode: GameMode) {
    if (!mockMode) { void this.startOnline(mode); return; }
    this.installGame(mode);
  }
  private gameEvents(mode: GameMode): GameEvents {
    return {
      onDiscover: level => this.enqueueDiscovery(entryFor(mode, level), () => spriteFor(this.assets, mode, level)),
      onSecret: count => { this.ui.setSecret(mode, count); this.enqueueDiscovery(SECRET_CATALOG[mode], () => this.assets.secrets[mode]); },
      onMerge: (level, x, y) => { sfx.merge(level); this.effects.spawnMerge(level, x, y); },
      onResonate: (x, y) => { sfx.resonate(); this.effects.spawnResonate(x, y); },
      onRecycle: (x, y, loop, gained) => { sfx.recycle(loop); this.effects.spawnRecycle(x, y, loop, gained); },
      onGameOver: () => { void this.onGameOver(); },
    };
  }
  private installGame(mode: GameMode, state?: GameSnapshot) {
    this.destroyGame(); this.mode = mode; this.submitting = false; this.hudScore = this.hudLoop = this.hudSecret = -1; this.hudNext = 0;
    this.physicsTime = 0; this.lastSave = performance.now();
    this.game = state ? Game.restore(state, this.gameEvents(mode)) : new Game(mode, this.gameEvents(mode));
    this.game.start(); this.ui.setHudMode(mode); this.ui.setHudBest(store.best(mode)); this.ui.show('game'); this.syncHud();
    this.lastTs = performance.now(); this.renderer.canvas.focus({ preventScroll: true });
  }
  private refreshContinuation(message = '') {
    const available = !mockMode && this.connection.available;
    document.getElementById('btn-continue')!.classList.toggle('hidden', !available);
    this.ui.el.btnPlay.classList.toggle('btn-primary', !available);
    this.ui.el.btnPlay.firstChild!.textContent = available ? '新开一局' : '选择模式';
    for (const id of ['home-session-status', 'mode-session-status']) document.getElementById(id)!.textContent = message;
  }
  private goHome() {
    if (this.networkBusy) return;
    if (!mockMode) this.connection.suspend(this.game?.snapshot());
    this.destroyGame(); this.ui.show('home'); this.refreshContinuation();
  }
  private async startOnline(mode: GameMode) {
    if (this.networkBusy) return;
    this.destroyGame(); this.ui.show('home'); this.networkBusy = true; this.refreshContinuation('正在连接…');
    try {
      const reply = await this.connection.start(mode); this.needsRecovery = false;
      this.installGame(mode, reply.state); this.refreshContinuation();
    } catch (error) {
      // 4xx 是服务端明确拒绝（如比赛已截止），照原话展示；5xx/网络问题才提示"联网后重试"。
      const msg = (error as Error).message;
      this.refreshContinuation(error instanceof ApiError && error.status < 500 ? msg : `暂时无法开局，请联网后重试：${msg}`);
    }
    finally { this.networkBusy = false; }
  }
  private async restoreOnline() {
    if (mockMode || this.networkBusy) return;
    this.destroyGame(); this.ui.show('home'); this.networkBusy = true; this.refreshContinuation('正在恢复…');
    try {
      const reply = await this.connection.restore(); this.needsRecovery = false;
      this.installGame(reply.state.mode, reply.state); this.refreshContinuation();
      this.paused = true; this.ui.showPause(); document.getElementById('pause-sync')!.textContent = '已恢复上局进度';
      this.renderer.render(this.game!, this.assets, this.effects);
      if (reply.state.status === 'over') { this.ui.hidePause(); this.networkBusy = false; await this.onGameOver(); }
    } catch (error) { this.refreshContinuation(`暂时无法恢复：${(error as Error).message}`); document.getElementById('pause-sync')!.textContent = `暂时无法恢复：${(error as Error).message}`; }
    finally { this.networkBusy = false; }
  }
  private saveProgress(active = !this.paused && !this.presentingDiscovery && !this.ui.modalOpen && !document.hidden) {
    if (!mockMode && this.game && !this.needsRecovery) {
      this.connection.save(this.game.snapshot(), active); this.lastSave = performance.now();
    }
  }
  private pause() {
    if (this.game?.status !== 'playing' || this.ui.modalOpen) return;
    this.cancelAim(); this.paused = true; this.ui.showPause();
    this.saveProgress(false);
  }
  private async resume() {
    if (this.networkBusy) return;
    if (!mockMode && this.needsRecovery) { await this.restoreOnline(); return; }
    this.cancelAim(); this.paused = false; this.ui.hidePause(); this.lastTs = performance.now(); this.renderer.canvas.focus({ preventScroll: true }); this.saveProgress();
  }
  private async onGameOver() {
    const game = this.game; if (!game || this.submitting) return;
    const run = this.runVersion; this.cancelAim(); sfx.gameOver(); const isRecord = store.recordBest(game.mode, game.score);
    this.ui.setHomeBests(store.best('classic'), store.best('endless'));
    const result = { mode: game.mode, score: game.score, maxLevel: game.maxLevelReached, merges: game.merges, loopCount: game.loopCount, durationMs: game.durationMs, rank: null as number | null, isRecord };
    this.ui.showResult(result); this.ui.setResultSync('正在保存成绩'); await this.presentDiscoveries(); if (run !== this.runVersion) return;
    const revision = this.ui.revision; this.submitting = true;
    let saved = true;
    if (!mockMode) { try { await this.connection.flush(game.snapshot(), false); } catch { saved = false; } }
    if (run !== this.runVersion) return;
    // 提交可能被明确拒绝（例如比赛已截止返回 403）。这里必须兜住：
    // 否则异常会抛出 onGameOver，submitting 永远停在 true，结果页一直显示"正在保存成绩"。
    let submitError = '';
    const fallback = { ok: false, rank: null, improved: false, promptSignature: false };
    const response = saved
      ? await submitRun({ ...(!mockMode ? this.connection.credentials() : {}), mode: game.mode, score: game.score, maxLevel: game.maxLevelReached, merges: game.merges, loopCount: game.loopCount, durationMs: game.durationMs, trace: game.trace })
        .catch((error: Error) => { submitError = error.message; return fallback; })
      : fallback;
    if (run !== this.runVersion) return; this.submitting = false;
    if (!mockMode && response.ok) { this.connection.clear(); this.refreshContinuation(); }
    if (this.ui.screen !== 'result' || this.ui.revision !== revision) return;
    this.ui.showResult({ ...result, rank: response.rank, isRecord: isRecord || response.improved });
    this.ui.setResultSync(response.ok ? (mockMode ? '演示成绩，仅存本机' : '成绩已保存') : (submitError || '已记入本机，暂未进入在线榜单'));
    if (response.promptSignature && response.rank !== null) await this.promptSignature(response.rank, run);
  }
  private async promptSignature(rank: number, run: number) {
    let error = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      if (run !== this.runVersion || this.ui.screen !== 'result') return;
      const input = await this.ui.askNickname(rank, store.get().nickname, error); if (input === null || run !== this.runVersion) return;
      const invalid = validateNickname(input); if (invalid) { error = invalid; continue; }
      try { await submitNickname(cleanNickname(input)); } catch (e) { error = (e as Error).message || '保存失败，请重试'; continue; } return;
    }
  }
  private async openBoard() { this.ui.show('board'); this.ui.setTabs(this.boardMode); await this.loadBoard(this.boardMode); }
  private async loadBoard(mode: GameMode) {
    const request = ++this.boardRequest; const revision = this.ui.revision; this.ui.setBoardLoading();
    try { const rows = await fetchLeaderboard(mode, store.get().nickname); if (request === this.boardRequest && revision === this.ui.revision && this.ui.screen === 'board') this.ui.renderBoard(rows, mode, store.get().nickname, mockMode ? '演示榜单，仅存本机' : '每人保留最高分，同分先达成的在前'); }
    catch { if (request === this.boardRequest && revision === this.ui.revision && this.ui.screen === 'board') this.ui.renderBoard([], mode, store.get().nickname, '暂时无法加载，请点击刷新'); }
  }
  private loop = (timestamp: number) => {
    requestAnimationFrame(this.loop); const dt = this.lastTs ? Math.min(50, timestamp - this.lastTs) : 16.667; this.lastTs = timestamp;
    if (!document.hidden && this.ui.screen === 'game' && this.game && !this.networkBusy && !this.paused && !this.ui.modalOpen && !this.presentingDiscovery) {
      if (mockMode) this.game.update(dt);
      else { this.physicsTime += dt; while (this.physicsTime >= 1000 / 60 && this.game.status === 'playing') { this.game.update(1000 / 60); this.physicsTime -= 1000 / 60; } }
      this.effects.update(dt); this.syncHud();
      if (timestamp - this.lastSave >= 2000) this.saveProgress();
      this.renderer.render(this.game, this.assets, this.effects);
      void this.presentDiscoveries();
    }
  };
  private syncHud() {
    const game = this.game!;
    if (this.hudScore !== game.score) { this.hudScore = game.score; this.ui.setHudScore(game.score); }
    if (this.hudNext !== game.nextLevel) { this.hudNext = game.nextLevel; this.ui.setHudNext(this.assets, game.nextLevel, game.mode); }
    if (this.hudLoop !== game.loopCount) { this.hudLoop = game.loopCount; this.ui.setHudLoop(game.loopCount); }
    if (this.hudSecret !== game.secretCount) { this.hudSecret = game.secretCount; this.ui.setSecret(game.mode, game.secretCount); }
  }
}
const app = new App();
app.boot().catch(error => { console.error(error); const tip = document.getElementById('loading-tip'); if (tip) tip.textContent = `加载失败：${(error as Error).message}`; });
// 把实例挂到 window 上只用于开发和测试（tests/app-*.test.ts 靠它驱动游戏）。
// ⚠️ 生产构建里**不能有**：攻击者拿到 `app` 就能直接 `app.game.setAimX(...)` 驱动客户端，
//    等于把"如何脚本化这个游戏"的入口白送出去。`import.meta.env.DEV` 在 `vite build`
//    时是 false，整段会被 tree-shaking 掉，连字符串都不会留在 bundle 里。
if (import.meta.env.DEV) (window as unknown as { __yuanhuo: unknown }).__yuanhuo = { app, FLAGS, CONTAINER, BOARD };
