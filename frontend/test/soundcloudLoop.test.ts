import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOP_END, LOOP_START, SoundCloudLoop, type SoundCloudEvents, type SoundCloudWidget } from '../src/soundcloudLoop';

const events: SoundCloudEvents = { READY: 'ready', PLAY: 'play', PLAY_PROGRESS: 'progress', SEEK: 'seek', ERROR: 'error' };

function createWidget() {
  const listeners = new Map<string, (data?: { currentPosition?: number }) => void>();
  const widget = {
    bind: vi.fn((event: string, listener: (data?: { currentPosition?: number }) => void) => { listeners.set(event, listener); }),
    unbind: vi.fn((event: string) => { listeners.delete(event); }),
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn(),
    setVolume: vi.fn(),
    getPosition: vi.fn()
  } satisfies SoundCloudWidget;
  return { widget, emit: (event: string, position?: number) => listeners.get(event)?.({ currentPosition: position }), listeners };
}

afterEach(() => vi.useRealTimers());

describe('SoundCloud loop', () => {
  it('waits for readiness and starts muted at 2:30', () => {
    vi.useFakeTimers();
    const { widget, emit } = createWidget();
    const loop = new SoundCloudLoop(widget, events, vi.fn());
    expect(widget.play).not.toHaveBeenCalled();
    loop.start();
    expect(widget.play).not.toHaveBeenCalled();
    emit(events.READY);
    expect(widget.seekTo).toHaveBeenLastCalledWith(LOOP_START);
    expect(widget.play).toHaveBeenCalledTimes(1);
    expect(widget.setVolume).toHaveBeenLastCalledWith(0);
    emit(events.PLAY);
    emit(events.PLAY_PROGRESS, LOOP_START - 1);
    expect(widget.setVolume).toHaveBeenLastCalledWith(0);
    emit(events.SEEK, LOOP_START);
    expect(widget.setVolume).toHaveBeenLastCalledWith(100);
    loop.dispose();
  });

  it('mutes before 3:00, seeks back, and pauses immediately when off', () => {
    vi.useFakeTimers();
    const { widget, emit, listeners } = createWidget();
    const loop = new SoundCloudLoop(widget, events, vi.fn());
    emit(events.READY);
    loop.start();
    emit(events.PLAY);
    emit(events.SEEK, LOOP_START);
    emit(events.PLAY_PROGRESS, LOOP_END - 150);
    expect(widget.setVolume).toHaveBeenLastCalledWith(0);
    expect(widget.seekTo).toHaveBeenLastCalledWith(LOOP_START);
    emit(events.PLAY_PROGRESS, LOOP_END);
    expect(widget.seekTo).toHaveBeenCalledTimes(3);
    emit(events.SEEK, LOOP_START);
    expect(widget.setVolume).toHaveBeenLastCalledWith(100);
    loop.stop();
    expect(widget.setVolume).toHaveBeenLastCalledWith(0);
    expect(widget.pause).toHaveBeenCalledTimes(1);
    loop.start();
    expect(widget.seekTo).toHaveBeenLastCalledWith(LOOP_START);
    loop.dispose();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns off when the widget reports an error', () => {
    const { widget, emit } = createWidget();
    const onStopped = vi.fn();
    const loop = new SoundCloudLoop(widget, events, onStopped);
    emit(events.ERROR);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(widget.pause).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('turns off if SoundCloud never becomes ready', () => {
    vi.useFakeTimers();
    const { widget } = createWidget();
    const onStopped = vi.fn();
    const loop = new SoundCloudLoop(widget, events, onStopped);
    loop.start();
    vi.advanceTimersByTime(10_000);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(widget.pause).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('clears its timers without messaging an iframe that has already been removed', () => {
    vi.useFakeTimers();
    const { widget, emit } = createWidget();
    const loop = new SoundCloudLoop(widget, events, vi.fn());
    loop.start();
    emit(events.READY);
    widget.pause.mockClear();
    widget.setVolume.mockClear();
    loop.dispose(false);
    expect(widget.pause).not.toHaveBeenCalled();
    expect(widget.setVolume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
