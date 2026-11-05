interface MusicSource { url: string; type: string; }

/** Native streaming keeps a whole-song PCM decode off the game thread. */
export class BackgroundMusic {
  private player: HTMLAudioElement | null = null;
  private sourceIndex = -1;
  private unlocked = false;
  private starting = false;
  private attempt = 0;

  constructor(private readonly sources: readonly MusicSource[], private muted = false, private visible = true) {}

  unlock() { this.unlocked = true; this.resume(); }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.player) this.player.muted = muted;
    if (muted) this.pause(); else this.resume();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.resume(); else this.pause();
  }

  private get allowed() { return this.unlocked && !this.muted && this.visible; }

  private ensurePlayer(): HTMLAudioElement | null {
    if (this.player) return this.player;
    if (!this.sources.length) return null;
    try {
      const player = new Audio();
      player.preload = 'none'; player.loop = true; player.volume = 0.2;
      const supported = this.sources.findIndex(source => !!player.canPlayType(source.type));
      this.sourceIndex = supported < 0 ? this.sources.length - 1 : supported;
      player.onerror = () => {
        this.pause();
        if (this.sourceIndex + 1 < this.sources.length) {
          player.src = this.sources[++this.sourceIndex].url;
          this.resume();
        }
      };
      player.src = this.sources[this.sourceIndex].url;
      this.player = player;
      return player;
    } catch { return null; }
  }

  private pause() {
    this.attempt++; this.starting = false;
    this.player?.pause();
  }

  private resume() {
    if (!this.allowed) return;
    const player = this.ensurePlayer();
    if (!player || this.starting || !player.paused) return;
    const attempt = ++this.attempt;
    this.starting = true;
    try {
      if (player.error) player.load();
      void Promise.resolve(player.play()).then(() => {
        // A pending play can finish after a tab switch or mute action.
        if (!this.allowed) player.pause();
      }, () => {
        // Autoplay/network failures never stop gameplay; the next gesture can retry.
      }).finally(() => { if (attempt === this.attempt) this.starting = false; });
    } catch { if (attempt === this.attempt) this.starting = false; }
  }
}
