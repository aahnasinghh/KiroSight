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
  // The status the host last sent (or a local message such as a refusal). While a spoken clip is
  // really playing, "Speaking" is shown in front of it as text, so the state never relies on sound
  // or color. The host's own wording is kept and comes back when playback ends.
  var SPEAKING_LABEL = 'Speaking';
  var hostStatus = elements.status.textContent || '';
  var speaking = false;
  var voiceReason = elements.pttNote.textContent || '';

  function post(message) {
    vscodeApi.postMessage(message);
  }

  // Assigning identical text still replaces the text node, and some screen readers announce a
  // replaced node in a live region again. So text is written only when it really changes: a
  // repeated view_state never re-announces the status, re-reads a focused prompt, or re-labels a
  // button that is being read.
  function setText(element, text) {
    if (element.textContent !== text) {
      element.textContent = text;
    }
  }

  function renderStatus() {
    var shown = hostStatus;
    if (speaking) {
      // "Idle" says nothing while speech is playing, so it gives way to the Speaking label.
      // Only the whole word "Idle" goes: "Idleness" or "Idle-ish" keep their text.
      var rest = hostStatus.replace(/^(?:Status: )?Idle(?![\w-])\.?\s*/, '');
      shown = rest === '' ? SPEAKING_LABEL : SPEAKING_LABEL + '. ' + rest;
    }
    setText(elements.status, shown);
  }

  function setStatus(text) {
    hostStatus = text;
    renderStatus();
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
    setText(elements.pttNote, voiceReason);
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
      setText(elements.confirmPrompt, prompt);
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

    setText(elements.latest, typeof message.latest === 'string' ? message.latest : '');

    renderConfirmation(message.pendingConfirmation);

    renderVoice(message.voice);

    var listening = message.listening === true;
    elements.ptt.setAttribute('aria-pressed', listening ? 'true' : 'false');
    setText(elements.ptt, listening ? 'Stop listening' : 'Push to talk');
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
    disposePlayback();
  });

  // --- speech playback ------------------------------------------------------------------------
  // The page plays a clip only when the host sends play_audio, and only one clip at a time (the
  // newest wins). It reports back, with the host's own id, what really happened:
  //   started: the audio element fired "playing" (sound is actually being produced). Neither
  //            calling play() nor its promise resolving counts: only the element's own event does.
  //   ended:   a clip that had started finished or was stopped.
  //   failed:  the clip was unusable, play() was refused, or the element reported an error.
  // Each clip reports at most one terminal state (ended or failed), and a clip that is stopped
  // before it ever started reports nothing: the host decides about a clip that never began.
  // Audio stays in memory only: it is decoded to a Blob and played from a blob: URL (a data: URL
  // is the fallback), never written anywhere, and it is released when the clip ends or is stopped.
  var AUDIO_MIME_PATTERN = /^audio\/[A-Za-z0-9.+-]{1,60}$/;
  var BASE64_PATTERN = /^[A-Za-z0-9+\/]+={0,2}$/;
  var MAX_AUDIO_BASE64_CHARS = 6000000;
  var REMEMBERED_CLIPS = 16;
  var playback = null;
  // Ids of clips that already finished, so a repeated play_audio is never played twice.
  var finishedClips = [];

  function reportPlayback(state, id) {
    post({ type: 'playback', state: state, id: id });
  }

  function rememberFinished(id) {
    finishedClips.push(id);
    while (finishedClips.length > REMEMBERED_CLIPS) {
      finishedClips.shift();
    }
  }

  function isPlayableClip(message) {
    return typeof message.mimeType === 'string' && AUDIO_MIME_PATTERN.test(message.mimeType) &&
      typeof message.base64 === 'string' && message.base64 !== '' &&
      message.base64.length <= MAX_AUDIO_BASE64_CHARS && message.base64.length % 4 === 0 &&
      BASE64_PATTERN.test(message.base64);
  }

  function decodeBase64(base64) {
    var binary = window.atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function revokeObjectUrl(clip) {
    if (clip.objectUrl !== null) {
      try {
        window.URL.revokeObjectURL(clip.objectUrl);
      } catch (ignored) {
        // Nothing more can be done for a URL that cannot be revoked.
      }
      clip.objectUrl = null;
    }
  }

  // Detaches every listener from the clip's audio element, silences and empties it, and revokes
  // the object URL. Safe to repeat. Events that arrive afterwards find no listener.
  function releaseClip(clip) {
    var audio = clip.audio;
    clip.audio = null;
    if (audio !== null) {
      clip.listeners.forEach(function (entry) {
        audio.removeEventListener(entry.type, entry.handler);
      });
      clip.listeners = [];
      try {
        audio.pause();
        audio.removeAttribute('src');
        if (typeof audio.load === 'function') {
          audio.load();
        }
      } catch (ignored) {
        // The element is being discarded; a failure to empty it changes nothing.
      }
    }
    revokeObjectUrl(clip);
  }

  function leaveSpeaking() {
    if (speaking) {
      speaking = false;
      renderStatus();
    }
  }

  // The clip is over for good: release it, forget it, clear the label, and report the one terminal
  // state. A clip that is already done reports nothing.
  function finishClip(clip, state) {
    if (clip.done) {
      return;
    }
    clip.done = true;
    releaseClip(clip);
    clip.base64 = '';
    rememberFinished(clip.id);
    if (playback === clip) {
      playback = null;
    }
    leaveSpeaking();
    reportPlayback(state, clip.id);
  }

  // The clip is stopped on request (stop_audio, Escape, a newer clip, leaving the page). Nothing is
  // reported for a clip that never started; one that had started has ended.
  function stopClip(clip, report) {
    if (clip.done) {
      return;
    }
    clip.done = true;
    var wasStarted = clip.started;
    releaseClip(clip);
    clip.base64 = '';
    rememberFinished(clip.id);
    if (playback === clip) {
      playback = null;
    }
    leaveSpeaking();
    if (report && wasStarted) {
      reportPlayback('ended', clip.id);
    }
  }

  function stopPlayback() {
    if (playback !== null) {
      stopClip(playback, true);
    }
  }

  function disposePlayback() {
    if (playback !== null) {
      stopClip(playback, false);
    }
  }

  // The source for a clip: a blob: URL when the browser offers object URLs, otherwise (or when
  // asked, after the blob: URL failed) a data: URL.
  function sourceFor(clip, preferData) {
    if (!preferData && window.URL && typeof window.URL.createObjectURL === 'function') {
      try {
        var blob = new window.Blob([decodeBase64(clip.base64)], { type: clip.mimeType });
        clip.objectUrl = window.URL.createObjectURL(blob);
        clip.kind = 'blob';
        return clip.objectUrl;
      } catch (ignored) {
        revokeObjectUrl(clip);
      }
    }
    clip.kind = 'data';
    return 'data:' + clip.mimeType + ';base64,' + clip.base64;
  }

  // Every audio event goes through here: an event from a clip that is no longer the current one,
  // or that is already done, is ignored, so a late event can never restart or re-report a clip.
  function listen(clip, type, handler) {
    var wrapped = function () {
      if (playback === clip && !clip.done) {
        handler();
      }
    };
    clip.listeners.push({ type: type, handler: wrapped });
    clip.audio.addEventListener(type, wrapped);
  }

  function onClipFault(clip) {
    if (!clip.started && clip.kind === 'blob' && !clip.retried) {
      // The blob: URL did not work: try once more with the data: URL before giving up.
      clip.retried = true;
      releaseClip(clip);
      beginClip(clip, sourceFor(clip, true));
      return;
    }
    finishClip(clip, 'failed');
  }

  function beginClip(clip, source) {
    if (typeof window.Audio !== 'function') {
      finishClip(clip, 'failed');
      return;
    }
    var audio;
    try {
      audio = new window.Audio();
    } catch (ignored) {
      finishClip(clip, 'failed');
      return;
    }
    clip.audio = audio;
    clip.listeners = [];

    listen(clip, 'playing', function () {
      if (clip.started) {
        return; // buffering can fire it again; it was reported once
      }
      clip.started = true;
      speaking = true;
      renderStatus();
      reportPlayback('started', clip.id);
    });
    listen(clip, 'ended', function () {
      finishClip(clip, clip.started ? 'ended' : 'failed');
    });
    listen(clip, 'error', function () {
      if (clip.started) {
        finishClip(clip, 'failed');
      } else {
        onClipFault(clip);
      }
    });

    // A pause nobody asked for (media keys, the system) would leave "Speaking" showing for a clip
    // that is no longer producing sound. The browser also fires "pause" just before "ended" when a
    // clip finishes by itself, so that case (audio.ended) is left to the "ended" listener. Waiting
    // or stalled buffering fires neither event and is deliberately not treated as an ending. A
    // pause before the clip started is ignored: the host's start deadline covers it. "abort" and
    // "emptied" only follow a source change or load(), which only this code makes, after the
    // listeners are detached.
    listen(clip, 'pause', function () {
      if (clip.started && !(clip.audio && clip.audio.ended)) {
        finishClip(clip, 'ended');
      }
    });

    var attempt;
    try {
      audio.src = source;
      attempt = audio.play();
    } catch (ignored) {
      onClipFault(clip);
      return;
    }
    if (attempt && typeof attempt.then === 'function') {
      // The promise resolving proves nothing (only "playing" does); only a refusal matters. The
      // rejection is always handled here, so it can never go unhandled.
      attempt.then(undefined, function () {
        // Only the element this attempt belongs to may fail the clip: a refusal from an element
        // that was already replaced (the data: retry) or stopped is stale.
        if (playback === clip && !clip.done && clip.audio === audio) {
          onClipFault(clip);
        }
      });
    }
  }

  function startPlayback(message) {
    if (typeof message.id !== 'string' || message.id === '') {
      return; // without an id nothing can be correlated or reported
    }
    var id = message.id;
    if ((playback !== null && playback.id === id) || finishedClips.indexOf(id) !== -1) {
      return; // a repeat of a clip that is playing or already finished
    }
    if (!isPlayableClip(message) || typeof window.Audio !== 'function') {
      rememberFinished(id);
      reportPlayback('failed', id);
      return;
    }

    stopPlayback(); // the newest clip wins
    var clip = {
      id: id, mimeType: message.mimeType, base64: message.base64, audio: null, objectUrl: null,
      kind: '', started: false, done: false, retried: false, listeners: []
    };
    playback = clip;
    var source;
    try {
      source = sourceFor(clip, false);
    } catch (ignored) {
      finishClip(clip, 'failed');
      return;
    }
    beginClip(clip, source);
  }

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
      case 'play_audio':
        startPlayback(message);
        break;
      case 'stop_audio':
        stopPlayback();
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
    // Focus stays in (or returns to) the command input after Send, so pressing the Send button
    // does not leave the user on a button after the draft is cleared. A confirmation that the
    // reply raises still takes focus afterwards, through renderConfirmation.
    elements.input.focus();
  });

  // Confirm and Decline hide themselves once the request resolves, which would drop focus onto the
  // page body. Focus goes to the command input as the answer is sent, so it is never lost. If a
  // different prompt follows, it takes focus when it appears.
  elements.confirmYes.addEventListener('click', function () {
    post({ type: 'confirm' });
    elements.input.focus();
  });

  elements.confirmNo.addEventListener('click', function () {
    post({ type: 'decline' });
    elements.input.focus();
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
      stopPlayback(); // speech stops at once, locally; no other key is looked at
      post({ type: 'interrupt' });
    }
  });

  // The panel is opened by the activation command, so focus the command input once at load.
  elements.input.focus();

  post({ type: 'ready' });
})();
