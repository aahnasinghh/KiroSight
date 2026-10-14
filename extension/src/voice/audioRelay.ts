/**
 * Relays a webview recording to the backend as it arrives (Task 8.3; Req 9.1, 19.1, 19.3, 19.5).
 *
 * The webview sends a recording to the host as an ordered series of `audio_clip` bridge chunks
 * (`seq` from 0, `final` on the last). Every chunk the host receives is forwarded to the backend at
 * once, in the same call, as one `audio_clip` frame; nothing is held back until the recording
 * ends. Req 19.5 asks that relaying begin within 500 ms of receipt, so the deadline is measured per
 * chunk, from entry into `accept()` (host receipt) to the return of the backend send. Nothing
 * waits, queues or retries, so the relay adds only validation time.
 *
 * Backend frames of one recording share an id (`voice-N`, assigned when the first frame is sent)
 * and carry a contiguous `seq` from 0. `final: true` marks the last frame, which may have an empty
 * `base64` when the recording ended on a bare marker.
 *
 * Bounds, so a misbehaving page can never use unbounded memory or build an oversized frame:
 * - at most `MAX_CHUNK_BASE64_CHARS` (1 MB) per chunk, which keeps each frame under the backend's
 *   2 MiB message limit;
 * - at most `MAX_CLIP_BYTES` and `MAX_CHUNKS` per recording, which bound what the backend must hold;
 * - strictly in-order chunks of one recording at a time.
 * The relay itself keeps no audio at all.
 *
 * When a recording is abandoned part-way (rejected chunk, a new recording superseding it, a cancel)
 * after frames were sent, the backend is sent a protocol `cancel` for that id so it discards the
 * partial recording. It never logs audio, holds no credential, and sends nothing when the backend
 * is unreachable: audio is not queued for later (Req 19.9). It does not start or stop a capture.
 */

/** A bridge chunk, as validated by the closed webview-to-host message set. */
export interface AudioChunk {
  readonly clipId: string;
  readonly mimeType: string;
  readonly base64: string;
  readonly seq?: number | undefined;
  readonly final?: boolean | undefined;
}

/** One backend `audio_clip` frame. `seq` and `final` always travel together. */
export interface AudioFrame {
  readonly id: string;
  readonly mimeType: string;
  readonly base64: string;
  readonly seq: number;
  readonly final: boolean;
}

export interface AudioClipSender {
  /** BackendClient satisfies this. Returns false, having sent nothing, when it cannot send. */
  sendAudioClip(frame: AudioFrame): boolean;
  /** Tells the backend to discard a partly sent recording. Returns false when it cannot send. */
  cancelAudioClip(id: string): boolean;
}

/** Req 19.9: said to the user when a recording cannot be relayed. */
export const AUDIO_BACKEND_UNAVAILABLE_TEXT =
  "I can't reach the KiroSight backend, so I can't send your recording. You can type the same request.";

/** "Chunked above 1 MB": no single bridge chunk carries more than this many base64 characters. */
export const MAX_CHUNK_BASE64_CHARS = 1_000_000;

/** Req 19.5: relaying a received chunk must begin within this many milliseconds of receipt. */
export const RELAY_DEADLINE_MS = 500;

/**
 * The most audio one recording may hold. It is no longer a single-frame limit (each frame is
 * bounded by the chunk cap); it bounds what the backend has to hold for one recording. A 60 s Opus
 * recording is a small fraction of this.
 */
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;

export const MAX_CHUNKS = 2_000;
const MAX_MIME_CHARS = 100;
const AUDIO_MIME = /^audio\/[A-Za-z0-9.+-]+(?:;\s*[A-Za-z0-9=.+\-" ,]+)*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type RelayRejection =
  | 'bad_chunk'
  | 'bad_mime'
  | 'out_of_order'
  | 'too_large'
  | 'empty';

export type RelayOutcome =
  /** An empty chunk that is not the last one: nothing to forward. */
  | { readonly status: 'skipped' }
  /** A repeat of a chunk already accepted; ignored. */
  | { readonly status: 'duplicate' }
  /**
   * The chunk was sent to the backend as frame `seq` of recording `backendClipId`. `latencyMs` is
   * host receipt to the return of the send; `late` is true when it exceeded `RELAY_DEADLINE_MS`.
   */
  | {
    readonly status: 'relayed';
    readonly backendClipId: string;
    readonly seq: number;
    readonly final: boolean;
    readonly latencyMs: number;
    readonly late: boolean;
  }
  /** The backend could not be reached. Nothing was sent or kept; the recording is dropped. */
  | { readonly status: 'unavailable' }
  /** The recording was dropped, with the reason. */
  | { readonly status: 'rejected'; readonly reason: RelayRejection };

interface Assembly {
  readonly clipId: string;
  readonly mimeType: string;
  /** Source chunks accepted so far; the next expected inbound seq. */
  nextSeq: number;
  bytes: number;
  /** Set when the first frame is sent; null until then. */
  backendClipId: string | null;
  /** Frames sent so far, which is the next outbound seq. */
  framesSent: number;
}

function decodedLength(base64: string): number | null {
  if (base64.length > MAX_CHUNK_BASE64_CHARS || base64.length % 4 !== 0 || !BASE64.test(base64)) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export class AudioRelay {
  private assembly: Assembly | null = null;
  private recordingCount = 0;

  public constructor(
    private readonly sender: AudioClipSender,
    /** Told, once per unreachable recording, with a plain sentence for the webview (Req 19.9). */
    private readonly onUnavailable?: (message: string) => void,
    /** Milliseconds, monotonic. Injectable so tests can control time. */
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Accepts and forwards one chunk. Never throws. */
  public accept(chunk: AudioChunk): RelayOutcome {
    const receivedAt = this.now();
    try {
      return this.acceptChunk(chunk, receivedAt);
    } catch {
      this.abort();
      return { status: 'rejected', reason: 'bad_chunk' };
    }
  }

  /** Abandons any partly sent recording (a cancelled capture, a closed panel) at the backend too. */
  public reset(): void {
    this.abort();
  }

  /** Drops the current recording; if frames were already sent, the backend is told to discard them. */
  private abort(): void {
    const current = this.assembly;
    this.assembly = null;
    if (current === null || current.backendClipId === null) return;
    try {
      this.sender.cancelAudioClip(current.backendClipId);
    } catch {
      // Cancelling must never throw out of the relay.
    }
  }

  private reject(reason: RelayRejection): RelayOutcome {
    this.abort();
    return { status: 'rejected', reason };
  }

  private acceptChunk(chunk: AudioChunk, receivedAt: number): RelayOutcome {
    if (typeof chunk.mimeType !== 'string' || chunk.mimeType.length > MAX_MIME_CHARS || !AUDIO_MIME.test(chunk.mimeType)) {
      return this.reject('bad_mime');
    }
    const seq = chunk.seq ?? 0;
    const final = chunk.final ?? chunk.seq === undefined;
    if (!Number.isSafeInteger(seq) || seq < 0) return this.reject('bad_chunk');

    const current = this.assembly;
    if (current === null || current.clipId !== chunk.clipId) {
      // A different recording starts at seq 0 and supersedes any partial one. Anything else is a
      // stray or reordered chunk.
      if (seq !== 0) return this.reject('out_of_order');
      this.abort();
      this.assembly = {
        clipId: chunk.clipId,
        mimeType: chunk.mimeType,
        nextSeq: 0,
        bytes: 0,
        backendClipId: null,
        framesSent: 0,
      };
    } else if (seq < current.nextSeq) {
      return { status: 'duplicate' };
    } else if (seq > current.nextSeq) {
      return this.reject('out_of_order');
    }

    const assembly = this.assembly!;
    const length = decodedLength(chunk.base64);
    if (length === null) {
      return this.reject(chunk.base64.length > MAX_CHUNK_BASE64_CHARS ? 'too_large' : 'bad_chunk');
    }
    assembly.bytes += length;
    if (assembly.bytes > MAX_CLIP_BYTES || assembly.nextSeq >= MAX_CHUNKS) return this.reject('too_large');
    assembly.nextSeq = seq + 1;

    if (length === 0 && !final) return { status: 'skipped' };
    if (length === 0 && assembly.framesSent === 0) {
      // A bare final marker with nothing before it: there is no audio to transcribe.
      this.assembly = null;
      return { status: 'rejected', reason: 'empty' };
    }
    return this.forward(assembly, chunk, final, receivedAt);
  }

  private forward(assembly: Assembly, chunk: AudioChunk, final: boolean, receivedAt: number): RelayOutcome {
    if (assembly.backendClipId === null) {
      this.recordingCount += 1;
      assembly.backendClipId = `voice-${this.recordingCount}`;
    }
    const backendClipId = assembly.backendClipId;
    const frameSeq = assembly.framesSent;

    const sent = this.sender.sendAudioClip({
      id: backendClipId,
      mimeType: assembly.mimeType,
      base64: chunk.base64,
      seq: frameSeq,
      final,
    });
    if (!sent) {
      this.assembly = null;
      try {
        this.onUnavailable?.(AUDIO_BACKEND_UNAVAILABLE_TEXT);
      } catch {
        // A notice observer must never break the relay.
      }
      return { status: 'unavailable' };
    }
    const latencyMs = this.now() - receivedAt;
    assembly.framesSent += 1;
    if (final) this.assembly = null;
    return {
      status: 'relayed',
      backendClipId,
      seq: frameSeq,
      final,
      latencyMs,
      late: latencyMs > RELAY_DEADLINE_MS,
    };
  }
}
