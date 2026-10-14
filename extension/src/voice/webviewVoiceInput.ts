import { realScheduler, type Scheduler, type TimerHandle } from '../backend/backendClient';
import type { AudioChunk, AudioRelay } from './audioRelay';
import {
  MAX_VOICE_DURATION_MS,
  type VoiceAvailability,
  type VoiceClip,
  type VoiceInput,
} from './voiceInput';

/**
 * Microphone capture in the webview, behind the `VoiceInput` interface (Task 8.3; Req 9.1, 19.1,
 * 19.3, 19.5). The panel records with `MediaRecorder` when the host asks; the host never touches
 * the microphone itself.
 *
 * Spike D found that Kiro's webview refuses the microphone (`NotAllowedError`), so
 * `BackendLocalVoiceInput` is the selected default. This implementation stays a fully supported
 * alternative: if a different host allows webview capture, only the selection changes. Nothing here
 * claims that webview capture works in Kiro.
 *
 * Safety:
 * - It records only after `start()`, which `VoiceController.startListening()` calls on a user
 *   action. The webview does nothing until it receives `start_capture`.
 * - Audio is accepted only between `start()` and the end of that capture. Chunks that arrive at
 *   any other time (a replay, a stray message, a capture that was cancelled) are dropped and never
 *   reach the backend, so a recording cannot be submitted twice or without a request.
 * - `cancel()` tells the webview to stop (which releases the microphone) and discards what it sends.
 * - Memory and frame size are bounded by `AudioRelay`.
 */

/** How long the host waits for the webview's answer to `start_capture` (a permission prompt may be open). */
export const START_ANSWER_TIMEOUT_MS = 10_000;

/** How long the host waits for the last chunk after `stop_capture`. */
export const STOP_ANSWER_TIMEOUT_MS = 5_000;

export type WebviewMicState = 'granted' | 'denied' | 'unavailable' | 'prompt';

/** What the host can ask the webview to do. The panel provider posts these on the bridge. */
export interface WebviewCaptureBridge {
  /** False when no panel is open. */
  isOpen(): boolean;
  command(type: 'start_capture' | 'stop_capture'): void;
}

export interface WebviewVoiceInputDeps {
  readonly bridge: WebviewCaptureBridge;
  readonly relay: Pick<AudioRelay, 'accept' | 'reset'>;
  /** Called once per capture, when the first non-empty audio chunk reaches the host (Req 19.6). */
  readonly onFirstSample?: () => void;
  readonly scheduler?: Scheduler;
}

/**
 * `completed`: the last chunk arrived (and was relayed) before `stop()` was called.
 * `failed`: relaying failed mid-capture; the microphone was released and `stop()` will reject.
 */
type Phase = 'idle' | 'starting' | 'capturing' | 'stopping' | 'completed' | 'failed';

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  timer: TimerHandle | undefined;
}

export class WebviewVoiceInput implements VoiceInput {
  public readonly kind = 'webview' as const;
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;

  private readonly scheduler: Scheduler;
  private micState: WebviewMicState | 'unknown' = 'unknown';
  private phase: Phase = 'idle';
  private sawFirstSample = false;
  private startWaiter: Waiter<void> | null = null;
  private stopWaiter: Waiter<VoiceClip> | null = null;
  private completed: VoiceClip | null = null;
  private failure: Error | null = null;

  public constructor(private readonly deps: WebviewVoiceInputDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
  }

  /** There is no way to ask the webview in advance: the last answer to a capture attempt is all we know. */
  public async available(): Promise<VoiceAvailability> {
    if (!this.deps.bridge.isOpen()) return { ok: false, reason: 'unavailable' };
    switch (this.micState) {
      case 'granted':
        return { ok: true };
      case 'denied':
        return { ok: false, reason: 'denied' };
      case 'unavailable':
        return { ok: false, reason: 'unavailable' };
      default:
        return { ok: false, reason: 'undetermined' };
    }
  }

  public start(): Promise<void> {
    // A capture that already ended (`completed` or `failed`) and was never collected by `stop()` is stale.
    if (this.phase === 'completed' || this.phase === 'failed') this.phase = 'idle';
    if (this.phase !== 'idle') return Promise.reject(new Error('A capture is already in progress.'));
    if (!this.deps.bridge.isOpen()) return Promise.reject(new Error('The panel is not open.'));

    this.completed = null;
    this.failure = null;
    this.phase = 'starting';
    this.sawFirstSample = false;
    this.deps.relay.reset();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter<void> = { resolve, reject, timer: undefined };
      waiter.timer = this.scheduler.setTimeout(() => {
        if (this.startWaiter !== waiter) return;
        this.startWaiter = null;
        this.abandon();
        reject(new Error('The panel did not answer the capture request in time.'));
      }, START_ANSWER_TIMEOUT_MS);
      this.startWaiter = waiter;
      this.deps.bridge.command('start_capture');
    });
  }

  public stop(): Promise<VoiceClip> {
    if (this.phase === 'completed' && this.completed !== null) {
      const clip = this.completed;
      this.completed = null;
      this.phase = 'idle';
      return Promise.resolve(clip);
    }
    if (this.phase === 'failed') {
      const error = this.failure ?? new Error('The recording was not usable.');
      this.failure = null;
      this.phase = 'idle';
      return Promise.reject(error);
    }
    if (this.phase !== 'capturing') return Promise.reject(new Error('No capture is in progress.'));

    this.phase = 'stopping';
    return new Promise<VoiceClip>((resolve, reject) => {
      const waiter: Waiter<VoiceClip> = { resolve, reject, timer: undefined };
      waiter.timer = this.scheduler.setTimeout(() => {
        if (this.stopWaiter !== waiter) return;
        this.stopWaiter = null;
        this.abandon();
        reject(new Error('The recording did not finish in time.'));
      }, STOP_ANSWER_TIMEOUT_MS);
      this.stopWaiter = waiter;
      this.deps.bridge.command('stop_capture');
    });
  }

  /** Safe at any time, and repeatedly. Idle: nothing happens. Otherwise the webview is told to stop. */
  public cancel(): void {
    this.failWaiters(new Error('The capture was cancelled.'));
    this.abandon();
  }

  // --- messages from the webview (the panel provider forwards them) --------------------------------

  /** The webview's answer to a capture attempt. Also records the state for `available()`. */
  public handleMicState(state: WebviewMicState): void {
    this.micState = state;
    const waiter = this.startWaiter;
    if (waiter === null || this.phase !== 'starting') return;

    if (state === 'granted') {
      this.startWaiter = null;
      this.clearTimer(waiter);
      this.phase = 'capturing';
      waiter.resolve();
    } else if (state === 'denied' || state === 'unavailable') {
      this.startWaiter = null;
      this.clearTimer(waiter);
      this.phase = 'idle';
      waiter.reject(new Error(`Microphone ${state}.`));
    }
    // 'prompt': keep waiting for the user's answer.
  }

  /**
   * One audio chunk. Accepted only during a capture; anything else is dropped without effect, so
   * unrequested or repeated audio never reaches the backend.
   */
  public handleAudioClip(chunk: AudioChunk): void {
    if (this.phase !== 'capturing' && this.phase !== 'stopping') return;

    if (!this.sawFirstSample && chunk.base64.length > 0) {
      this.sawFirstSample = true;
      try {
        this.deps.onFirstSample?.();
      } catch {
        // An observer must never break the capture.
      }
    }

    const outcome = this.deps.relay.accept(chunk);
    switch (outcome.status) {
      case 'skipped':
      case 'duplicate':
        return;
      case 'relayed': {
        // Each chunk has already gone to the backend. Only the last one ends the capture.
        if (!outcome.final) return;
        const waiter = this.stopWaiter;
        if (waiter !== null) {
          this.phase = 'idle';
          this.stopWaiter = null;
          this.clearTimer(waiter);
          waiter.resolve({ backendClipId: outcome.backendClipId });
        } else {
          // The webview ended the capture itself; `stop()` will report the finished recording.
          this.phase = 'completed';
          this.completed = { backendClipId: outcome.backendClipId };
        }
        return;
      }
      case 'unavailable':
      case 'rejected': {
        const error = new Error(outcome.status === 'unavailable' ? 'The backend is unavailable.' : 'The recording was not usable.');
        const waiter = this.stopWaiter;
        this.abandon();
        if (waiter !== null) {
          this.stopWaiter = null;
          this.clearTimer(waiter);
          waiter.reject(error);
        } else {
          // Mid-capture: the microphone is released and later audio is dropped; `stop()` reports it.
          this.phase = 'failed';
          this.failure = error;
        }
        return;
      }
    }
  }

  // --- internals ---------------------------------------------------------------------------------------

  /** Returns to idle, asks the webview to stop (releasing the microphone) and discards partial audio. */
  private abandon(): void {
    const needsStop = this.phase !== 'idle' && this.phase !== 'completed';
    this.phase = 'idle';
    this.completed = null;
    this.failure = null;
    this.deps.relay.reset();
    if (needsStop) {
      try {
        this.deps.bridge.command('stop_capture');
      } catch {
        // Releasing the microphone must never throw out of cancel().
      }
    }
  }

  private failWaiters(error: Error): void {
    for (const waiter of [this.startWaiter, this.stopWaiter]) {
      if (waiter === null) continue;
      this.clearTimer(waiter);
      waiter.reject(error);
    }
    this.startWaiter = null;
    this.stopWaiter = null;
  }

  private clearTimer(waiter: { timer: TimerHandle | undefined }): void {
    if (waiter.timer !== undefined) this.scheduler.clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
}
