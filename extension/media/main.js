// KiroSight webview script: thin DOM wiring only.
// All decisions live in the extension host; this file renders what the host
// sends and posts the user's actions back. Display text is always assigned
// through textContent so untrusted content is never parsed as markup.
(function () {
  'use strict';

  // The design's bridge limit for submit_text. The draft is never truncated here.
  var MAX_SUBMIT_TEXT_CHARS = 4000;

  var vscodeApi = acquireVsCodeApi();

  var elements = {
    status: document.getElementById('status'),
    transcript: document.getElementById('transcript'),
    latest: document.getElementById('latest'),
    confirm: document.getElementById('confirm'),
    confirmPrompt: document.getElementById('confirm-prompt'),
    confirmYes: document.getElementById('confirm-yes'),
    confirmNo: document.getElementById('confirm-no'),
    form: document.getElementById('cmd'),
    input: document.getElementById('input'),
    ptt: document.getElementById('ptt'),
    pttNote: document.getElementById('ptt-note')
  };

  for (var name in elements) {
    if (Object.prototype.hasOwnProperty.call(elements, name) && !elements[name]) {
      // A required element is missing: do nothing rather than build replacement DOM.
      return;
    }
  }

  var ROLE_LABELS = { user: 'You', kirosight: 'KiroSight', system: 'System' };

  var submitCounter = 0;
  // submitId -> the exact text that was submitted, for matching acknowledgements.
  var submissions = new Map();
  // Sequence numbers already shown in the transcript, in display order.
  var renderedSeqs = [];
  var statusText = elements.status.textContent || '';
  var voiceReason = elements.pttNote.textContent || '';

  function post(message) {
    vscodeApi.postMessage(message);
  }

  function setStatus(text) {
    statusText = text;
    elements.status.textContent = text;
  }

  function entryText(entry) {
    var label = ROLE_LABELS[entry.role] || 'System';
    var via = entry.source === 'voice' ? ' (voice)' : '';
    return label + via + ': ' + entry.text;
  }

  function appendEntry(entry) {
    var line = document.createElement('div');
    line.textContent = entryText(entry);
    elements.transcript.appendChild(line);
    renderedSeqs.push(entry.seq);
  }

  function isEntry(entry) {
    return entry !== null && typeof entry === 'object' &&
      typeof entry.seq === 'number' && typeof entry.text === 'string' &&
      typeof entry.role === 'string';
  }

  // Append only entries not yet shown so the log is not re-announced as a whole.
  // Rebuild only when the host's history no longer extends what is displayed.
  function renderTranscript(entries) {
    var extendsDisplayed = entries.length >= renderedSeqs.length;
    for (var i = 0; extendsDisplayed && i < renderedSeqs.length; i += 1) {
      if (entries[i].seq !== renderedSeqs[i]) {
        extendsDisplayed = false;
      }
    }

    if (!extendsDisplayed) {
      elements.transcript.textContent = '';
      renderedSeqs = [];
    }

    for (var j = renderedSeqs.length; j < entries.length; j += 1) {
      appendEntry(entries[j]);
    }
  }

  function renderVoice(voice) {
    var available = voice !== null && typeof voice === 'object' && voice.state === 'available';
    // aria-disabled keeps the control in the Tab order; the native attribute would not.
    elements.ptt.setAttribute('aria-disabled', available ? 'false' : 'true');
    voiceReason = voice && typeof voice.reasonText === 'string' ? voice.reasonText : '';
    elements.pttNote.textContent = voiceReason;
  }

  // The prompt currently shown, or null. Focus moves only when this value changes:
  // to the prompt when a new or changed prompt appears, and back to the command input
  // only when a confirmation has fully resolved (no pending prompt remains).
  // A presentation is the request identity plus its prompt: a different request is a new
  // presentation even when its text is identical, and a changed prompt is one too.
  var shownPrompt = null;
  var shownKey = null;

  function renderConfirmation(pending) {
    var valid = pending && typeof pending.promptText === 'string' && pending.promptText !== '' &&
      typeof pending.presentationKey === 'string' && pending.presentationKey !== '';
    var prompt = valid ? pending.promptText : null;
    var key = valid ? pending.presentationKey : null;

    elements.confirm.hidden = prompt === null;
    if (prompt !== null) {
      elements.confirmPrompt.textContent = prompt;
      if (prompt !== shownPrompt || key !== shownKey) {
        elements.confirmPrompt.focus();
      }
    } else if (shownPrompt !== null) {
      elements.input.focus();
    }
    shownPrompt = prompt;
    shownKey = key;
  }

  function renderViewState(message) {
    if (typeof message.status === 'string') {
      setStatus(message.status);
    }

    if (Array.isArray(message.transcript) && message.transcript.every(isEntry)) {
      renderTranscript(message.transcript);
    }

    elements.latest.textContent = typeof message.latest === 'string' ? message.latest : '';

    renderConfirmation(message.pendingConfirmation);

    renderVoice(message.voice);

    var listening = message.listening === true;
    elements.ptt.setAttribute('aria-pressed', listening ? 'true' : 'false');
    elements.ptt.textContent = listening ? 'Stop listening' : 'Push to talk';
  }

  function handleSubmitAck(message) {
    if (typeof message.submitId !== 'string' || !submissions.has(message.submitId)) {
      return;
    }

    var submittedText = submissions.get(message.submitId);
    submissions.delete(message.submitId);

    // Only a handled acknowledgement clears the draft, and only if the draft
    // is still the text that was submitted, so a newer draft is never erased.
    if (message.status === 'handled' && elements.input.value === submittedText) {
      elements.input.value = '';
    }
  }

  // --- microphone capture ---------------------------------------------------------------------
  // The page records only when the host asks (start_capture) and stops when it asks
  // (stop_capture); it never starts on its own and never touches the network. Audio goes to the
  // host only through postMessage, as ordered audio_clip chunks: seq counts from 0 and the last
  // chunk has final: true. A chunk never carries more than about 1 MB of base64; the host puts the
  // chunks back together and sends one clip to the backend.
  var RECORDER_SLICE_MS = 1000;
  var MAX_CHUNK_BYTES = 600000; // 800,000 base64 characters, under the 1 MB chunk limit
  var PREFERRED_AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  var captureCounter = 0;
  var capture = null;

  function postMic(state) {
    post({ type: 'mic_state', state: state });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(reader.error); };
      reader.onload = function () {
        var text = String(reader.result);
        resolve(text.slice(text.indexOf(',') + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  function releaseStream(stream) {
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach(function (track) { track.stop(); });
    }
  }

  // Chunks are posted strictly in order: each waits for the one before it.
  function enqueueChunk(session, blob) {
    session.chain = session.chain.then(function () {
      var posts = Promise.resolve();
      for (var offset = 0; offset < blob.size; offset += MAX_CHUNK_BYTES) {
        posts = posts.then(blobToBase64.bind(null, blob.slice(offset, offset + MAX_CHUNK_BYTES))).then(function (base64) {
          post({
            type: 'audio_clip', clipId: session.clipId, mimeType: session.mimeType,
            base64: base64, seq: session.seq, final: false
          });
          session.seq += 1;
        });
      }
      return posts;
    }).catch(function () {
      postMic('unavailable');
    });
  }

  function enqueueFinal(session) {
    session.chain = session.chain.then(function () {
      post({
        type: 'audio_clip', clipId: session.clipId, mimeType: session.mimeType,
        base64: '', seq: session.seq, final: true
      });
      session.seq += 1;
      if (capture === session) {
        capture = null;
      }
    });
  }

  function startCapture() {
    if (capture !== null) {
      return; // already recording: a repeated request changes nothing
    }

    var media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function' || typeof window.MediaRecorder !== 'function') {
      postMic('unavailable');
      return;
    }

    captureCounter += 1;
    var session = {
      clipId: 'clip-' + captureCounter, mimeType: 'audio/webm', seq: 0, stopped: false,
      stream: null, recorder: null, chain: Promise.resolve()
    };
    capture = session;

    media.getUserMedia({ audio: true }).then(function (stream) {
      if (session.stopped) {
        // stop_capture arrived while the permission prompt was open: record nothing.
        releaseStream(stream);
        enqueueFinal(session);
        return;
      }

      session.stream = stream;
      postMic('granted');

      var recorderType = '';
      if (typeof window.MediaRecorder.isTypeSupported === 'function') {
        for (var i = 0; i < PREFERRED_AUDIO_TYPES.length && recorderType === ''; i += 1) {
          if (window.MediaRecorder.isTypeSupported(PREFERRED_AUDIO_TYPES[i])) {
            recorderType = PREFERRED_AUDIO_TYPES[i];
          }
        }
      }
      var recorder = recorderType === ''
        ? new window.MediaRecorder(stream)
        : new window.MediaRecorder(stream, { mimeType: recorderType });
      session.recorder = recorder;
      if (typeof recorder.mimeType === 'string' && recorder.mimeType !== '') {
        session.mimeType = recorder.mimeType;
      }

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) {
          enqueueChunk(session, event.data);
        }
      };
      recorder.onstop = function () {
        releaseStream(session.stream);
        enqueueFinal(session);
      };
      recorder.onerror = function () {
        postMic('unavailable');
        stopCapture();
      };
      recorder.start(RECORDER_SLICE_MS);
    }, function (error) {
      capture = null;
      var name = error && error.name;
      postMic(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    });
  }

  function stopCapture() {
    var session = capture;
    if (session === null || session.stopped) {
      return;
    }
    session.stopped = true;
    if (session.recorder && session.recorder.state !== 'inactive') {
      session.recorder.stop();
    }
  }

  // Leaving the page must release the microphone.
  window.addEventListener('pagehide', function () {
    stopCapture();
    if (capture !== null) {
      releaseStream(capture.stream);
    }
  });

  function handleHostMessage(message) {
    if (message === null || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'start_capture':
        startCapture();
        break;
      case 'stop_capture':
        stopCapture();
        break;
      case 'view_state':
        renderViewState(message);
        break;
      case 'submit_ack':
        handleSubmitAck(message);
        break;
      case 'backend_unavailable':
        // Show the reason; the draft is deliberately left untouched.
        if (typeof message.message === 'string') {
          setStatus(message.message);
        }
        break;
      case 'focus_input':
        // Explicit re-activation only: move focus and nothing else.
        elements.input.focus();
        break;
      case 'transcript_append':
        if (isEntry(message.entry) &&
            (renderedSeqs.length === 0 || message.entry.seq > renderedSeqs[renderedSeqs.length - 1])) {
          appendEntry(message.entry);
        }
        break;
      default:
        break;
    }
  }

  window.addEventListener('message', function (event) {
    handleHostMessage(event.data);
  });

  elements.form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = elements.input.value;

    if (text.length > MAX_SUBMIT_TEXT_CHARS) {
      setStatus('The command is longer than ' + MAX_SUBMIT_TEXT_CHARS + ' characters. Shorten it and send again.');
      return;
    }

    submitCounter += 1;
    var submitId = 'submit-' + submitCounter;
    submissions.set(submitId, text);
    post({ type: 'submit_text', submitId: submitId, text: text });
  });

  elements.confirmYes.addEventListener('click', function () {
    post({ type: 'confirm' });
  });

  elements.confirmNo.addEventListener('click', function () {
    post({ type: 'decline' });
  });

  elements.ptt.addEventListener('click', function () {
    if (elements.ptt.getAttribute('aria-disabled') === 'true') {
      // Unavailable: start nothing, and say why through the status region.
      setStatus('');
      setStatus(voiceReason);
      return;
    }
    post({ type: 'ptt_toggle' });
  });

  // Escape interrupts. Nothing is prevented or stopped, so the browser and
  // screen readers keep their normal handling of the key.
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      post({ type: 'interrupt' });
    }
  });

  // The panel is opened by the activation command, so focus the command input once at load.
  elements.input.focus();

  post({ type: 'ready' });
})();
