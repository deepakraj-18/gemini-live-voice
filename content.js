(function () {
  'use strict';

  const BUTTON_ID    = 'glive-btn';
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

  let lastReadText    = '';
  const readObservers = new WeakMap();

  // ── Language state ───────────────────────────────────────────────────────
  const LANGUAGES = [
    { code: 'en-US', label: 'English' },
    { code: 'ta-IN', label: 'தமிழ் (Tamil)' },
    { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
    { code: 'te-IN', label: 'తెలుగు (Telugu)' },
    { code: 'kn-IN', label: 'ಕನ್ನಡ (Kannada)' },
    { code: 'ml-IN', label: 'മലയാളം (Malayalam)' },
    { code: 'fr-FR', label: 'Français' },
    { code: 'de-DE', label: 'Deutsch' },
    { code: 'es-ES', label: 'Español' },
    { code: 'ja-JP', label: '日本語' },
    { code: 'zh-CN', label: '中文' },
    { code: 'ar-SA', label: 'العربية' },
  ];

  let selectedLang = localStorage.getItem('glive-lang') || 'en-US';

  function getLang() { return selectedLang; }

  function onLangChange(code) {
    selectedLang = code;
    localStorage.setItem('glive-lang', code);
    selectedVoiceName = '';           // reset voice — old voice likely wrong language
    localStorage.removeItem('glive-voice');
    const voiceSel = document.getElementById('glive-voice-select');
    if (voiceSel) {
      voiceSel.value = '';
      populateVoiceSelect(voiceSel); // re-filter voices for new language
    }
    // Rebuild and restart recognition with new language if live
    if (isLive) {
      stopRecognition();
      recognition = null;
      setTimeout(startRecognition, 150);
    }
  }

  // ── Voice state ──────────────────────────────────────────────────────────
  let voices            = [];
  let selectedVoiceName = localStorage.getItem('glive-voice') || '';

  function loadVoices() {
    const v = window.speechSynthesis.getVoices();
    if (v.length) voices = v;
    populateVoiceSelect();
  }
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
  setTimeout(loadVoices, 200);

  function getSelectedVoice() {
    // If a voice is explicitly chosen, use it
    if (selectedVoiceName) return voices.find(v => v.name === selectedVoiceName) || null;
    // Otherwise auto-pick the best voice for the selected language
    const lang = getLang();
    const exact = voices.find(v => v.lang === lang);
    if (exact) return exact;
    const prefix = lang.split('-')[0];
    return voices.find(v => v.lang.startsWith(prefix)) || null;
  }

  function populateVoiceSelect(sel) {
    if (!sel) sel = document.getElementById('glive-voice-select');
    if (!sel || !voices.length) return;
    const prev = sel.value || selectedVoiceName;
    const lang = getLang();
    const prefix = lang.split('-')[0];
    // Show voices for the selected language first, then all others
    const matching = voices.filter(v => v.lang.startsWith(prefix));
    const rest     = voices.filter(v => !v.lang.startsWith(prefix));
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Auto (best for language)';
    sel.appendChild(def);
    const addVoice = (v) => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name + ' (' + v.lang + ')';
      sel.appendChild(opt);
    };
    matching.forEach(addVoice);
    if (matching.length && rest.length) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '──────────';
      sel.appendChild(sep);
    }
    rest.forEach(addVoice);
    sel.value = prev || '';
  }

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
    r.lang = getLang();

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
      if (finalText.trim()) silenceTimer = setTimeout(autoSubmit, SILENCE_DELAY);
    };

    r.onerror = (evt) => {
      isRecognizing = false;
      if (evt.error === 'not-allowed') {
        showToast('Microphone access denied. Allow mic for gemini.google.com.', 'error');
        stopLive();
      }
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

  // ── TTS ──────────────────────────────────────────────────────────────────
  function extractSpeakableText(el) {
    const clone = el.cloneNode(true);
    // Remove code blocks
    clone.querySelectorAll('pre, code, [class*="code-block"]').forEach(n => n.remove());
    // Remove visually-hidden screen-reader-only elements ("Gemini said", copy buttons, etc.)
    clone.querySelectorAll([
      '[class*="visually-hidden"]',
      '[class*="sr-only"]',
      '[class*="screen-reader"]',
      '[aria-hidden="true"]',
      'button',
    ].join(',')).forEach(n => n.remove());
    let text = (clone.innerText || '').replace(/\s+/g, ' ').trim();
    // Belt-and-suspenders: strip any remaining "Gemini said" prefix
    text = text.replace(/^(gemini\s+said|model\s+said)[:\s]*/i, '').trim();
    return text;
  }

  function speak(text) {
    if (!isLive || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = getLang();
    const voice = getSelectedVoice();
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  }

  function stopSpeech() {
    window.speechSynthesis.cancel();
  }

  function watchResponseEl(el) {
    if (readObservers.has(el)) return;
    let settle;
    const obs = new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        obs.disconnect();
        if (!isLive) return;
        const text = extractSpeakableText(el);
        if (text && text !== lastReadText) {
          lastReadText = text;
          speak(text);
        }
      }, 1000);
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    readObservers.set(el, obs);
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
    // Snapshot the current last response so TTS only triggers on NEW responses
    const existing = document.querySelectorAll('model-response');
    if (existing.length) {
      lastReadText = extractSpeakableText(existing[existing.length - 1]);
    }
    stopSpeech();
    showIndicator();
    startRecognition();
  }

  function stopLive() {
    isLive = false;
    clearTimeout(silenceTimer);
    clearTimeout(visualTimer);
    stopRecognition();
    stopSpeech();
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

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.dataset.state = 'off';
    btn.setAttribute('aria-label', 'Toggle Live Speech');
    btn.title = 'Live Speech — Ctrl+Shift+L';
    const label = document.createElement('span');
    label.className = 'glive-label';
    label.textContent = 'LIVE';
    btn.appendChild(label);
    btn.addEventListener('click', toggleLive);
    anchor.parentElement.insertBefore(btn, anchor);
  }

  // ── Indicator ────────────────────────────────────────────────────────────
  function positionIndicator() {
    const bar = document.getElementById(INDICATOR_ID);
    if (!bar) return;
    const anchor = document.querySelector('input-container') || document.querySelector('.input-area-container');
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      bar.style.bottom = (Math.round(window.innerHeight - rect.top) + 8) + 'px';
    }
  }

  function showIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;

    const bar = document.createElement('div');
    bar.id = INDICATOR_ID;
    bar.dataset.state = 'listening';

    const wave = document.createElement('div');
    wave.className = 'glive-wave';
    wave.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 5; i++) {
      const d = document.createElement('div');
      d.className = 'glive-wave-bar';
      wave.appendChild(d);
    }

    const txt = document.createElement('span');
    txt.className = 'glive-indicator-text';
    txt.setAttribute('aria-live', 'polite');
    txt.textContent = 'Listening…';

    // Language selector
    const langSel = document.createElement('select');
    langSel.id = 'glive-lang-select';
    langSel.className = 'glive-voice-select';
    langSel.title = 'Select language';
    langSel.setAttribute('aria-label', 'Language');
    LANGUAGES.forEach(({ code, label }) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      langSel.appendChild(opt);
    });
    langSel.value = selectedLang;
    langSel.addEventListener('change', (e) => onLangChange(e.target.value));
    langSel.addEventListener('click', (e) => e.stopPropagation());

    // Voice selector — inline in the pill
    const voiceSel = document.createElement('select');
    voiceSel.id = 'glive-voice-select';
    voiceSel.className = 'glive-voice-select';
    voiceSel.title = 'Select TTS voice';
    voiceSel.setAttribute('aria-label', 'TTS voice');
    voiceSel.addEventListener('change', (e) => {
      selectedVoiceName = e.target.value;
      localStorage.setItem('glive-voice', selectedVoiceName);
    });
    voiceSel.addEventListener('click', (e) => e.stopPropagation());

    const cls = document.createElement('button');
    cls.className = 'glive-close';
    cls.setAttribute('aria-label', 'Stop live speech');
    cls.title = 'Stop';
    cls.textContent = '✕';
    cls.addEventListener('click', stopLive);

    bar.appendChild(wave);
    bar.appendChild(txt);
    bar.appendChild(langSel);
    bar.appendChild(voiceSel);
    bar.appendChild(cls);
    document.body.appendChild(bar);

    // Populate after element is in DOM; re-fetch voices in case they loaded late
    const fresh = window.speechSynthesis.getVoices();
    if (fresh.length) voices = fresh;
    populateVoiceSelect(voiceSel);

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

  // ── Keyboard shortcut ────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      toggleLive();
    }
  });

  // ── MutationObserver ─────────────────────────────────────────────────────
  new MutationObserver((mutations) => {
    if (!document.getElementById(BUTTON_ID)) injectLiveButton();

    clearTimeout(posDebounce);
    posDebounce = setTimeout(positionIndicator, 150);

    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName?.toLowerCase() === 'model-response') watchResponseEl(node);
        node.querySelectorAll?.('model-response').forEach(watchResponseEl);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  injectLiveButton();

})();
