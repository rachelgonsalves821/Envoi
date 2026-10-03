export const LOOP_START = 150_000;
export const LOOP_END = 180_000;
const LOOP_GUARD_MS = 150;

export type SoundCloudWidget = {
  bind(event: string, listener: (data?: { currentPosition?: number }) => void): void;
  unbind(event: string): void;
  play(): void;
  pause(): void;
  seekTo(position: number): void;
  setVolume(volume: number): void;
  getPosition(callback: (position: number) => void): void;
};

export type SoundCloudEvents = {
  READY: string;
  PLAY: string;
  PLAY_PROGRESS: string;
  SEEK: string;
  ERROR: string;
};

export type SoundCloudApi = {
  Widget: ((iframe: HTMLIFrameElement) => SoundCloudWidget) & { Events: SoundCloudEvents };
};

declare global {
  interface Window { SC?: SoundCloudApi }
}

let apiPromise: Promise<SoundCloudApi> | undefined;

export function loadSoundCloudApi(): Promise<SoundCloudApi> {
  if (window.SC) return Promise.resolve(window.SC);
  if (apiPromise) return apiPromise;
  const loading = new Promise<SoundCloudApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://w.soundcloud.com/player/api.js';
    script.async = true;
    script.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || '';
    script.onload = () => {
      if (window.SC) resolve(window.SC);
      else {
        script.remove();
        reject(new Error('SoundCloud Widget API is unavailable'));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('SoundCloud Widget API could not load'));
    };
    document.head.appendChild(script);
  }).catch(error => {
    apiPromise = undefined;
    throw error;
  });
  apiPromise = loading;
  return loading;
}

export class SoundCloudLoop {
  private ready = false;
  private wanted = false;
  private playing = false;
  private seeking = false;
  private audible = false;
  private positionPending = false;
  private lastSeekAt = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly onReady = () => {
    this.ready = true;
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.startTimeout = undefined;
    this.widget.setVolume(0);
    this.lastSeekAt = Date.now();
    this.widget.seekTo(LOOP_START);
    if (this.wanted) this.begin();
  };
  private readonly onPlay = () => {
    if (!this.wanted) {
      this.widget.setVolume(0);
      this.widget.pause();
      return;
    }
    this.playing = true;
    if (!this.audible) {
      this.widget.setVolume(0);
      this.lastSeekAt = Date.now();
      this.widget.seekTo(LOOP_START);
      if (this.startTimeout) clearTimeout(this.startTimeout);
      this.startTimeout = setTimeout(() => {
        if (!this.audible && this.wanted) this.onError();
      }, 10_000);
    }
  };
  private readonly onProgress = (data?: { currentPosition?: number }) => this.checkPosition(data?.currentPosition);
  private readonly onError = () => {
    this.stop();
    this.onStopped();
  };

  constructor(private readonly widget: SoundCloudWidget, private readonly events: SoundCloudEvents, private readonly onStopped: () => void) {
    widget.bind(events.READY, this.onReady);
    widget.bind(events.PLAY, this.onPlay);
    widget.bind(events.PLAY_PROGRESS, this.onProgress);
    widget.bind(events.SEEK, this.onProgress);
    widget.bind(events.ERROR, this.onError);
  }

  start() {
    this.wanted = true;
    if (this.ready) this.begin();
    else this.startTimeout = setTimeout(() => {
      if (!this.ready && this.wanted) this.onError();
    }, 10_000);
  }

  private begin() {
    this.generation += 1;
    this.seeking = true;
    this.audible = false;
    this.playing = false;
    this.widget.setVolume(0);
    this.lastSeekAt = Date.now();
    this.widget.seekTo(LOOP_START);
    this.widget.play();
    this.startTimeout = setTimeout(() => {
      if (!this.audible && this.wanted && this.playing) this.onError();
    }, 10_000);
    if (!this.timer) this.timer = setInterval(() => {
      if (this.positionPending || !this.wanted) return;
      this.positionPending = true;
      const generation = this.generation;
      this.widget.getPosition(position => {
        if (generation !== this.generation) return;
        this.positionPending = false;
        this.checkPosition(position);
      });
    }, 75);
  }

  private checkPosition(position?: number) {
    if (!this.wanted || typeof position !== 'number' || !Number.isFinite(position)) return;
    if (position >= LOOP_END - LOOP_GUARD_MS) {
      if (!this.seeking || Date.now() - this.lastSeekAt > 1_000) {
        this.seeking = true;
        this.audible = false;
        this.widget.setVolume(0);
        this.lastSeekAt = Date.now();
        this.widget.seekTo(LOOP_START);
      }
      return;
    }
    if (position < LOOP_START) {
      this.widget.setVolume(0);
      this.audible = false;
      if (Date.now() - this.lastSeekAt > 1_000) {
        this.lastSeekAt = Date.now();
        this.widget.seekTo(LOOP_START);
      }
      return;
    }
    this.seeking = false;
    if (this.playing && !this.audible) {
      this.widget.setVolume(100);
      this.audible = true;
      if (this.startTimeout) clearTimeout(this.startTimeout);
      this.startTimeout = undefined;
    }
  }

  stop(notifyWidget = true) {
    this.generation += 1;
    this.wanted = false;
    this.playing = false;
    this.seeking = false;
    this.audible = false;
    this.positionPending = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.startTimeout = undefined;
    if (notifyWidget) {
      this.widget.setVolume(0);
      this.widget.pause();
    }
  }

  dispose(notifyWidget = true) {
    this.stop(notifyWidget);
    if (!notifyWidget) return;
    this.widget.unbind(this.events.READY);
    this.widget.unbind(this.events.PLAY);
    this.widget.unbind(this.events.PLAY_PROGRESS);
    this.widget.unbind(this.events.SEEK);
    this.widget.unbind(this.events.ERROR);
  }
}
