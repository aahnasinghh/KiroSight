'use strict';

const { decodeBase64, evaluate } = require('./evaluate');

/**
 * Host-side bookkeeping for one capture attempt: it timestamps the webview's messages with the
 * HOST clock (so a slow webview cannot vouch for itself), accepts only the four known message
 * types, and judges the attempt when the final clip arrives. THROWAWAY.
 */
const KNOWN_TYPES = new Set(['mic_state', 'capture_start', 'first_sample', 'audio_clip']);
/** A clip larger than this is refused outright (the spike records about 4 seconds). */
const MAX_CLIP_BASE64_CHARS = 8 * 1024 * 1024;

class CaptureSession {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.micState = 'unavailable';
    this.startedAt = null;
    this.firstSampleAt = null;
    this.firstSampleBytes = null;
    this.ignored = 0;
  }

  /** Returns the judged result when `message` is the final clip, otherwise null. */
  handle(message) {
    if (typeof message !== 'object' || message === null || !KNOWN_TYPES.has(message.type)) {
      this.ignored += 1;
      return null;
    }
    switch (message.type) {
      case 'mic_state':
        // A later report wins, except that "granted" is never downgraded by a stale query.
        if (this.micState !== 'granted' || message.state === 'denied') this.micState = message.state;
        return null;
      case 'capture_start':
        this.startedAt = this.now();
        return null;
      case 'first_sample':
        if (this.startedAt !== null && this.firstSampleAt === null) {
          this.firstSampleAt = this.now();
          this.firstSampleBytes = typeof message.bytes === 'number' ? message.bytes : 0;
        }
        return null;
      case 'audio_clip': {
        const base64 = typeof message.base64 === 'string' && message.base64.length <= MAX_CLIP_BASE64_CHARS
          ? message.base64
          : '';
        const result = evaluate({
          micState: this.micState,
          firstSampleElapsedMs: this.startedAt === null || this.firstSampleAt === null
            ? null
            : this.firstSampleAt - this.startedAt,
          firstSampleBytes: this.firstSampleBytes,
          clipBase64: base64,
        });
        return { ...result, clip: decodeBase64(base64), mimeType: String(message.mimeType || ''), micState: this.micState };
      }
    }
    return null;
  }
}

module.exports = { CaptureSession, KNOWN_TYPES, MAX_CLIP_BASE64_CHARS };
