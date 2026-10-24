// epub-engine.js — Full epub.js wrapper with premium feature hooks
import Epub from 'epubjs';

export class EpubEngine {
  constructor() {
    this.book = null;
    this.rendition = null;
    this.currentLocation = null;
    this._listeners = new Map();
    this._wordCount = 0;
    this._sessionStart = Date.now();
  }

  // ─── Open ────────────────────────────────────────────────────────────────
  async open(arrayBuffer) {
    if (this.book) {
      this.book.destroy();
      this.book = null;
      this.rendition = null;
    }
    this.book = new Epub(arrayBuffer.slice(0)); // slice to avoid detached buffer issues
    await this.book.ready;

    // Pre-load cover, metadata, nav in parallel
    const [metadata, navigation, spine] = await Promise.all([
      this.book.loaded.metadata,
      this.book.loaded.navigation,
      this.book.loaded.spine,
    ]);

    // Approximate word count from spine items
    this._wordCount = 0; // will be filled lazily

    return { metadata, navigation, spine };
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  renderTo(element, options = {}) {
    const defaults = {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated',
      manager: 'default',
      snap: true,
    };
    this.rendition = this.book.renderTo(element, { ...defaults, ...options });
    this._attachRenditionEvents();
    return this.rendition;
  }

  _attachRenditionEvents() {
    const r = this.rendition;
    if (!r) return;

    r.on('relocated', (loc) => {
      this.currentLocation = loc;
      this._emit('relocated', loc);
    });

    r.on('rendered', (section, view) => {
      this._injectStyles();
      this._emit('rendered', { section, view });
    });

    r.on('displayError', (err) => {
      console.error('[EpubEngine] Display error:', err);
      this._emit('error', err);
    });

    r.on('selected', (cfiRange, contents) => {
      this._emit('selected', { cfiRange, contents });
    });

    r.on('markClicked', (cfiRange, data) => {
      this._emit('markClicked', { cfiRange, data });
    });
  }

  // ─── Navigation ───────────────────────────────────────────────────────────
  async display(cfi) {
    if (!this.rendition) throw new Error('No rendition. Call renderTo() first.');
    await this.rendition.display(cfi);
  }

  async next() {
    return this.rendition?.next();
  }

  async prev() {
    return this.rendition?.prev();
  }

  async goToChapter(href) {
    return this.rendition?.display(href);
  }

  async goToPercent(pct) {
    const loc = this.book.locations.cfiFromPercentage(pct / 100);
    return this.rendition?.display(loc);
  }

  // ─── Locations ────────────────────────────────────────────────────────────
  async generateLocations(chars = 1650) {
    if (!this.book) return;
    await this.book.locations.generate(chars);
    this._emit('locationsReady', this.book.locations);
    return this.book.locations;
  }

  getPercentage(cfi) {
    if (!this.book?.locations?.total) return 0;
    return Math.round(this.book.locations.percentageFromCfi(cfi) * 100);
  }

  getCFIFromPercent(pct) {
    return this.book?.locations?.cfiFromPercentage(pct / 100);
  }

  getCurrentCFI() {
    return this.currentLocation?.start?.cfi ?? null;
  }

  // ─── Themes ───────────────────────────────────────────────────────────────
  applyTheme(name, styles) {
    if (!this.rendition) return;
    this.rendition.themes.register(name, styles);
    this.rendition.themes.select(name);
    this._currentThemeName = name;
  }

  applyFontSize(px) {
    this.rendition?.themes.fontSize(`${px}px`);
  }

  applyCSS(css) {
    this.rendition?.themes.override('body', { all: 'initial' });
    this._customCSS = css;
    this._injectStyles();
  }

  _injectStyles() {
    if (!this._customCSS || !this.rendition) return;
    try {
      const contents = this.rendition.getContents();
      contents.forEach((c) => {
        try { c.addStylesheetRules(this._parsedStyles(this._customCSS)); } catch (_) {}
      });
    } catch (_) {}
  }

  _parsedStyles(css) {
    // Minimal CSS-to-object converter for epub.js addStylesheetRules
    const rules = {};
    const matches = css.matchAll(/([^{]+)\{([^}]+)\}/g);
    for (const [, selector, body] of matches) {
      rules[selector.trim()] = Object.fromEntries(
        body.split(';')
          .filter(Boolean)
          .map((d) => {
            const [k, ...v] = d.split(':');
            return [k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v.join(':').trim()];
          })
      );
    }
    return rules;
  }

  // ─── Annotations / Marks ─────────────────────────────────────────────────
  addHighlight(cfiRange, data = {}) {
    try {
      this.rendition?.annotations.highlight(
        cfiRange,
        data,
        (e) => this._emit('markClicked', { cfiRange, data, event: e }),
        'folio-highlight',
        { fill: data.color ?? 'rgba(255,224,102,0.4)', 'fill-opacity': '1', 'mix-blend-mode': 'multiply' }
      );
    } catch (e) { console.warn('[EpubEngine] addHighlight:', e); }
  }

  addUnderline(cfiRange, data = {}) {
    try {
      this.rendition?.annotations.underline(cfiRange, data, null, 'folio-underline');
    } catch (e) { console.warn('[EpubEngine] addUnderline:', e); }
  }

  addBookmarkMark(cfi) {
    try {
      this.rendition?.annotations.mark(cfi, {}, null);
    } catch (e) { console.warn('[EpubEngine] addBookmarkMark:', e); }
  }

  removeAnnotation(cfiRange, type = 'highlight') {
    try {
      this.rendition?.annotations.remove(cfiRange, type);
    } catch (e) { console.warn('[EpubEngine] removeAnnotation:', e); }
  }

  removeAllAnnotations() {
    try {
      const ann = this.rendition?.annotations;
      if (ann?._annotations) {
        Object.keys(ann._annotations).forEach((key) => {
          const a = ann._annotations[key];
          this.removeAnnotation(a.cfiRange ?? key, a.type ?? 'highlight');
        });
      }
    } catch (_) {}
  }

  // ─── Search ───────────────────────────────────────────────────────────────
  async search(query, options = {}) {
    if (!this.book || !query?.trim()) return [];
    const { maxResults = 50 } = options;
    try {
      const results = await Promise.all(
        this.book.spine.spineItems.map((item) =>
          item.load(this.book.load.bind(this.book))
            .then(() => item.find(query))
            .then((found) => { item.unload(); return found; })
            .catch(() => [])
        )
      );
      return results.flat().slice(0, maxResults);
    } catch (e) {
      console.error('[EpubEngine] Search error:', e);
      return [];
    }
  }

  // ─── TTS Text Extraction ──────────────────────────────────────────────────
  async getVisibleText() {
    if (!this.rendition) return '';
    try {
      const contents = this.rendition.getContents();
      return contents.map((c) => c.document?.body?.innerText ?? '').join(' ');
    } catch (_) { return ''; }
  }

  async getChapterText(href) {
    try {
      const item = this.book.spine.get(href);
      if (!item) return '';
      const doc = await item.load(this.book.load.bind(this.book));
      const text = doc.body?.innerText ?? '';
      item.unload();
      return text;
    } catch (_) { return ''; }
  }

  // ─── Cover ────────────────────────────────────────────────────────────────
  async getCoverUrl() {
    try {
      return await this.book.coverUrl();
    } catch (_) { return null; }
  }

  async getCoverBlob() {
    const url = await this.getCoverUrl();
    if (!url) return null;
    try {
      const resp = await fetch(url);
      return await resp.blob();
    } catch (_) { return null; }
  }

  // ─── Word Count Estimate ──────────────────────────────────────────────────
  async estimateWordCount() {
    if (this._wordCount > 0) return this._wordCount;
    let total = 0;
    try {
      for (const item of this.book.spine.spineItems) {
        const doc = await item.load(this.book.load.bind(this.book));
        total += (doc.body?.innerText?.split(/\s+/).length ?? 0);
        item.unload();
      }
    } catch (_) {}
    this._wordCount = total;
    return total;
  }

  // ─── Flow Mode ────────────────────────────────────────────────────────────
  setFlow(mode) {
    // mode: 'paginated' | 'scrolled-continuous'
    if (!this.rendition) return;
    this.rendition.flow(mode);
  }

  setSpread(value) {
    this.rendition?.spread(value); // 'none' | 'auto'
  }

  // ─── Keyboard / Gestures ─────────────────────────────────────────────────
  attachKeyboardNav(element) {
    element.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        this.next();
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        this.prev();
      }
    });
  }

  attachSwipeNav(element) {
    let startX = 0;
    element.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    element.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) < 50) return;
      dx > 0 ? this.prev() : this.next();
    }, { passive: true });
  }

  // ─── Events ───────────────────────────────────────────────────────────────
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter((f) => f !== fn));
  }

  _emit(event, data) {
    (this._listeners.get(event) ?? []).forEach((fn) => fn(data));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  destroy() {
    try { this.book?.destroy(); } catch (_) {}
    this.book = null;
    this.rendition = null;
    this.currentLocation = null;
    this._listeners.clear();
  }
}

export default EpubEngine;
