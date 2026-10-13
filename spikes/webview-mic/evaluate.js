'use strict';

/**
 * Spike D (Task 8.1): host-side judgement of one microphone capture attempt in a webview.
 *
 * Pure functions only, so the pass criterion can be checked without Kiro, a microphone or a
 * webview. THROWAWAY: the production VoiceController (Task 8.2) is written separately.
 *
 * Pass criterion (tasks.md 8.1): the host receives at least one audio sample of non-zero length
 * within 5 seconds of the webview starting capture, and the bytes play back correctly. Webview
 * capture counts as unreliable if permission is denied, capture is unavailable, or the first
 * sample does not arrive within 5 seconds.
 */

const FIRST_SAMPLE_BUDGET_MS = 5000;

/** The microphone states the webview may report. Anything else is treated as unavailable. */
const MIC_STATES = ['granted', 'denied', 'unavailable', 'prompt'];

/** Strict base64: the webview sends standard base64 only. Returns null when it is not valid. */
function decodeBase64(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === 0 ? null : bytes;
}

/**
 * Names the audio container from its first bytes, or null. A recognised container proves the
 * bytes are a real recording and not text or noise; it does not prove they play. Playback is
 * confirmed by listening to the file the host writes (see result.playbackNeedsHumanConfirmation).
 */
function sniffContainer(bytes) {
  const startsWith = (offset, ...values) => values.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 4 && startsWith(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'webm';
  if (bytes.length >= 4 && startsWith(0, 0x4f, 0x67, 0x67, 0x53)) return 'ogg';
  if (bytes.length >= 12 && startsWith(4, 0x66, 0x74, 0x79, 0x70)) return 'mp4';
  if (bytes.length >= 12 && startsWith(0, 0x52, 0x49, 0x46, 0x46) && startsWith(8, 0x57, 0x41, 0x56, 0x45)) return 'wav';
  return null;
}

/**
 * @param {{
 *   micState: unknown,
 *   firstSampleElapsedMs: number | null,
 *   firstSampleBytes: number | null,
 *   clipBase64: unknown,
 * }} attempt
 * @returns {{ verdict: 'PASS' | 'FALLBACK', reasons: string[], container: string | null,
 *             clipBytes: number, playbackNeedsHumanConfirmation: boolean }}
 */
function evaluate(attempt) {
  const reasons = [];
  const micState = MIC_STATES.includes(attempt.micState) ? attempt.micState : 'unavailable';

  if (micState === 'denied') reasons.push('microphone permission was denied');
  if (micState === 'unavailable') reasons.push('microphone capture is unavailable');
  if (micState === 'prompt') reasons.push('permission was never granted (still prompting)');

  const elapsed = attempt.firstSampleElapsedMs;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0) {
    reasons.push('no first audio sample reached the host');
  } else if (elapsed > FIRST_SAMPLE_BUDGET_MS) {
    reasons.push(`the first sample took ${Math.round(elapsed)} ms (budget ${FIRST_SAMPLE_BUDGET_MS} ms)`);
  }

  if (!(typeof attempt.firstSampleBytes === 'number' && attempt.firstSampleBytes > 0)) {
    reasons.push('the first sample had zero length');
  }

  const clip = decodeBase64(attempt.clipBase64);
  const container = clip === null ? null : sniffContainer(clip);
  if (clip === null) {
    reasons.push('the final clip is missing, empty or not valid base64');
  } else if (container === null) {
    reasons.push('the final clip is not a recognised audio container');
  }

  const passed = reasons.length === 0;
  return {
    verdict: passed ? 'PASS' : 'FALLBACK',
    reasons,
    container,
    clipBytes: clip === null ? 0 : clip.length,
    // The host cannot hear. A person must play the saved file before the PASS is recorded.
    playbackNeedsHumanConfirmation: passed,
  };
}

module.exports = { FIRST_SAMPLE_BUDGET_MS, MIC_STATES, decodeBase64, sniffContainer, evaluate };
