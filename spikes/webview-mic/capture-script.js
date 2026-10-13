/* Spike D webview script (Task 8.1). THROWAWAY. Runs inside the webview, with no network access.
 *
 * It asks for the microphone only when the user presses the button, records about 4 seconds with
 * MediaRecorder, and reports to the extension host through postMessage only:
 *   mic_state     { state: 'granted' | 'denied' | 'unavailable' | 'prompt' }
 *   capture_start {}                                  (recording has begun)
 *   first_sample  { bytes }                           (first non-empty dataavailable chunk)
 *   audio_clip    { mimeType, base64, durationMs }    (the whole recording, once)
 */
(function () {
  const vscode = acquireVsCodeApi();
  const RECORD_MS = 4000;
  const button = document.getElementById('record');
  const status = document.getElementById('status');
  const player = document.getElementById('playback');

  function say(text) {
    status.textContent = text;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function reportMic(state) {
    post({ type: 'mic_state', state });
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const text = String(reader.result);
        resolve(text.slice(text.indexOf(',') + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function record() {
    button.setAttribute('aria-disabled', 'true');
    player.hidden = true;

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function'
        || typeof MediaRecorder === 'undefined') {
      reportMic('unavailable');
      say('Microphone capture is unavailable in this webview.');
      button.removeAttribute('aria-disabled');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error && error.name;
      reportMic(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
      say(`Microphone not available: ${name || 'unknown error'}.`);
      button.removeAttribute('aria-disabled');
      return;
    }

    reportMic('granted');
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    const startedAt = performance.now();
    let sawFirstSample = false;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
        if (!sawFirstSample) {
          sawFirstSample = true;
          post({ type: 'first_sample', bytes: event.data.size });
        }
      }
    };
    recorder.onstop = async () => {
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const durationMs = Math.round(performance.now() - startedAt);
      if (blob.size > 0) {
        player.src = URL.createObjectURL(blob);
        player.hidden = false;
      }
      post({ type: 'audio_clip', mimeType: blob.type, base64: blob.size > 0 ? await toBase64(blob) : '', durationMs });
      say(blob.size > 0
        ? `Recorded ${blob.size} bytes in ${durationMs} ms. Play it back below, then check the host result.`
        : 'Nothing was recorded.');
      button.removeAttribute('aria-disabled');
    };

    post({ type: 'capture_start' });
    say('Recording for 4 seconds. Speak now.');
    recorder.start(250); // a chunk every 250 ms, so the first sample arrives early
    setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, RECORD_MS);
  }

  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') !== 'true') void record();
  });

  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    navigator.permissions.query({ name: 'microphone' }).then(
      (result) => { reportMic(result.state); },
      () => { /* the Permissions API does not know "microphone" here; nothing to report yet */ },
    );
  }
})();
