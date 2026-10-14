import { realScheduler, type Scheduler, type TimerHandle } from '../backend/backendClient';
import type { Capabilities } from '../protocol/messages';
import {
  DEFAULT_VOICE_KIND,
  type TranscriptionFailure,
  type VoiceClip,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
  type VoiceUnavailableReason,
} from './voiceInput';

/**
 * Drives push-to-talk behind the `VoiceInput` interface (Task 8.2; design "Voice pipeline" and
 * "VoiceInput abstraction"; Req 9.1, 9.3, 10.3, 19.6, 19.7).
 *
 * What it does, and no more:
 * - picks one implementation from the `hello_ack` capabilities, the Spike D default and what has
 *   proved unreliable, and prefers nothing it cannot use;
 * - applies the time limits: 60 s capture, 5 s first sample (webview only), 10 s speech-to-text,
 *   10 s voice initialization;
 * - remembers the last known microphone state;
 * - hands FINISHED transcription text, and only that, to `InputPipeline.handle(text, 'voice')`.
 *
 * What it never does: record on its own (only `startListening()`, which a user action calls, ever
 * starts a capture), call the router, the action validator, the confirmation manager or the
 * backend directly, hold a credential, or log audio or text. Text from either implementation takes
 * the same path as typed text (Req 19.7).
 */

export const FIRST_SAMPLE_WATCHDOG_MS = 5_000;
export const STT_RESPONSE_LIMIT_MS = 10_000;
export const VOICE_INIT_BUDGET_MS = 10_000;

/** The last microphone state this session has seen. */
export type MicState = 'unknown' | 'granted' | 'denied' | 'unavailable' | 'undetermined';

/** Why voice cannot be used. Each has a plain sentence in `describeVoiceStatus`. */
export type VoiceUnavailableCause =
  | 'no_backend'
  | 'stt_unavailable'
  | 'no_input'
  | 'mic_denied'
  | 'mic_unavailable'
  | 'unsupported'
  | 'webview_unreliable'
  | 'init_timeout';

export type VoicePhase = 'initializing' | 'idle' | 'listening' | 'processing' | 'unavailable';

export interface VoiceStatus {
  readonly phase: VoicePhase;
  /** The implementation in use, or null when none can be used. */
  readonly kind: VoiceKind | null;
  readonly micState: MicState;
  /** Set when `phase` is 'unavailable'. */
  readonly cause: VoiceUnavailableCause | null;
  /** True once webview capture has proved unreliable this session. */
  readonly webviewUnreliable: boolean;
  /** A plain sentence for the status line or the transcript; never conveyed by color alone. */
  readonly text: string;
}

// --- selection -------------------------------------------------------------------------------------

export interface VoiceSelectionInput {
  /** From `hello_ack`; null while the backend is not connected. */
  readonly capabilities: Capabilities | null;
  /** The implementations that exist. */
  readonly provided: readonly VoiceKind[];
  readonly preferred: VoiceKind;
  readonly webviewUnreliable: boolean;
}

export type VoiceSelection =
  | { readonly kind: VoiceKind }
  | { readonly kind: null; readonly cause: VoiceUnavailableCause };

/**
 * Chooses the implementation. Pure. Speech-to-text lives in the backend, so no backend or no STT
 * means no voice at all. The preferred implementation wins if it can be used; otherwise the other
 * one. A webview that proved unreliable is never chosen again this session. The backend-local
 * implementation needs the backend to report an available microphone.
 */
export function selectVoiceInput(input: VoiceSelectionInput): VoiceSelection {
  const { capabilities } = input;
  if (capabilities === null) return { kind: null, cause: 'no_backend' };
  if (!capabilities.stt) return { kind: null, cause: 'stt_unavailable' };

  const order: VoiceKind[] = input.preferred === 'webview' ? ['webview', 'backend_local'] : ['backend_local', 'webview'];
  let lastCause: VoiceUnavailableCause = 'no_input';
  for (const kind of order) {
    if (!input.provided.includes(kind)) continue;
    if (kind === 'webview') {
      if (input.webviewUnreliable) {
        lastCause = 'webview_unreliable';
        continue;
      }
      return { kind };
    }
    switch (capabilities.mic) {
      case 'available':
        return { kind };
      case 'denied':
        lastCause = 'mic_denied';
        break;
      case 'unavailable':
        lastCause = 'mic_unavailable';
        break;
      case 'not_applicable':
        lastCause = 'unsupported';
        break;
    }
  }
  return { kind: null, cause: lastCause };
}

// --- plain-sentence status texts ---------------------------------------------------------------------

const KEEP_TYPING = 'You can keep typing.';

const UNAVAILABLE_TEXT: Record<VoiceUnavailableCause, string> = {
  no_backend: `Voice input is unavailable because the KiroSight backend is not connected. ${KEEP_TYPING}`,
  stt_unavailable: `Voice input is unavailable because speech recognition is not set up. ${KEEP_TYPING}`,
  no_input: `Voice input is unavailable on this setup. ${KEEP_TYPING}`,
  mic_denied: `Voice input is unavailable because microphone permission was denied. ${KEEP_TYPING}`,
  mic_unavailable: `Voice input is unavailable because no microphone was found. ${KEEP_TYPING}`,
  unsupported: `Voice input is unavailable because the backend cannot record from a microphone. ${KEEP_TYPING}`,
  webview_unreliable:
    `Microphone capture in the panel is not available, and no other microphone input is ready. ${KEEP_TYPING}`,
  init_timeout:
    `Voice input and output are unavailable for this session because setup did not finish in time. ${KEEP_TYPING}`,
};

export function describeVoiceStatus(
  status: Pick<VoiceStatus, 'phase' | 'cause' | 'micState'>,
): string {
  switch (status.phase) {
    case 'initializing':
      return 'Voice is starting.';
    case 'listening':
      return 'Listening.';
    case 'processing':
      return 'Processing what you said.';
    case 'unavailable':
      return UNAVAILABLE_TEXT[status.cause ?? 'no_input'];
    case 'idle':
      return status.micState === 'undetermined'
        ? 'Microphone permission has not been granted yet. Press push-to-talk to request it.'
        : 'Voice is ready. Press push-to-talk to speak.';
  }
}

// --- outcomes ---------------------------------------------------------------------------------------

export type VoiceFailure =
  | TranscriptionFailure
  | 'empty'
  | 'capture_failed'
  | 'not_available'
  | 'webview_unreliable'
  | 'internal';

export type StartOutcome =
  | { readonly status: 'listening' }
  | { readonly status: 'busy' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly reason: VoiceFailure };

export type VoiceOutcome =
  /** Text was handed to the pipeline as a voice utterance. */
  | { readonly status: 'routed' }
  | { readonly status: 'not_listening' }
  | { readonly status: 'cancelled' }
  /** Nothing was routed. The caller adds the transcript entry (Task 8.9). */
  | { readonly status: 'failed'; readonly reason: VoiceFailure };

export interface VoiceControllerDeps {
  /** The implementations that exist; absent kinds are never selected. */
  readonly inputs: Partial<Record<VoiceKind, VoiceInput>>;
  readonly transcriber: VoiceTranscriber;
  /** InputPipeline satisfies this. It is the only thing finished text is given to. */
  readonly pipeline: { handle(text: string, source: 'voice'): Promise<unknown> };
  readonly scheduler?: Scheduler;
  readonly preferred?: VoiceKind;
}

const WEBVIEW_FAILURES: readonly VoiceUnavailableReason[] = ['denied', 'unavailable', 'unsupported'];

function micStateOf(reason: VoiceUnavailableReason): MicState {
  switch (reason) {
    case 'denied':
      return 'denied';
    case 'undetermined':
      return 'undetermined';
    default:
      return 'unavailable';
  }
}

function causeOf(reason: VoiceUnavailableReason): VoiceUnavailableCause {
  switch (reason) {
    case 'denied':
      return 'mic_denied';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'mic_unavailable';
  }
}

export class VoiceController {
  private readonly scheduler: Scheduler;
  private readonly preferred: VoiceKind;
  private readonly listeners = new Set<(status: VoiceStatus) => void>();
  private readonly capListeners = new Set<(outcome: VoiceOutcome) => void>();

  private capabilities: Capabilities | null = null;
  private webviewUnreliable = false;
  private micState: MicState = 'unknown';
  private active: VoiceInput | null = null;
  private phase: VoicePhase = 'unavailable';
  private cause: VoiceUnavailableCause | null = 'no_backend';
  /** Bumped by every start, cancel and dispose so that a late result can be recognised as stale. */
  private generation = 0;
  private starting = false;
  private disposed = false;
  private capTimer: TimerHandle | undefined;
  private watchdogTimer: TimerHandle | undefined;

  public constructor(private readonly deps: VoiceControllerDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.preferred = deps.preferred ?? DEFAULT_VOICE_KIND;
  }

  public get status(): VoiceStatus {
    const base = {
      phase: this.phase,
      kind: this.active?.kind ?? null,
      micState: this.micState,
      cause: this.phase === 'unavailable' ? this.cause : null,
      webviewUnreliable: this.webviewUnreliable,
    };
    return Object.freeze({ ...base, text: describeVoiceStatus(base) });
  }

  public onStatus(listener: (status: VoiceStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Told the outcome when the 60 s cap, not the user, ended a capture. */
  public onCapReached(listener: (outcome: VoiceOutcome) => void): { dispose(): void } {
    this.capListeners.add(listener);
    return { dispose: () => void this.capListeners.delete(listener) };
  }

  // --- initialization (never records) ---------------------------------------------------------------

  /**
   * Chooses the implementation and asks whether it could capture, within the 10 s voice
   * initialization budget (Req 10.3). It never starts a recording. Call it again when the
   * capabilities change, for example after a reconnect.
   */
  public async initialize(capabilities: Capabilities | null): Promise<VoiceStatus> {
    if (this.disposed) return this.status;
    this.cancel();
    this.capabilities = capabilities;
    this.setPhase('initializing', null, null);

    let timer: TimerHandle | undefined;
    const budget = new Promise<'timeout'>((resolve) => {
      timer = this.scheduler.setTimeout(() => resolve('timeout'), VOICE_INIT_BUDGET_MS);
    });
    try {
      await this.resolveInput(budget);
    } finally {
      if (timer !== undefined) this.scheduler.clearTimeout(timer);
    }
    return this.status;
  }

  private async resolveInput(budget: Promise<'timeout'>): Promise<void> {
    // At most two candidates, so a webview that fails can fall through to the backend-local input.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const selection = this.select();
      if (selection.kind === null) {
        this.active = null;
        this.setPhase('unavailable', null, selection.cause);
        return;
      }
      const input = this.deps.inputs[selection.kind]!;
      const result = await Promise.race([this.askAvailable(input), budget]);
      if (this.disposed) return;
      if (result === 'timeout') {
        this.active = null;
        this.setPhase('unavailable', null, 'init_timeout');
        return;
      }
      if (result.ok) {
        this.micState = 'granted';
        this.setPhase('idle', input, null);
        return;
      }
      this.micState = micStateOf(result.reason);
      if (input.kind === 'webview' && WEBVIEW_FAILURES.includes(result.reason)) {
        this.webviewUnreliable = true;
        continue;
      }
      if (input.kind === 'webview') {
        // Permission simply has not been asked yet: capture can still be tried, which prompts.
        this.setPhase('idle', input, null);
        return;
      }
      this.active = null;
      this.setPhase('unavailable', null, causeOf(result.reason));
      return;
    }
    this.active = null;
    this.setPhase('unavailable', null, 'webview_unreliable');
  }

  private select(): VoiceSelection {
    return selectVoiceInput({
      capabilities: this.capabilities,
      provided: (['webview', 'backend_local'] as const).filter((kind) => this.deps.inputs[kind] !== undefined),
      preferred: this.preferred,
      webviewUnreliable: this.webviewUnreliable,
    });
  }

  private async askAvailable(input: VoiceInput): ReturnType<VoiceInput['available']> {
    try {
      return await input.available();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  // --- push-to-talk ------------------------------------------------------------------------------

  /**
   * Begins one capture. Only an explicit user action may call this. The microphone is checked
   * again every time, so a permission granted since the last attempt works at once (Req 18.6).
   */
  public async startListening(): Promise<StartOutcome> {
    if (this.disposed || this.active === null) return { status: 'failed', reason: 'not_available' };
    if (this.phase !== 'idle' || this.starting) return { status: 'busy' };

    this.starting = true;
    const input = this.active;
    const generation = (this.generation += 1);
    try {
      const availability = await this.askAvailable(input);
      if (generation !== this.generation) return { status: 'cancelled' };
      if (!availability.ok) {
        this.micState = micStateOf(availability.reason);
        if (input.kind === 'webview' && WEBVIEW_FAILURES.includes(availability.reason)) {
          return this.fallBackFromWebview();
        }
        if (availability.reason === 'undetermined' && input.kind === 'webview') {
          // Not yet asked: starting the capture is what asks.
        } else {
          if (input.kind === 'backend_local') this.setPhase('idle', input, null);
          return { status: 'failed', reason: 'not_available' };
        }
      } else {
        this.micState = 'granted';
      }

      try {
        await input.start();
      } catch {
        if (generation !== this.generation) return { status: 'cancelled' };
        return { status: 'failed', reason: 'capture_failed' };
      }
      if (generation !== this.generation) {
        input.cancel();
        return { status: 'cancelled' };
      }

      this.setPhase('listening', input, null);
      this.capTimer = this.scheduler.setTimeout(() => {
        this.capTimer = undefined;
        // The cap ends the capture for the user, so the outcome is reported to whoever listens.
        void this.stopListening().then((outcome) => {
          for (const listener of [...this.capListeners]) {
            try {
              listener(outcome);
            } catch {
              // A listener must never break the controller.
            }
          }
        });
      }, input.maxDurationMs);
      if (input.kind === 'webview') {
        this.watchdogTimer = this.scheduler.setTimeout(() => this.onWatchdog(generation), FIRST_SAMPLE_WATCHDOG_MS);
      }
      return { status: 'listening' };
    } finally {
      this.starting = false;
    }
  }

  /** A webview implementation calls this when its first non-empty audio sample reaches the host. */
  public notifyFirstSample(): void {
    this.clearTimer('watchdog');
  }

  private onWatchdog(generation: number): void {
    this.watchdogTimer = undefined;
    if (generation !== this.generation || this.phase !== 'listening') return;
    // No sample within 5 s: webview capture is unreliable (Req 19.6). Abandon it and move on.
    this.generation += 1;
    this.clearTimer('cap');
    this.active?.cancel();
    this.deps.transcriber.cancel?.();
    this.fallBackFromWebview();
  }

  private fallBackFromWebview(): StartOutcome {
    this.webviewUnreliable = true;
    const selection = this.select();
    if (selection.kind === null) {
      this.active = null;
      this.setPhase('unavailable', null, selection.cause);
    } else {
      this.setPhase('idle', this.deps.inputs[selection.kind]!, null);
    }
    return { status: 'failed', reason: 'webview_unreliable' };
  }

  /**
   * Ends the capture (the user pressed push-to-talk again, or the 60 s cap fired), waits at most
   * 10 s for the text, and hands non-empty text to the pipeline as a voice utterance. On any
   * failure nothing is routed and the reason is returned for the caller to state.
   */
  public async stopListening(): Promise<VoiceOutcome> {
    const input = this.active;
    if (this.disposed || input === null || this.phase !== 'listening') return { status: 'not_listening' };

    this.clearTimer('cap');
    this.clearTimer('watchdog');
    const generation = this.generation;
    this.setPhase('processing', input, null);

    let clip: VoiceClip;
    try {
      clip = await input.stop();
    } catch {
      return this.finish(generation, { status: 'failed', reason: 'capture_failed' });
    }
    if (generation !== this.generation) return { status: 'cancelled' };

    const outcome = await this.transcribeWithinLimit(clip);
    if (generation !== this.generation) return { status: 'cancelled' };

    if (!outcome.ok) {
      if (outcome.reason === 'mic_denied') this.micState = 'denied';
      if (outcome.reason === 'mic_unavailable') this.micState = 'unavailable';
      return this.finish(generation, { status: 'failed', reason: outcome.reason });
    }
    const text = outcome.text.trim();
    if (text === '') return this.finish(generation, { status: 'failed', reason: 'empty' });

    // Back to idle first, so push-to-talk is usable again while the pipeline works on the text.
    this.setPhase('idle', input, null);
    try {
      await this.deps.pipeline.handle(text, 'voice');
    } catch {
      return { status: 'failed', reason: 'internal' };
    }
    return { status: 'routed' };
  }

  private finish(generation: number, outcome: VoiceOutcome): VoiceOutcome {
    if (generation === this.generation && this.active !== null) this.setPhase('idle', this.active, null);
    return outcome;
  }

  private async transcribeWithinLimit(clip: VoiceClip): ReturnType<VoiceTranscriber['transcribe']> {
    let timer: TimerHandle | undefined;
    const limit = new Promise<'timeout'>((resolve) => {
      timer = this.scheduler.setTimeout(() => resolve('timeout'), STT_RESPONSE_LIMIT_MS);
    });
    try {
      const attempt = this.deps.transcriber.transcribe(clip).catch(
        (): { ok: false; reason: TranscriptionFailure } => ({ ok: false, reason: 'stt_unavailable' }),
      );
      const result = await Promise.race([attempt, limit]);
      if (result === 'timeout') {
        this.deps.transcriber.cancel?.();
        return { ok: false, reason: 'timeout' };
      }
      return result;
    } finally {
      if (timer !== undefined) this.scheduler.clearTimeout(timer);
    }
  }

  /** Abandons any capture or pending transcription, releases the microphone, and routes nothing. */
  public cancel(): void {
    this.generation += 1;
    this.clearTimer('cap');
    this.clearTimer('watchdog');
    const wasBusy = this.phase === 'listening' || this.phase === 'processing';
    try {
      this.active?.cancel();
    } catch {
      // Releasing the microphone must never throw out of cancel().
    }
    if (wasBusy) {
      this.deps.transcriber.cancel?.();
      if (this.active !== null) this.setPhase('idle', this.active, null);
    }
  }

  /** Releases the microphone and every timer and listener. The controller is inert afterwards. */
  public dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.listeners.clear();
    this.capListeners.clear();
  }

  // --- internals ---------------------------------------------------------------------------------

  private clearTimer(which: 'cap' | 'watchdog'): void {
    const timer = which === 'cap' ? this.capTimer : this.watchdogTimer;
    if (timer !== undefined) this.scheduler.clearTimeout(timer);
    if (which === 'cap') this.capTimer = undefined;
    else this.watchdogTimer = undefined;
  }

  private setPhase(phase: VoicePhase, input: VoiceInput | null, cause: VoiceUnavailableCause | null): void {
    this.phase = phase;
    this.active = input;
    this.cause = cause;
    const status = this.status;
    for (const listener of [...this.listeners]) {
      try {
        listener(status);
      } catch {
        // A listener must never break the controller.
      }
    }
  }
}
