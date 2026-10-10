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

  function renderViewState(message) {
    if (typeof message.status === 'string') {
      setStatus(message.status);
    }

    if (Array.isArray(message.transcript) && message.transcript.every(isEntry)) {
      renderTranscript(message.transcript);
    }

    elements.latest.textContent = typeof message.latest === 'string' ? message.latest : '';

    var pending = message.pendingConfirmation;
    elements.confirm.hidden = pending === null || pending === undefined;
    if (pending && typeof pending.promptText === 'string') {
      elements.confirmPrompt.textContent = pending.promptText;
    }

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

  function handleHostMessage(message) {
    if (message === null || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
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
