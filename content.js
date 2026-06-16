(function () {
  'use strict';

  const BUTTON_ID    = 'glive-btn';
  const SPEAK_ID     = 'glive-speak-btn';
  const INDICATOR_ID = 'glive-indicator';
  const SILENCE_DELAY = 1500;

  // ── State ────────────────────────────────────────────────────────────────
  let recognition   = null;
  let isLive        = false;
  let isRecognizing = false;
  let finalText     = '';
  let interimText   = '';
  let silenceTimer  = null;
  let isSubmitting  = false;
  let visualTimer   = null;
  let posDebounce   = null;

  // TTS state — persisted across page loads
  let ttsEnabled   = localStorage.getItem('glive-tts') === 'true';
  let lastReadText = '';
  const readObservers = new WeakMap();

  // ── DOM helpers ──────────────────────────────────────────────────────────
  const getEditor  = () => document.querySelector('.ql-editor[contenteditable="true"]');
  const getSendBtn = () => document.querySelector('[aria-label="Send message"]');
  const getMicComp = () => document.querySelector('speech-dictation-mic-button');

  // ── Editor ───────────────────────────────────────────────────────────────
  function setEditorText(text) {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    document.execCommand('selectAll', false, null);
    if (text) {
      document.execCommand('insertText', false, text);
    } else {
      document.execCommand('delete', false, null);
    }
  }

  // ── Speech Recognition ───────────────────────────────────────────────────
  function buildRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;

    const r = new SR();
    r.continuous      = true;
    r.interimResults  = true;
    r.maxAlternatives = 1;
    r.lang = document.documentElement.lang || navigator.language || 'en-US';

    r.onstart = () => {
      isRecognizing = true;
      setUiState('listening');
    };

    r.onresult = (evt) => {
      if (isSubmitting) return;
      let interim = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const t = evt.results[i][0].transcript;
        if (evt.results[i].isFinal) {
          if (finalText && !finalText.endsWith(' ')) finalText += ' ';
          finalText += t.trim();
        } else {
          interim = t;
        }
      }
      interimText = interim;

      setEditorText(finalText + (interim ? (finalText ? ' ' : '') + interim : ''));

      setUiState('speaking');
      clearTimeout(visualTimer);
      visualTimer = setTimeout(() => { if (isLive) setUiState('listening'); }, 800);

      clearTimeout(silenceTimer);
      if (finalText.trim()) {
        silenceTimer = setTimeout(autoSubmit, SILENCE_DELAY);
      }
    };

    r.onerror = (evt) => {
      isRecognizing = false;
      if (evt.error === 'not-allowed') {
        showToast('Microphone access denied. Allow mic for gemini.google.com.', 'error');
        stopLive();
      }
      // no-speech / network / aborted → restart via onend
    };

    r.onend = () => {
      isRecognizing = false;
      if (interimText.trim()) {
        if (finalText && !finalText.endsWith(' ')) finalText += ' ';
        finalText += interimText.trim();
        interimText = '';
        setEditorText(finalText);
        clearTimeout(silenceTimer);
        if (finalText.trim()) silenceTimer = setTimeout(autoSubmit, SILENCE_DELAY);
      }
      if (isLive && !isSubmitting) {
        setTimeout(() => {
          if (isLive && !isRecognizing) { try { r.start(); } catch (_) {} }
        }, 120);
      }
    };

    return r;
  }

  function startRecognition() {
    if (!recognition) recognition = buildRecognition();
    if (!recognition) {
      showToast('Speech Recognition not supported in this browser.', 'error');
      stopLive();
      return;
    }
    if (!isRecognizing) { try { recognition.start(); } catch (_) {} }
  }

  function stopRecognition() {
    clearTimeout(silenceTimer);
    clearTimeout(visualTimer);
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    isRecognizing = false;
  }

  // ── Auto-submit ──────────────────────────────────────────────────────────
  function autoSubmit() {
    if (!finalText.trim() || isSubmitting) return;
    isSubmitting = true;
    interimText  = '';

    setEditorText(finalText.trim());
    setUiState('sending');

    setTimeout(() => {
      const btn = getSendBtn();
      if (btn && !btn.disabled) btn.click();
      finalText    = '';
      isSubmitting = false;
      if (isLive) setUiState('listening');
    }, 300);
  }

  // ── TTS (Speech Output) ──────────────────────────────────────────────────
  function extractSpeakableText(el) {
    const clone = el.cloneNode(true);
    // Remove code blocks — don't read raw code aloud
    clone.querySelectorAll('pre, code, [class*="code-block"]').forEach(n => n.remove());
    return (clone.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function speak(text) {
    if (!ttsEnabled || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = document.documentElement.lang || navigator.language || 'en-US';
    window.speechSynthesis.speak(u);
  }

  function stopSpeech() {
    window.speechSynthesis.cancel();
  }

  // Watch a single model-response element and read it once streaming settles
  function watchResponseEl(el) {
    if (readObservers.has(el)) return;
    let settle;
    const obs = new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        obs.disconnect();
        if (!ttsEnabled) return;
        const text = extractSpeakableText(el);
        if (text && text !== lastReadText) {
          lastReadText = text;
          speak(text);
        }
      }, 1000); // wait 1 s of silence after streaming stops
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    readObservers.set(el, obs);
  }

  // Read the latest response already in the DOM (called when TTS is toggled on)
  function readLatestResponse() {
    const els = document.querySelectorAll('model-response');
    if (!els.length) return;
    const last = els[els.length - 1];
    const text = extractSpeakableText(last);
    if (text && text !== lastReadText) {
      lastReadText = text;
      speak(text);
    }
  }

  function updateSpeakBtn() {
    const btn = document.getElementById(SPEAK_ID);
    if (!btn) return;
    btn.dataset.state = ttsEnabled ? 'on' : 'off';
    btn.title = ttsEnabled
      ? 'Speech Output ON — Ctrl+Shift+S to toggle'
      : 'Speech Output OFF — Ctrl+Shift+S to toggle';
  }

  function toggleTts() {
    ttsEnabled = !ttsEnabled;
    localStorage.setItem('glive-tts', String(ttsEnabled));
    updateSpeakBtn();
    if (ttsEnabled) {
      readLatestResponse();
    } else {
      stopSpeech();
    }
  }

  // ── Unified UI state ─────────────────────────────────────────────────────
  function setUiState(state) {
    const btn = document.getElementById(BUTTON_ID);
    const bar = document.getElementById(INDICATOR_ID);

    if (btn) btn.dataset.state = state;

    if (bar) {
      bar.dataset.state = state;
      const txt = bar.querySelector('.glive-indicator-text');
      if (txt) {
        txt.textContent = {
          listening: 'Listening…',
          speaking:  'Hearing you…',
          sending:   'Sending…',
        }[state] || 'Live…';
      }
    }
  }

  // ── Live mode ────────────────────────────────────────────────────────────
  function startLive() {
    isLive       = true;
    finalText    = '';
    interimText  = '';
    isSubmitting = false;
    stopSpeech(); // pause TTS while mic is active
    showIndicator();
    startRecognition();
  }

  function stopLive() {
    isLive = false;
    clearTimeout(silenceTimer);
    clearTimeout(visualTimer);
    stopRecognition();
    hideIndicator();
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.dataset.state = 'off';
  }

  function toggleLive() { isLive ? stopLive() : startLive(); }

  // ── Button injection ─────────────────────────────────────────────────────
  function injectLiveButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const micContainer = document.querySelector('.mic-button-container');
    const micComp      = getMicComp();
    const anchor       = micContainer || micComp;
    if (!anchor) return;

    const parent = anchor.parentElement;

    // LIVE button
    const liveBtn = document.createElement('button');
    liveBtn.id = BUTTON_ID;
    liveBtn.dataset.state = 'off';
    liveBtn.setAttribute('aria-label', 'Toggle Live Speech Input');
    liveBtn.title = 'Live Speech Input — Ctrl+Shift+L';
    const liveLabel = document.createElement('span');
    liveLabel.className = 'glive-label';
    liveLabel.textContent = 'LIVE';
    liveBtn.appendChild(liveLabel);
    liveBtn.addEventListener('click', toggleLive);
    parent.insertBefore(liveBtn, anchor);

    // SPEAK button
    const speakBtn = document.createElement('button');
    speakBtn.id = SPEAK_ID;
    speakBtn.dataset.state = ttsEnabled ? 'on' : 'off';
    speakBtn.setAttribute('aria-label', 'Toggle Speech Output');
    speakBtn.title = ttsEnabled
      ? 'Speech Output ON — Ctrl+Shift+S to toggle'
      : 'Speech Output OFF — Ctrl+Shift+S to toggle';
    const speakLabel = document.createElement('span');
    speakLabel.className = 'glive-label';
    speakLabel.textContent = 'SPEAK';
    speakBtn.appendChild(speakLabel);
    speakBtn.addEventListener('click', toggleTts);
    parent.insertBefore(speakBtn, anchor);
  }

  // ── Indicator ────────────────────────────────────────────────────────────
  function positionIndicator() {
    const bar = document.getElementById(INDICATOR_ID);
    if (!bar) return;
    // input-container is always anchored to viewport bottom regardless of scroll/layout state
    const anchor = document.querySelector('input-container') || document.querySelector('.input-area-container');
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      bar.style.bottom = (Math.round(window.innerHeight - rect.top) + 8) + 'px';
    }
  }

  function makeWaveBar() {
    const d = document.createElement('div');
    d.className = 'glive-wave-bar';
    return d;
  }

  function showIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;

    const bar = document.createElement('div');
    bar.id = INDICATOR_ID;
    bar.dataset.state = 'listening';

    const wave = document.createElement('div');
    wave.className = 'glive-wave';
    wave.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 5; i++) wave.appendChild(makeWaveBar());

    const txt = document.createElement('span');
    txt.className = 'glive-indicator-text';
    txt.setAttribute('aria-live', 'polite');
    txt.textContent = 'Listening…';

    const cls = document.createElement('button');
    cls.className = 'glive-close';
    cls.setAttribute('aria-label', 'Stop live speech');
    cls.title = 'Stop';
    cls.textContent = '✕';
    cls.addEventListener('click', stopLive);

    bar.appendChild(wave);
    bar.appendChild(txt);
    bar.appendChild(cls);
    document.body.appendChild(bar);

    positionIndicator();
    window.addEventListener('resize', positionIndicator);
  }

  function hideIndicator() {
    window.removeEventListener('resize', positionIndicator);
    document.getElementById(INDICATOR_ID)?.remove();
  }

  // ── Toast ────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `glive-toast glive-toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      toggleLive();
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      toggleTts();
    }
  });

  // ── MutationObserver ─────────────────────────────────────────────────────
  new MutationObserver((mutations) => {
    // Re-inject buttons if Angular re-renders removed them
    if (!document.getElementById(BUTTON_ID)) injectLiveButton();

    // Reposition indicator when page layout changes (e.g. conversation starts,
    // input-container moves from center to bottom)
    clearTimeout(posDebounce);
    posDebounce = setTimeout(positionIndicator, 150);

    // Hook new AI response elements for TTS
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName?.toLowerCase() === 'model-response') {
          watchResponseEl(node);
        }
        node.querySelectorAll?.('model-response').forEach(watchResponseEl);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  injectLiveButton();

})();
