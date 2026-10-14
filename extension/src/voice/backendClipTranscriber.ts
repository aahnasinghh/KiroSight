import type { BackendEvent, ConnectionState, Disposable } from '../backend/backendClient';
import { transcriptionFailureFor } from './backendLocalVoiceInput';
import type { TranscriptionOutcome, VoiceClip, VoiceTranscriber } from './voiceInput';

/**
 * Turns the backend's answer for a recording the host already relayed into text (Task 8.9; Req 9.2,
 * 9.3, 19.7). `WebviewVoiceInput` relays a recording to the backend as `voice-N` frames and resolves
 * `stop()` to `{ backendClipId }`; this class waits for the one `transcription_result` or
 * `error_message` whose `replyTo` is that id, and hands the outcome to `VoiceController`. The
 * controller then gives non-empty text to `InputPipeline.handle(text, 'voice')`, so spoken text takes
 * exactly the same path as typed text. Nothing here routes, executes or interprets the text.
 *
 * - It listens from construction (a plain event listener, no I/O) so a reply that arrives before
 *   `transcribe()` is called is not lost. Only ids accepted by `isClipId` are kept, and at most
 *   `MAX_BUFFERED_RESULTS` of them, so unrelated replies (agent answers, backend-local recordings)
 *   are never stored and memory stays bounded.
 * - Only the first reply for an id counts. A reply for any other id never settles the clip being
 *   waited for, and ids are never reused, so a late or duplicate reply cannot reach a later clip.
 * - It waits indefinitely on its own: the controller applies the 10 s speech-to-text limit and then
 *   calls `cancel()`. A lost connection settles the wait at once.
 * - `dispose()` removes every listener and settles any wait. Nothing is logged: no text, no id.
 */

export const MAX_BUFFERED_RESULTS = 8;

/** Ids that `AudioRelay` gives to webview recordings. Backend-local recordings use `rec-N`. */
export const WEBVIEW_CLIP_ID_PREFIX = 'voice-';

export interface ClipClient {
  readonly state: ConnectionState;
  onEvent(listener: (event: BackendEvent) => void): Disposable;
  onStateChange(listener: (state: ConnectionState) => void): Disposable;
}

const ABANDONED: TranscriptionOutcome = { ok: false, reason: 'timeout' };

interface Pending {
  readonly id: string;
  readonly resolve: (outcome: TranscriptionOutcome) => void;
}

export class BackendClipTranscriber implements VoiceTranscriber, Disposable {
  private readonly results = new Map<string, TranscriptionOutcome>();
  /** Ids the controller gave up on; a reply that arrives for one later is dropped, never kept. */
  private readonly abandoned = new Set<string>();
  private readonly subscriptions: Disposable[];
  private pending: Pending | null = null;
  private disposed = false;

  public constructor(
    private readonly client: ClipClient,
    private readonly isClipId: (id: string) => boolean = (id) => id.startsWith(WEBVIEW_CLIP_ID_PREFIX),
  ) {
    this.subscriptions = [
      client.onEvent((event) => this.onEvent(event)),
      client.onStateChange((state) => this.onState(state)),
    ];
  }

  public transcribe(clip: VoiceClip): Promise<TranscriptionOutcome> {
    // Uploading audio is the relay's job; this class never sends bytes anywhere.
    if (this.disposed || clip instanceof Uint8Array || !this.isClipId(clip.backendClipId)) {
      return Promise.resolve({ ok: false, reason: 'stt_unavailable' });
    }
    this.settlePending(ABANDONED); // one clip at a time: an earlier wait is over

    const id = clip.backendClipId;
    const early = this.results.get(id);
    if (early !== undefined) {
      this.results.delete(id);
      return Promise.resolve(early);
    }
    if (this.client.state !== 'connected') {
      return Promise.resolve({ ok: false, reason: 'backend_unavailable' });
    }
    return new Promise<TranscriptionOutcome>((resolve) => {
      this.pending = { id, resolve };
    });
  }

  /** The controller gave up (its limit, a cancel or dispose). A reply that comes later is ignored. */
  public cancel(): void {
    const waiting = this.pending;
    this.settlePending(ABANDONED);
    if (waiting === null) return;
    this.results.delete(waiting.id);
    this.abandoned.add(waiting.id);
    while (this.abandoned.size > MAX_BUFFERED_RESULTS) {
      const oldest = this.abandoned.values().next().value;
      if (oldest === undefined) break;
      this.abandoned.delete(oldest);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settlePending(ABANDONED);
    this.results.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private onEvent(event: BackendEvent): void {
    let id: string;
    let outcome: TranscriptionOutcome;
    if (event.type === 'transcription_result') {
      id = event.replyTo;
      outcome = { ok: true, text: event.text };
    } else if (event.type === 'error_message' && event.replyTo !== undefined) {
      id = event.replyTo;
      outcome = { ok: false, reason: transcriptionFailureFor(event.code) };
    } else {
      return;
    }
    if (!this.isClipId(id)) return;
    if (this.abandoned.delete(id)) return; // the controller gave up on this clip: a late reply is stale

    if (this.pending !== null && this.pending.id === id) {
      this.settlePending(outcome);
      return;
    }
    if (this.results.has(id)) return; // a repeated reply: the first one counts
    this.results.set(id, outcome);
    while (this.results.size > MAX_BUFFERED_RESULTS) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }

  private onState(state: ConnectionState): void {
    if (state === 'connected') return;
    // The backend drops a recording when its connection closes, so nothing more will arrive.
    this.results.clear();
    this.abandoned.clear(); // nothing more can arrive for any earlier clip
    this.settlePending({ ok: false, reason: 'backend_unavailable' });
  }

  private settlePending(outcome: TranscriptionOutcome): void {
    const waiting = this.pending;
    this.pending = null;
    waiting?.resolve(outcome);
  }
}

/**
 * One transcriber for `VoiceController`, which takes exactly one: a clip the backend-local input
 * recorded goes to that input, every other clip (a relayed webview recording) to `clips`.
 */
export function routeTranscriptions(
  local: { owns(clip: VoiceClip): boolean; readonly transcriber: VoiceTranscriber },
  clips: VoiceTranscriber,
): VoiceTranscriber {
  return {
    transcribe: (clip) => (local.owns(clip) ? local.transcriber : clips).transcribe(clip),
    cancel: () => {
      local.transcriber.cancel?.();
      clips.cancel?.();
    },
  };
}
