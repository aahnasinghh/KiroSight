import {
  realScheduler,
  type BackendEvent,
  type ConnectionState,
  type Disposable,
  type Scheduler,
  type TimerHandle,
} from '../backend/backendClient';
import type { Capabilities, ErrorCode } from '../protocol/messages';
import {
  MAX_VOICE_DURATION_MS,
  type TranscriptionFailure,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceClip,
  type VoiceInput,
  type VoiceTranscriber,
} from './voiceInput';

/**
 * Microphone capture by the backend, behind the `VoiceInput` interface (Task 8.6; design D11, Req
 * 19.6, 19.7, 19.8). Spike D showed that Kiro's webview refuses the microphone, so this is the
 * default implementation. The backend records from its machine's default microphone (Task 8.5);
 * the extension never opens a microphone, holds no audio and no credential.
 *
 * Flow: `start()` sends `record_start`; `stop()` sends `record_stop` and resolves to the recording
 * id (`{ backendClipId }`); the backend answers with one `transcription_result` or one
 * `error_message`, both with `replyTo` = that id. `VoiceController` then calls
 * `input.transcriber.transcribe(clip)`, applies its own 10 s limit, and gives the finished text to
 * `InputPipeline.handle(text, 'voice')`, exactly as for webview-captured text.
 *
 * Why the input listens before `stop()` is called: `record_start` success is silent, so a failure
 * (`MIC_DENIED`, `MIC_UNAVAILABLE`, `CREDENTIAL_MISSING`) arrives as an `error_message` while the
 * user is still "listening", and the backend's own 60 s cap sends the result without any
 * `record_stop`. The first terminal reply for the current id is therefore kept, and handed over
 * when the controller asks for it.
 *
 * Safety:
 * - It records only after `start()`, which `VoiceController.startListening()` calls on a user
 *   action. Constructing it, connecting, `available()` and typing never open the microphone.
 * - One recording at a time. A second `start()` while one is open is rejected and sends nothing.
 * - Only the first terminal reply for the current recording id counts. Replies for any other id
 *   (an earlier, cancelled or finished recording) and repeated replies are ignored, so a stale or
 *   duplicate transcription can never reach the pipeline.
 * - `cancel()` sends a protocol `cancel` for the id (the backend closes the microphone and discards
 *   the audio), and nothing it later receives for that id is used.
 * - Listeners and timers exist only while a recording is current, and are removed when it ends.
 * - Nothing is logged: no audio, no text, no id, no error detail.
 */

/**
 * A finished recording that the controller never asked for is dropped after this long, so a missed
 * hand-over cannot keep listeners alive. It matches the controller's own speech-to-text limit.
 */
export const UNCLAIMED_RESULT_TTL_MS = 10_000;

/** The slice of BackendClient this input uses. BackendClient satisfies it structurally. */
export interface RecorderClient {
  readonly state: ConnectionState;
  readonly capabilities: Capabilities | null;
  sendRecordStart(id: string): boolean;
  sendRecordStop(id: string): boolean;
  /** Sends a protocol `cancel` for the recording id (the method also serves partly sent audio). */
  cancelAudioClip(id: string): boolean;
  onEvent(listener: (event: BackendEvent) => void): Disposable;
  onStateChange(listener: (state: ConnectionState) => void): Disposable;
}

export interface BackendLocalVoiceInputDeps {
  readonly client: RecorderClient;
  readonly scheduler?: Scheduler;
}

/** Tells a listener that the current recording ended before `stop()` (never carries any text). */
export type RecordingEnd = { readonly ok: true } | { readonly ok: false; readonly reason: TranscriptionFailure };

/** Maps the backend's error code for a recording to the controller's failure vocabulary. */
export function transcriptionFailureFor(code: ErrorCode): TranscriptionFailure {
  switch (code) {
    case 'MIC_DENIED':
      return 'mic_denied';
    case 'MIC_UNAVAILABLE':
      return 'mic_unavailable';
    case 'STT_NO_SPEECH':
      return 'no_speech';
    case 'TIMEOUT':
      return 'timeout';
    // STT_UNAVAILABLE, CREDENTIAL_MISSING, VALIDATION_FAILED, INTERNAL and anything else: the
    // clip could not be turned into text, and the reason is not for the extension to interpret.
    default:
      return 'stt_unavailable';
  }
}

interface Recording {
  readonly id: string;
  phase: 'recording' | 'stopped';
  /** The first terminal outcome for this id (a reply or a loss of the backend). Set at most once. */
  outcome: TranscriptionOutcome | null;
  /** Set once `transcribe()` has taken over; resolved by the outcome or by abandoning. */
  waiter: ((outcome: TranscriptionOutcome) => void) | null;
  claimed: boolean;
  orphanTimer: TimerHandle | undefined;
  readonly subscriptions: Disposable[];
}

const ABANDONED: TranscriptionOutcome = { ok: false, reason: 'timeout' };

export class BackendLocalVoiceInput implements VoiceInput {
  public readonly kind = 'backend_local' as const;
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;

  /** Gives the controller the text of the recording `stop()` returned. */
  public readonly transcriber: VoiceTranscriber;

  private readonly client: RecorderClient;
  private readonly scheduler: Scheduler;
  private readonly endListeners = new Set<(end: RecordingEnd) => void>();
  private current: Recording | null = null;
  private recordingCount = 0;
  private disposed = false;

  /** Construction has no side effects: nothing is sent, subscribed or recorded. */
  public constructor(deps: BackendLocalVoiceInputDeps) {
    this.client = deps.client;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.transcriber = {
      transcribe: (clip) => this.transcribe(clip),
      cancel: () => this.cancelPendingResult(),
    };
  }

  /**
   * Whether capture could start now. It reads the connection and the `hello_ack` snapshot only and
   * never records. A snapshot of `denied` or `unavailable` is not final (a microphone may have been
   * fixed since the handshake), and the backend re-checks the microphone on every `record_start`,
   * so only the cases that can never work are refused here.
   */
  public async available(): Promise<VoiceAvailability> {
    if (this.disposed || this.client.state !== 'connected') return { ok: false, reason: 'unavailable' };
    const capabilities = this.client.capabilities;
    if (capabilities === null) return { ok: false, reason: 'unavailable' };
    if (capabilities.mic === 'not_applicable') return { ok: false, reason: 'unsupported' };
    return { ok: true };
  }

  public start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The voice input was disposed.'));
    if (this.current !== null) return Promise.reject(new Error('A recording is already in progress.'));
    if (this.client.state !== 'connected') return Promise.reject(new Error('The backend is not connected.'));

    this.recordingCount += 1;
    const recording: Recording = {
      id: `rec-${this.recordingCount}`,
      phase: 'recording',
      outcome: null,
      waiter: null,
      claimed: false,
      orphanTimer: undefined,
      subscriptions: [],
    };
    this.current = recording;
    // Listen before sending, so even an immediate failure reply cannot be missed.
    recording.subscriptions.push(
      this.client.onEvent((event) => this.onEvent(recording, event)),
      this.client.onStateChange((state) => this.onState(recording, state)),
    );

    if (!this.client.sendRecordStart(recording.id)) {
      this.finish(recording);
      return Promise.reject(new Error('The recording could not be started.'));
    }
    return Promise.resolve();
  }

  public stop(): Promise<VoiceClip> {
    const recording = this.current;
    if (recording === null || recording.phase !== 'recording') {
      return Promise.reject(new Error('No recording is in progress.'));
    }

    recording.phase = 'stopped';
    // Only ask the backend to stop if it is still recording. After an early reply (a start failure,
    // the 60 s cap, a lost connection) there is nothing to stop.
    if (recording.outcome === null && !this.client.sendRecordStop(recording.id)) {
      this.settle(recording, { ok: false, reason: 'backend_unavailable' });
    }
    if (this.current === recording && !recording.claimed) {
      recording.orphanTimer = this.scheduler.setTimeout(() => {
        recording.orphanTimer = undefined;
        if (this.current === recording && !recording.claimed) this.abandon(recording);
      }, UNCLAIMED_RESULT_TTL_MS);
    }
    return Promise.resolve({ backendClipId: recording.id });
  }

  /** Safe at any time, and repeatedly. Closes the backend microphone and discards what it holds. */
  public cancel(): void {
    const recording = this.current;
    if (recording !== null) this.abandon(recording);
  }

  /** True for a clip this input recorded and still holds (the one `stop()` returned). */
  public owns(clip: VoiceClip): boolean {
    const recording = this.current;
    return recording !== null
      && !(clip instanceof Uint8Array)
      && clip.backendClipId === recording.id;
  }

  /**
   * Called when the recording ends before `stop()`: a start failure, the backend's 60 s cap, or a
   * lost connection. It carries no text. Optional for the controller; later tasks may use it to
   * stop showing "Listening" at once.
   */
  public onRecordingEnded(listener: (end: RecordingEnd) => void): Disposable {
    this.endListeners.add(listener);
    return { dispose: () => void this.endListeners.delete(listener) };
  }

  /** Cancels any recording and releases every listener and timer. The input is inert afterwards. */
  public dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.endListeners.clear();
  }

  // --- transcription hand-over -----------------------------------------------------------------------

  private transcribe(clip: VoiceClip): Promise<TranscriptionOutcome> {
    const recording = this.current;
    if (
      recording === null
      || recording.phase !== 'stopped'
      || recording.claimed
      || clip instanceof Uint8Array
      || clip.backendClipId !== recording.id
    ) {
      // Not a clip this input recorded, or one already handed over: nothing to wait for.
      return Promise.resolve({ ok: false, reason: 'stt_unavailable' });
    }

    recording.claimed = true;
    this.clearOrphanTimer(recording);
    if (recording.outcome !== null) {
      const outcome = recording.outcome;
      this.finish(recording);
      return Promise.resolve(outcome);
    }
    return new Promise<TranscriptionOutcome>((resolve) => {
      recording.waiter = resolve;
    });
  }

  /** The controller gave up waiting (its limit, a cancel or dispose). A late reply is then ignored. */
  private cancelPendingResult(): void {
    const recording = this.current;
    if (recording !== null && recording.phase === 'stopped') this.abandon(recording);
  }

  // --- backend messages --------------------------------------------------------------------------------

  private onEvent(recording: Recording, event: BackendEvent): void {
    if (this.current !== recording) return;
    if (event.type === 'transcription_result' && event.replyTo === recording.id) {
      this.settle(recording, { ok: true, text: event.text });
    } else if (event.type === 'error_message' && event.replyTo === recording.id) {
      this.settle(recording, { ok: false, reason: transcriptionFailureFor(event.code) });
    }
  }

  private onState(recording: Recording, state: ConnectionState): void {
    if (this.current !== recording || state === 'connected') return;
    // The backend discards a recording when its connection closes, so nothing more will arrive.
    this.settle(recording, { ok: false, reason: 'backend_unavailable' });
  }

  /** Records the first terminal outcome; later ones for the same recording are duplicates. */
  private settle(recording: Recording, outcome: TranscriptionOutcome): void {
    if (this.current !== recording || recording.outcome !== null) return;
    recording.outcome = outcome;

    if (recording.waiter !== null) {
      const waiter = recording.waiter;
      this.finish(recording);
      waiter(outcome);
      return;
    }
    if (recording.phase === 'recording') {
      const end: RecordingEnd = outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
      for (const listener of [...this.endListeners]) {
        try {
          listener(end);
        } catch {
          // A listener must never break the input.
        }
      }
    }
  }

  // --- cleanup -----------------------------------------------------------------------------------------

  /** Ends the recording: the backend is told to close the microphone and discard the audio. */
  private abandon(recording: Recording): void {
    const waiter = recording.waiter;
    // A recording that already has its outcome is finished at the backend; only a live one is cancelled.
    const needsCancel = recording.outcome === null;
    this.finish(recording);
    if (needsCancel) {
      try {
        this.client.cancelAudioClip(recording.id);
      } catch {
        // Releasing the microphone must never throw out of cancel().
      }
    }
    waiter?.(ABANDONED);
  }

  private finish(recording: Recording): void {
    if (this.current === recording) this.current = null;
    this.clearOrphanTimer(recording);
    for (const subscription of recording.subscriptions.splice(0)) subscription.dispose();
    recording.waiter = null;
  }

  private clearOrphanTimer(recording: Recording): void {
    if (recording.orphanTimer !== undefined) this.scheduler.clearTimeout(recording.orphanTimer);
    recording.orphanTimer = undefined;
  }
}
