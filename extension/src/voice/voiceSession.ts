import { realScheduler, type Disposable, type Scheduler, type TimerHandle } from '../backend/backendClient';
import type { Capabilities } from '../protocol/messages';
import type { TranscriptStore } from '../transcript/transcriptStore';
import type { StatusKind, VoiceViewModel } from '../webview/viewModel';
import {
  VOICE_INIT_BUDGET_MS,
  describeVoiceStatus,
  type StartOutcome,
  type VoiceFailure,
  type VoiceOutcome,
  type VoiceStatus,
  type VoiceUnavailableCause,
} from './voiceController';
import type { RecordingEnd } from './backendLocalVoiceInput';

/**
 * The user-facing side of voice (Task 8.9; Req 9.2, 9.3, 10.1, 10.3, 10.4, 10.5, 18.1 to 18.6, 19.7).
 *
 * `VoiceController` owns the recording lifecycle and hands finished text to
 * `InputPipeline.handle(text, 'voice')`; that call also records the text in the Transcript as the
 * user's query, exactly as for typed text. This class adds what the controller deliberately leaves
 * to its caller:
 *
 * - what the user is told: a Transcript entry within the same turn whenever voice input cannot be
 *   processed or voice is unavailable, and the voice part of the view model (the push-to-talk note,
 *   the Listening and Processing labels, the pressed state);
 * - the push-to-talk toggle (one press starts, the next ends), which the webview posts as
 *   `ptt_toggle` on Enter, Space or a click;
 * - the activation behavior: `kirosight.activate` always opens the panel and never throws because
 *   of voice, begins listening only when the microphone is known to be usable, and otherwise
 *   offers the keyboard-operable push-to-talk control and says why;
 * - the 10 s session-start budget: if voice is not ready by then, one Transcript entry says voice is
 *   unavailable for the session, and push-to-talk stays focusable with visible text.
 *
 * It never records on its own: only `activate()` (a user invoked the command) and
 * `togglePushToTalk()` (a user pressed the control) can start a capture. It never touches the draft in
 * the typed-text input, so typed input and every local feature keep working under every failure
 * (Req 10.4, 10.5). It routes, validates and executes nothing: spoken text is data that goes through
 * the pipeline like any typed text. It logs nothing. Task 8.13 constructs it and connects it to the
 * panel and the backend client.
 */

/** The slice of VoiceController this class uses. VoiceController satisfies it. */
export interface VoiceControllerPort {
  readonly status: VoiceStatus;
  initialize(capabilities: Capabilities | null): Promise<VoiceStatus>;
  startListening(): Promise<StartOutcome>;
  stopListening(): Promise<VoiceOutcome>;
  cancel(): void;
  onStatus(listener: (status: VoiceStatus) => void): Disposable;
  onCapReached(listener: (outcome: VoiceOutcome) => void): Disposable;
}

export interface VoiceSessionDeps {
  readonly controller: VoiceControllerPort;
  readonly transcript: Pick<TranscriptStore, 'append'>;
  /** The backend's latest `hello_ack` capabilities, or null while it is not connected. */
  readonly getCapabilities: () => Capabilities | null;
  readonly scheduler?: Scheduler;
  /**
   * Called just before a recording starts (push-to-talk or activation), so spoken output stops and
   * outdated work is superseded instead of the microphone hearing it (Task 9.5). Failures here
   * never prevent listening.
   */
  readonly onBeforeListening?: () => void;
}

/** The voice part of the view model. The caller merges it into the full view model. */
export interface VoiceSessionView {
  readonly voice: VoiceViewModel;
  readonly listening: boolean;
  /** Listening, processing or voice_unavailable; null when voice has no opinion about the status. */
  readonly statusKind: StatusKind | null;
}

const TYPE_INSTEAD = 'You can type the same request.';

const STARTING_TEXT = 'Voice is starting.';

/** Req 9.3 and 10.1: said when speech could not be turned into a request. */
const FAILURE_TEXT: Record<VoiceFailure, string> = {
  empty: `Voice input could not be processed: no speech was recognized. ${TYPE_INSTEAD}`,
  no_speech: `Voice input could not be processed: no speech was recognized. ${TYPE_INSTEAD}`,
  timeout: `Voice input could not be processed: speech recognition did not answer in time. ${TYPE_INSTEAD}`,
  stt_unavailable: `Voice input could not be processed: speech recognition is unavailable. ${TYPE_INSTEAD}`,
  backend_unavailable: `Voice input could not be processed: the KiroSight backend is not connected. ${TYPE_INSTEAD}`,
  mic_denied: `Voice input could not be processed: microphone permission was denied. ${TYPE_INSTEAD}`,
  mic_unavailable: `Voice input could not be processed: no microphone was found. ${TYPE_INSTEAD}`,
  capture_failed: `Voice input could not be processed: the recording could not be completed. ${TYPE_INSTEAD}`,
  internal: `Voice input could not be processed: something went wrong. ${TYPE_INSTEAD}`,
  not_available: `Voice input could not be started because voice is not available right now. ${TYPE_INSTEAD}`,
  webview_unreliable:
    `Voice input could not be started: microphone capture in the panel is not available. ${TYPE_INSTEAD}`,
};

const DENIED_RETRY_TEXT =
  'Microphone access was denied earlier. Press push-to-talk to try again once access is allowed.';
const UNAVAILABLE_RETRY_TEXT =
  'No microphone was found earlier. Press push-to-talk to try again once one is connected.';

/** Plain text for a failure; exported so tests and callers share the exact wording. */
export function describeVoiceFailure(reason: VoiceFailure): string {
  return FAILURE_TEXT[reason];
}

export class VoiceSession implements Disposable {
  private readonly scheduler: Scheduler;
  private readonly listeners = new Set<(view: VoiceSessionView) => void>();
  private readonly subscriptions: Disposable[];
  private watchdog: TimerHandle | undefined;
  private initializing = false;
  private timedOut = false;
  private disposed = false;
  /** The last unavailable cause written to the Transcript, so one cause is stated once, not per change. */
  private recordedCause: VoiceUnavailableCause | null = null;
  private recordedGuidance = false;

  public constructor(private readonly deps: VoiceSessionDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.subscriptions = [
      deps.controller.onStatus((status) => this.onControllerStatus(status)),
      deps.controller.onCapReached((outcome) => this.handleOutcome(outcome)),
    ];
  }

  /** The current voice view model fields. */
  public get view(): VoiceSessionView {
    return this.buildView();
  }

  public onChange(listener: (view: VoiceSessionView) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  // --- session start (Req 10.3) -------------------------------------------------------------------

  /**
   * Starts the voice session budget. Until `initialize()` sees the backend's capabilities, voice is
   * "starting"; if that takes longer than 10 s, one Transcript entry says voice input and output are
   * unavailable for the session. Push-to-talk stays focusable with visible text throughout. It
   * records nothing and opens no microphone.
   */
  public begin(): void {
    if (this.disposed || this.initializing) return;
    this.initializing = true;
    this.timedOut = false;
    this.clearWatchdog();
    this.watchdog = this.scheduler.setTimeout(() => this.onInitBudgetExpired(), VOICE_INIT_BUDGET_MS);
    this.emit();
  }

  /**
   * Reads the backend's capabilities and lets the controller choose and check its input. Call it
   * when the backend connects and again when it connects or disconnects later. While the session is
   * still starting, an absent backend just keeps waiting (the budget decides).
   */
  public async initialize(): Promise<void> {
    if (this.disposed) return;
    const capabilities = this.deps.getCapabilities();
    if (capabilities === null && this.initializing) {
      this.emit();
      return;
    }
    await this.initializeWith(capabilities);
  }

  private async initializeWith(capabilities: Capabilities | null): Promise<void> {
    this.initializing = false;
    this.timedOut = false;
    this.clearWatchdog();
    try {
      await this.deps.controller.initialize(capabilities);
    } catch {
      // A broken probe must never strand the user: the controller already reports unavailable.
    }
    this.emit();
  }

  private onInitBudgetExpired(): void {
    this.watchdog = undefined;
    if (this.disposed || !this.initializing) return;
    this.initializing = false;
    this.timedOut = true;
    this.record(describeVoiceStatus({ phase: 'unavailable', cause: 'init_timeout', micState: 'unknown' }), 'init_timeout');
    this.emit();
  }

  // --- activation (Req 18) ------------------------------------------------------------------------

  /**
   * The voice-aware part of `kirosight.activate`. It opens or focuses the panel first and always,
   * then begins listening only when voice can be used. Whatever goes wrong with voice, this never
   * throws and never prevents the panel from opening.
   */
  public async activate(openPanel: () => void): Promise<void> {
    try {
      openPanel();
    } catch {
      // The panel failing is reported by whoever owns it; voice must not add a second failure.
    }
    try {
      await this.listenIfAllowed();
    } catch {
      // A voice failure never becomes an activation failure (Req 18.5).
    }
  }

  private async listenIfAllowed(): Promise<void> {
    if (this.disposed || this.initializing) return; // starting: the panel and typing already work

    if (this.timedOut || this.deps.controller.status.phase === 'unavailable') {
      // Granted later (Req 18.6): look again with the current capabilities instead of staying stuck.
      await this.initializeWith(this.probeCapabilities());
    }

    const status = this.deps.controller.status;
    switch (status.phase) {
      case 'unavailable':
        this.record(describeVoiceStatus(status), status.cause ?? 'no_input', true);
        return;
      case 'idle':
        if (status.micState === 'undetermined' || status.micState === 'unknown') {
          // Req 18.3: push-to-talk is the keyboard-operable permission request; typing is unaffected.
          this.recordGuidanceOnce(describeVoiceStatus(status));
          return;
        }
        // Granted, or denied or unplugged earlier: the backend re-checks on every start, so trying is
        // the only way to learn that access was granted since.
        await this.startListening();
        return;
      default:
        return; // already listening, processing or initializing
    }
  }

  /**
   * The capabilities to initialize with on a retry. A `denied` or `unavailable` microphone in the
   * handshake snapshot may have been fixed since, and the backend re-checks it on every
   * `record_start`, so a retry does not trust that one field.
   */
  private probeCapabilities(): Capabilities | null {
    const capabilities = this.deps.getCapabilities();
    if (capabilities !== null && capabilities.stt && (capabilities.mic === 'denied' || capabilities.mic === 'unavailable')) {
      return { ...capabilities, mic: 'available' };
    }
    return capabilities;
  }

  // --- push-to-talk (Req 9.1) -----------------------------------------------------------------------

  /** One press starts listening; the next ends it. Pressing while it is working or unavailable does nothing harmful. */
  public async togglePushToTalk(): Promise<void> {
    if (this.disposed || this.initializing) return;
    try {
      const status = this.deps.controller.status;
      switch (status.phase) {
        case 'listening':
          this.handleOutcome(await this.deps.controller.stopListening());
          return;
        case 'idle':
          await this.startListening();
          return;
        case 'unavailable':
          // Starts no capture; says why again, so the reason is never lost (design: PTT when unavailable).
          this.record(describeVoiceStatus(status), status.cause ?? 'no_input', true);
          return;
        default:
          return; // processing or initializing
      }
    } catch {
      this.recordFailure('internal');
    }
  }

  private async startListening(): Promise<void> {
    try {
      this.deps.onBeforeListening?.();
    } catch {
      // Interrupting other work must never keep the user from speaking.
    }
    const outcome = await this.deps.controller.startListening();
    if (outcome.status === 'failed') this.recordFailure(outcome.reason);
  }

  /** Escape or a new utterance: abandon any recording or pending transcription. Routes nothing. */
  public cancel(): void {
    if (this.disposed) return;
    this.deps.controller.cancel();
    this.emit();
  }

  /**
   * The backend-local input reports that the recording ended on its own before the user stopped it.
   * A failure (microphone denied or gone, connection lost) stops "Listening" at once and says why;
   * a finished result (the backend's 60 s cap) is left to the controller, which stops at the same time.
   */
  public notifyRecordingEnded(end: RecordingEnd): void {
    if (this.disposed || end.ok || this.deps.controller.status.phase !== 'listening') return;
    this.deps.controller.cancel();
    this.recordFailure(end.reason);
    this.emit();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearWatchdog();
    try {
      this.deps.controller.cancel();
    } catch {
      // Releasing the microphone must never throw out of dispose().
    }
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.listeners.clear();
  }

  // --- what the user is told --------------------------------------------------------------------------

  private handleOutcome(outcome: VoiceOutcome): void {
    if (this.disposed) return;
    if (outcome.status === 'failed') this.recordFailure(outcome.reason);
    this.emit();
  }

  private recordFailure(reason: VoiceFailure): void {
    // Nothing was routed. The Transcript says so right away (within 1 s), the typed draft is not
    // touched, and the controller is back to idle so push-to-talk stays enabled.
    this.append(describeVoiceFailure(reason));
  }

  private onControllerStatus(status: VoiceStatus): void {
    if (this.disposed) return;
    if (status.phase === 'idle' || status.phase === 'listening' || status.phase === 'processing') {
      this.recordedCause = null; // voice works again, so a later loss is news again
    } else if (status.phase === 'unavailable' && !this.initializing) {
      this.record(describeVoiceStatus(status), status.cause ?? 'no_input');
    }
    if (status.phase !== 'idle') this.recordedGuidance = false;
    this.emit();
  }

  /** Writes an unavailability entry; `force` repeats it (an explicit user action), otherwise once per cause. */
  private record(text: string, cause: VoiceUnavailableCause, force = false): void {
    if (!force && this.recordedCause === cause) return;
    this.recordedCause = cause;
    this.append(text);
  }

  private recordGuidanceOnce(text: string): void {
    if (this.recordedGuidance) return;
    this.recordedGuidance = true;
    this.append(text);
  }

  private append(text: string): void {
    this.deps.transcript.append('system', text);
  }

  // --- view ----------------------------------------------------------------------------------------------

  private buildView(): VoiceSessionView {
    if (this.initializing) {
      return { voice: { state: 'initializing', reasonText: STARTING_TEXT }, listening: false, statusKind: null };
    }
    if (this.timedOut) {
      const text = describeVoiceStatus({ phase: 'unavailable', cause: 'init_timeout', micState: 'unknown' });
      return { voice: { state: 'unavailable', reasonText: text }, listening: false, statusKind: 'voice_unavailable' };
    }

    const status = this.deps.controller.status;
    switch (status.phase) {
      case 'initializing':
        return { voice: { state: 'initializing', reasonText: STARTING_TEXT }, listening: false, statusKind: null };
      case 'listening':
        return { voice: { state: 'available', reasonText: status.text }, listening: true, statusKind: 'listening' };
      case 'processing':
        return { voice: { state: 'available', reasonText: status.text }, listening: false, statusKind: 'processing' };
      case 'unavailable':
        return { voice: { state: 'unavailable', reasonText: status.text }, listening: false, statusKind: 'voice_unavailable' };
      case 'idle':
        return { voice: { state: 'available', reasonText: idleReason(status) }, listening: false, statusKind: null };
    }
  }

  private emit(): void {
    if (this.disposed) return;
    const view = this.buildView();
    for (const listener of [...this.listeners]) {
      try {
        listener(view);
      } catch {
        // A listener must never break the session.
      }
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) this.scheduler.clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }
}

function idleReason(status: VoiceStatus): string {
  if (status.micState === 'denied') return DENIED_RETRY_TEXT;
  if (status.micState === 'unavailable') return UNAVAILABLE_RETRY_TEXT;
  return status.text;
}

/**
 * The status kind to show: voice only speaks up while the rest of the panel is idle, so a pending
 * confirmation, an error or an agent request is never hidden behind a voice label.
 */
export function resolveStatusKind(pipeline: StatusKind, view: VoiceSessionView): StatusKind {
  return pipeline === 'idle' && view.statusKind !== null ? view.statusKind : pipeline;
}
