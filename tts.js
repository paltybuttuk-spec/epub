// tts.js — Text-to-speech engine using Web Speech API
export class TTSEngine {
  constructor() {
    this._synth    = window.speechSynthesis;
    this._voices   = [];
    this._utter    = null;
    this._queue    = [];          // sentence queue
    this._queueIdx = 0;
    this._rate     = 1.0;
    this._voice    = null;
    this._playing  = false;
    this._paused   = false;
    this._onWord   = null;        // callback(word, charIndex)
    this._onEnd    = null;
    this._onPause  = null;
    this._onResume = null;
    this._onSentenceStart = null;

    this._loadVoices();
    this._synth.addEventListener('voiceschanged', () => this._loadVoices());
  }

  get isSupported() {
    return 'speechSynthesis' in window;
  }

  get isPlaying() { return this._playing && !this._paused; }
  get isPaused()  { return this._paused; }

  // ─── Voices ───────────────────────────────────────────────────────────
  _loadVoices() {
    this._voices = this._synth.getVoices();
    // Prefer English voices
    const pref = this._voices.filter((v) => v.lang.startsWith('en'));
    if (!this._voice && pref.length) this._voice = pref[0];
  }

  getVoices(langPrefix = null) {
    if (langPrefix) return this._voices.filter((v) => v.lang.startsWith(langPrefix));
    return this._voices;
  }

  setVoice(nameOrURI) {
    this._voice = this._voices.find((v) => v.name === nameOrURI || v.voiceURI === nameOrURI)
      ?? this._voice;
  }

  setRate(rate) {
    this._rate = Math.max(0.1, Math.min(10, rate));
    // Apply to current utterance if playing
    if (this._playing && this._utter) {
      this.pause();
      this._utter.rate = this._rate;
      this.resume();
    }
  }

  // ─── Text Processing ──────────────────────────────────────────────────
  _splitSentences(text) {
    // Split on sentence boundaries, preserving context
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?…])\s+(?=[A-Z"'"‟])|(?<=\n)\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ─── Play ─────────────────────────────────────────────────────────────
  speak(text, opts = {}) {
    this.stop();
    this._queue    = this._splitSentences(text);
    this._queueIdx = 0;
    this._playing  = true;
    this._paused   = false;
    this._onWord   = opts.onWord ?? null;
    this._onEnd    = opts.onEnd ?? null;
    this._onSentenceStart = opts.onSentenceStart ?? null;
    this._speakNext();
  }

  _speakNext() {
    if (this._queueIdx >= this._queue.length) {
      this._playing = false;
      this._onEnd?.();
      return;
    }
    const sentence = this._queue[this._queueIdx];
    this._onSentenceStart?.(this._queueIdx, sentence);

    this._utter = new SpeechSynthesisUtterance(sentence);
    this._utter.rate   = this._rate;
    this._utter.pitch  = 1;
    this._utter.volume = 1;
    if (this._voice) this._utter.voice = this._voice;

    this._utter.onboundary = (e) => {
      if (e.name === 'word') {
        const word = sentence.substr(e.charIndex, e.charLength ?? 10);
        this._onWord?.(word, e.charIndex, this._queueIdx);
      }
    };

    this._utter.onend = () => {
      if (!this._playing) return;
      this._queueIdx++;
      this._speakNext();
    };

    this._utter.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.error('[TTS] Speech error:', e.error);
      this._queueIdx++;
      this._speakNext();
    };

    this._synth.speak(this._utter);

    // Chromium bug fix: cancel stale state after 15s silence
    this._resetStaleTimer();
  }

  _resetStaleTimer() {
    clearTimeout(this._staleTimer);
    this._staleTimer = setTimeout(() => {
      if (this._playing && !this._paused && !this._synth.speaking) {
        console.warn('[TTS] Stale state detected, resuming…');
        this._synth.cancel();
        this._speakNext();
      }
    }, 15_000);
  }

  // ─── Controls ─────────────────────────────────────────────────────────
  pause() {
    if (!this._playing || this._paused) return;
    this._synth.pause();
    this._paused = true;
    this._onPause?.();
  }

  resume() {
    if (!this._paused) return;
    this._synth.resume();
    this._paused = false;
    this._onResume?.();
    this._resetStaleTimer();
  }

  togglePlayPause() {
    if (!this._playing) return;
    if (this._paused) this.resume();
    else this.pause();
  }

  stop() {
    clearTimeout(this._staleTimer);
    this._synth.cancel();
    this._playing  = false;
    this._paused   = false;
    this._utter    = null;
    this._queue    = [];
    this._queueIdx = 0;
    this._onEnd?.();
  }

  skipForward(n = 1) {
    this._synth.cancel();
    this._queueIdx = Math.min(this._queue.length - 1, this._queueIdx + n);
    if (this._playing && !this._paused) this._speakNext();
  }

  skipBack(n = 1) {
    this._synth.cancel();
    this._queueIdx = Math.max(0, this._queueIdx - n);
    if (this._playing && !this._paused) this._speakNext();
  }

  // ─── Event Hooks ──────────────────────────────────────────────────────
  onWord(fn)            { this._onWord   = fn; }
  onEnd(fn)             { this._onEnd    = fn; }
  onPause(fn)           { this._onPause  = fn; }
  onResume(fn)          { this._onResume = fn; }
  onSentenceStart(fn)   { this._onSentenceStart = fn; }

  // ─── Voice Select HTML ────────────────────────────────────────────────
  buildVoiceOptions() {
    const voices = this.getVoices();
    if (!voices.length) return '<option>Default</option>';
    const grouped = voices.reduce((acc, v) => {
      const lang = v.lang.split('-')[0].toUpperCase();
      (acc[lang] ??= []).push(v);
      return acc;
    }, {});
    return Object.entries(grouped)
      .sort(([a], [b]) => (a === 'EN' ? -1 : b === 'EN' ? 1 : a.localeCompare(b)))
      .map(([lang, vs]) =>
        `<optgroup label="${lang}">${vs.map((v) => `<option value="${escAttr(v.voiceURI)}">${escHtml(v.name)}</option>`).join('')}</optgroup>`
      )
      .join('');
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────
  destroy() {
    this.stop();
  }
}

function escHtml(s)  { return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s)  { return (s ?? '').replace(/"/g, '&quot;'); }
