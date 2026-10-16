import {
  realScheduler,
  type BackendEvent,
  type ConnectionState,
  type Disposable,
  type Scheduler,
  type TimerHandle,
} from '../backend/backendClient';
import type { Capabilities } from '../protocol/messages';
import type { TranscriptEntry, TranscriptStore } from '../transcript/transcriptStore';
import type { PendingConfirmationView } from '../webview/viewModel';

/**
 * Speaks KiroSight's answers aloud, after their text is already in the Transcript (Task 9.3;
 * Req 6.3, 9.4, 9.5, 10.2, 13.4, 15.3). Nothing here knows about VS Code, so it is unit-testable on
 * fakes, and constructing it sends nothing, starts no timer and opens no panel.
 *
 * What it does, and what it deliberately does not:
 *
 * - TEXT FIRST. It is handed a TranscriptEntry that was already appended, and it checks that the
 *   entry is really in the Transcript before it asks for speech. It never appends, delays, changes
 *   or replaces a response. The only thing it ever appends is a separate system notice.
 * - One `speech_request` per spoken text, with its own id (`speech-N`). The matching `speech_audio`
 *   is forwarded to the panel as `play_audio` with the same id, MIME type and data. Anything that
 *   does not match a request still waiting for its audio (unsolicited, duplicate, stale, late) is
 *   dropped without effect.
 * - DEADLINE. Playback must begin within 10 s of the request being sent (the response being
 *   produced). Synthesis succeeding does not prove playback started: only the panel's `started`
 *   acknowledgment (`handlePlayback`) clears the deadline. The player itself is Task 9.4.
 * - FAILURE. A speech error, an unusable clip, a failed hand-over to the panel, a lost backend, a
 *   failed playback or a missed deadline each add ONE plain-text system entry saying spoken playback
 *   is unavailable, at the moment the failure is detected (well inside 1 s). The response text is
 *   untouched, typed input is unaffected, and one request never produces two notices.
 * - It cannot approve or run anything. It takes text and sends text; spoken words are never read
 *   back as commands here, and a spoken confirmation prompt changes no confirmation state.
 *
 * Not here (later tasks): playing the audio (9.4); interruption, `stop_audio` and the stop command
 * (9.5); constructing this in `extension.ts` and routing responses to it (9.7).
 */

/** Req 9.5 / 10.2: playback must begin within 10 s of the response being produced. */
export const PLAYBACK_START_TIMEOUT_MS = 10_000;

/** The backend's per-request text limit. Longer text is not truncated (a clipped answer misleads). */
export const MAX_SPEECH_REQUEST_CHARS = 2000;

/** Requests tracked at once. A new one is refused (with a note) rather than abandoning a waiting one. */
export const MAX_TRACKED_SPEECH = 16;

/** The separate Transcript entry added when spoken playback could not happen (design F3). */
export const SPEECH_UNAVAILABLE_TEXT = 'Spoken playback is unavailable. The response is in the transcript.';

const AUDIO_MIME = /^audio\/[A-Za-z0-9.+-]{1,60}$/;

/** How many recent spoken texts are remembered so a prompt already spoken is not spoken twice. */
const RECENT_TEXTS = 3;

/** The slice of BackendClient the controller uses. BackendClient satisfies it structurally. */
export interface SpeechClient {
  readonly state: ConnectionState;
  readonly capabilities: Capabilities | null;
  sendSpeechRequest(request: { readonly id: string; readonly text: string }): boolean;
  cancelSpeechRequest(id: string): boolean;
  onEvent(listener: (event: BackendEvent) => void): Disposable;
  onStateChange(listener: (state: ConnectionState) => void): Disposable;
}

/** The slice of WebviewProvider the controller uses. */
export interface SpeechPanelPort {
  /**
   * Hands the panel one clip to play. False when no panel could take it right now. Delivery can
   * still fail afterwards (the webview rejects or drops the message): `onUndelivered` is called, at
   * most once, as soon as that is known.
   */
  sendPlayAudio(
    audio: { readonly id: string; readonly mimeType: string; readonly base64: string },
    onUndelivered?: () => void,
  ): boolean;
}

export interface SpeechControllerDeps {
  readonly client: SpeechClient;
  readonly panel: SpeechPanelPort;
  /** Read-only here: entries are appended by the pipeline; only the failure notice is appended. */
  readonly transcript: Pick<TranscriptStore, 'append' | 'getEntries'>;
  /** True when speech output is wanted right now (voice enabled, not switched off). */
  readonly isSpeechActive: () => boolean;
  /** The confirmation prompt currently pending, or null (ConfirmationController.pendingConfirmation). */
  readonly getPendingConfirmation: () => PendingConfirmationView | null;
  /** Told after the controller appends a notice, so the view can be republished. */
  readonly onTranscriptChanged?: () => void;
  readonly scheduler?: Scheduler;
}

/** The panel's playback acknowledgment (`playback` bridge message), without its sender. */
export type PlaybackState = 'started' | 'ended' | 'failed';

type Phase = 'awaiting_audio' | 'awaiting_start' | 'playing';

interface Tracked {
  phase: Phase;
  /** The 10 s start deadline; undefined once playback has started. */
  timer: TimerHandle | undefined;
}

export class SpeechController implements Disposable {
  private readonly scheduler: Scheduler;
  private readonly tracked = new Map<string, Tracked>();
  private readonly subscriptions: Disposable[] = [];
  private readonly recentTexts: string[] = [];
  private counter = 0;
  private highestSeq = 0;
  private lastPromptKey: string | null = null;
  /** True once the "backend has no text-to-speech" note was added for the current outage. */
  private ttsNoticed = false;
  private disposed = false;

  public constructor(private readonly deps: SpeechControllerDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.subscriptions.push(
      deps.client.onEvent((event) => this.onEvent(event)),
      deps.client.onStateChange((state) => this.onConnectionState(state)),
    );
  }

  /**
   * Speaks a KiroSight response that is already in the Transcript. Only `kirosight` entries are
   * spoken (the user's own words and system notices never are), each entry at most once, and never
   * an entry older than one already handled, so turning speech on does not replay history. A Bedrock
   * error is such an entry and is spoken like any other answer.
   */
  public speakResponse(entry: TranscriptEntry): void {
    if (this.disposed || entry.role !== 'kirosight') return;
    if (!this.inTranscript(entry)) return; // text first: never speak what is not shown
    if (entry.seq <= this.highestSeq) return;
    this.highestSeq = entry.seq;
    this.request(entry.text);
  }

  /**
   * Speaks the pending confirmation prompt, exactly as the panel shows it (action name, target and
   * change are all in the stored prompt). Speaks each pending request once: republishing the same
   * request does not repeat it, and a prompt whose text a spoken response already carried is not
   * spoken again. Changes no confirmation state.
   */
  public speakPendingConfirmation(): void {
    if (this.disposed) return;
    const pending = this.safePending();
    if (pending === null) {
      this.lastPromptKey = null;
      return;
    }
    if (pending.presentationKey === this.lastPromptKey) return;
    this.lastPromptKey = pending.presentationKey;
    if (this.recentTexts.some((spoken) => spoken.includes(pending.promptText))) return;
    this.request(pending.promptText);
  }

  /**
   * REPEAT_CONFIRMATION: speaks the pending prompt again, the stored text and not a rewrite, every
   * time it is asked. Does nothing when nothing is pending. The request stays pending and unchanged.
   */
  public repeatConfirmation(): void {
    if (this.disposed) return;
    const pending = this.safePending();
    if (pending === null) return;
    this.lastPromptKey = pending.presentationKey;
    this.request(pending.promptText);
  }

  /**
   * The panel's playback acknowledgment for clip `id` (Task 9.4 will send it). Only `started` is
   * evidence that playback began, so only `started` clears the deadline and makes the clip a
   * success; `ended` finishes a clip that has started and is otherwise ignored (the deadline still
   * decides). `failed` is a failure. Repeats, and acknowledgments for unknown, finished, forgotten
   * or timed-out ids, change nothing and never add a second note.
   */
  public handlePlayback(state: PlaybackState, id: string): void {
    if (this.disposed) return;
    const tracked = this.tracked.get(id);
    if (tracked === undefined) return;
    switch (state) {
      case 'started':
        if (tracked.phase !== 'awaiting_start') return; // nothing was handed over, or already started
        this.clearTimer(tracked);
        tracked.phase = 'playing';
        return;
      case 'ended':
        if (tracked.phase !== 'playing') return; // no evidence that it ever started
        this.forget(id);
        return;
      case 'failed':
        if (tracked.phase === 'awaiting_audio') return; // nothing was sent to play
        this.fail(id, false);
        return;
    }
  }

  /** Stops every timer and subscription and forgets everything. Adds no notice, sends no audio. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const [id, tracked] of [...this.tracked]) {
      this.clearTimer(tracked);
      if (tracked.phase === 'awaiting_audio') this.cancelBackend(id);
    }
    this.tracked.clear();
    this.recentTexts.length = 0;
  }

  // --- requesting speech ---

  private request(text: string): void {
    if (!this.speechActive()) return;
    if (text.trim() === '') return;

    if (!this.ttsAvailable()) {
      this.noteTtsUnavailable();
      return;
    }
    this.ttsNoticed = false; // speech works again: a later outage is a new episode

    if (text.length > MAX_SPEECH_REQUEST_CHARS) {
      this.notice(); // too long to speak; the text is complete in the Transcript
      return;
    }

    if (!this.makeRoom()) {
      this.notice(); // every slot is waiting on audio or a start: refuse this one, abandon none
      return;
    }
    const id = `speech-${(this.counter += 1)}`;
    // Registered before sending, so even a synchronous answer finds its request.
    const tracked: Tracked = { phase: 'awaiting_audio', timer: undefined };
    tracked.timer = this.scheduler.setTimeout(() => this.onDeadline(id), PLAYBACK_START_TIMEOUT_MS);
    this.tracked.set(id, tracked);
    this.remember(text);

    let sent = false;
    try {
      sent = this.deps.client.sendSpeechRequest({ id, text });
    } catch {
      sent = false;
    }
    if (!sent) this.fail(id, false);
  }

  /**
   * Speech is wanted but cannot be produced. Two cases, decided from what the backend reported:
   *
   * - No backend (not connected, or no capabilities yet): silent here. The voice layer already
   *   tells the user in the Transcript that the backend is not connected (VoiceController
   *   `no_backend`), and the panel status says it too. Adding a note for every response would
   *   only repeat it.
   * - A connected backend that reported `tts: false` (no Deepgram credential, say): nothing else
   *   says that spoken output is off, since the voice layer only checks speech-to-text. One note
   *   is added for the outage, not one per response, and it is added again only after speech
   *   has worked in between.
   */
  private noteTtsUnavailable(): void {
    const { client } = this.deps;
    const reported = client.state === 'connected' && client.capabilities !== null && !client.capabilities.tts;
    if (!reported || this.ttsNoticed) return;
    this.ttsNoticed = true;
    this.notice();
  }

  private speechActive(): boolean {
    try {
      return this.deps.isSpeechActive();
    } catch {
      return false;
    }
  }

  /** Speech is requested only over a completed handshake whose backend reported text-to-speech. */
  private ttsAvailable(): boolean {
    const { client } = this.deps;
    return client.state === 'connected' && client.capabilities?.tts === true;
  }

  private safePending(): PendingConfirmationView | null {
    try {
      return this.deps.getPendingConfirmation();
    } catch {
      return null;
    }
  }

  private inTranscript(entry: TranscriptEntry): boolean {
    try {
      return this.deps.transcript.getEntries().some((e) => e.seq === entry.seq && e.text === entry.text);
    } catch {
      return false;
    }
  }

  private remember(text: string): void {
    this.recentTexts.push(text);
    while (this.recentTexts.length > RECENT_TEXTS) this.recentTexts.shift();
  }

  // --- what the backend sent ---

  private onEvent(event: BackendEvent): void {
    if (this.disposed) return;
    try {
      if (event.type === 'speech_audio') {
        this.onAudio(event.replyTo, event.mimeType, event.base64);
      } else if (event.type === 'error_message' && event.replyTo !== undefined) {
        const tracked = this.tracked.get(event.replyTo);
        // The backend has already ended this request: no cancel is needed. Only a request still
        // waiting for audio can fail this way; errors for anything else are not ours.
        if (tracked?.phase === 'awaiting_audio') this.fail(event.replyTo, false);
      }
    } catch {
      // A listener must never throw into the client, and a bug here must never cost a response.
    }
  }

  private onAudio(id: string, mimeType: string, base64: string): void {
    const tracked = this.tracked.get(id);
    // Unsolicited, duplicate, stale (timed out, cancelled) and late clips match no waiting request.
    if (tracked === undefined || tracked.phase !== 'awaiting_audio') return;

    if (!AUDIO_MIME.test(mimeType) || base64 === '') {
      this.fail(id, false);
      return;
    }

    tracked.phase = 'awaiting_start'; // set first: hand-over is not allowed to run twice
    let handedOver = false;
    try {
      handedOver = this.deps.panel.sendPlayAudio({ id, mimeType, base64 }, () => this.onUndelivered(id));
    } catch {
      handedOver = false;
    }
    if (!handedOver) this.fail(id, false);
  }

  /** The panel could not take a clip after all. A clip that already started, or ended, is not affected. */
  private onUndelivered(id: string): void {
    if (this.disposed) return;
    if (this.tracked.get(id)?.phase === 'awaiting_start') this.fail(id, false);
  }

  private onConnectionState(state: ConnectionState): void {
    if (this.disposed || state === 'connected' || state === 'connecting') return;
    // The backend is gone: requests still waiting for audio will never get it. Clips already
    // handed to the panel keep their own deadline and acknowledgments. One notice covers them all.
    const waiting = [...this.tracked].filter(([, tracked]) => tracked.phase === 'awaiting_audio');
    if (waiting.length === 0) return;
    for (const [id] of waiting) this.forget(id);
    this.notice();
  }

  // --- deadline, failure, bookkeeping ---

  private onDeadline(id: string): void {
    if (this.disposed) return;
    const tracked = this.tracked.get(id);
    if (tracked === undefined) return;
    tracked.timer = undefined; // it has fired
    // Still waiting for audio: tell the backend to stop. Otherwise the clip was handed over but
    // never started, so there is nothing to cancel there.
    this.fail(id, tracked.phase === 'awaiting_audio');
  }

  /** Ends request `id` as failed: forgets it and adds one notice. A request already ended adds none. */
  private fail(id: string, cancelBackend: boolean): void {
    const tracked = this.tracked.get(id);
    if (tracked === undefined) return;
    this.forget(id);
    if (cancelBackend) this.cancelBackend(id);
    this.notice();
  }

  private forget(id: string): void {
    const tracked = this.tracked.get(id);
    if (tracked === undefined) return;
    this.clearTimer(tracked);
    this.tracked.delete(id);
  }

  private clearTimer(tracked: Tracked): void {
    if (tracked.timer !== undefined) {
      this.scheduler.clearTimeout(tracked.timer);
      tracked.timer = undefined;
    }
  }

  private cancelBackend(id: string): void {
    try {
      this.deps.client.cancelSpeechRequest(id);
    } catch {
      // The request is already abandoned here; a failed cancel changes nothing.
    }
  }

  /**
   * True when there is a free slot. At the limit, only a clip that has already started is
   * forgotten (it succeeded; only its `ended` report is lost). A request still waiting for audio or
   * for playback to start is never abandoned: it has its own deadline and note, so the new request
   * is the one refused.
   */
  private makeRoom(): boolean {
    if (this.tracked.size < MAX_TRACKED_SPEECH) return true;
    for (const [id, tracked] of this.tracked) {
      if (tracked.phase === 'playing') {
        this.forget(id);
        return true;
      }
    }
    return false;
  }

  /** The separate, plain-text entry. Appended at detection time; never replaces a response. */
  private notice(): void {
    try {
      this.deps.transcript.append('system', SPEECH_UNAVAILABLE_TEXT);
    } catch {
      return;
    }
    try {
      this.deps.onTranscriptChanged?.();
    } catch {
      // A view refresh failing must not matter here.
    }
  }
}