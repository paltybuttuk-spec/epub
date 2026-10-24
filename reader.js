// reader.js — Full reader view controller
import { EpubEngine }       from './epub-engine.js';
import { AnnotationManager } from './annotations.js';
import { TTSEngine }         from './tts.js';
import { settings, buildReaderCSS, READING_THEMES, FONT_OPTIONS, applyAppTheme } from './settings.js';
import { saveProgress, getProgress, updateBookMeta, startSession, endSession } from './db.js';
import { toast }            from './utils.js';

export class ReaderController {
  constructor() {
    this.engine      = new EpubEngine();
    this.annotations = null;
    this.tts         = new TTSEngine();
    this.bookId      = null;
    this.bookMeta    = null;
    this._sessionId  = null;
    this._sessionWordCount = 0;
    this._readTimer  = null;
    this._pendingHighlight = null;
    this._wordsRead  = 0;
    this._initUI();
  }

  // ─── UI References ────────────────────────────────────────────────────
  _initUI() {
    this.$ = (sel) => document.querySelector(sel);
    this.$$ = (sel) => [...document.querySelectorAll(sel)];

    this._el = {
      view:         this.$('#view-reader'),
      canvas:       this.$('#reader-canvas'),
      renderArea:   this.$('#epub-render-area'),
      title:        this.$('#reader-title'),
      author:       this.$('#reader-author'),
      progress:     this.$('#reader-progress'),
      locationPct:  this.$('#location-percent'),
      timeLeft:     this.$('#location-time-left'),
      toolbarTop:   this.$('#reader-toolbar-top'),
      toolbarBot:   this.$('#reader-toolbar-bottom'),
      ttsBar:       this.$('#tts-bar'),
      sidebarToc:   this.$('#sidebar-toc'),
      sidebarAnn:   this.$('#sidebar-annotations'),
      tocNav:       this.$('#toc-nav'),
      annList:      this.$('#annotation-list'),
      hlMenu:       this.$('#highlight-menu'),
      searchModal:  this.$('#modal-book-search'),
      searchInput:  this.$('#book-search-input'),
      searchResults:this.$('#search-results'),
      settingsModal:this.$('#modal-reader-settings'),
      noteModal:    this.$('#modal-note'),
      noteQuote:    this.$('#note-quote'),
      noteText:     this.$('#note-text'),
      backdrop:     this.$('#modal-backdrop'),
      sbBackdrop:   this.$('#sidebar-backdrop'),
    };
    this._bindStaticEvents();
  }

  // ─── Open Book ────────────────────────────────────────────────────────
  async open(bookId, arrayBuffer, meta) {
    this.bookId   = bookId;
    this.bookMeta = meta;
    this._el.title.textContent  = meta.title ?? 'Unknown';
    this._el.author.textContent = meta.author ?? '';

    const { navigation } = await this.engine.open(arrayBuffer);
    const rendition = this.engine.renderTo(this._el.renderArea, {
      width:  '100%',
      height: '100%',
      flow:   settings.get('flow'),
      spread: settings.get('spread'),
    });

    this.annotations = new AnnotationManager(this.engine, bookId);
    await this.annotations.load();

    // Apply saved display settings
    this._applyAllDisplaySettings();

    // Restore position
    const saved = await getProgress(bookId);
    await rendition.display(saved?.cfi ?? undefined);

    // Load locations for progress bar
    this.engine.generateLocations(1650).then((locs) => {
      if (locs) this._updateProgress();
    });

    // Build TOC
    this._buildTOC(navigation?.toc ?? []);

    // Re-apply annotations on each render
    this.engine.on('rendered', () => {
      this.annotations.reapplyAll();
      this._attachIframeEvents();
    });

    // Progress tracking
    this.engine.on('relocated', (loc) => {
      this._onRelocated(loc);
    });

    // Swipe & keyboard
    this.engine.attachSwipeNav(this._el.canvas);
    this.engine.attachKeyboardNav(document);

    // Reading session
    this._sessionId = await startSession(bookId);
    this._startReadTimer();

    // Mark last opened
    await updateBookMeta(bookId, { lastOpened: Date.now() });

    // Show view
    this._show();
  }

  // ─── Display & Cleanup ────────────────────────────────────────────────
  _show() {
    document.getElementById('view-library').hidden = true;
    this._el.view.hidden = false;
    this._el.view.removeAttribute('hidden');
    document.title = `${this.bookMeta?.title ?? 'Reading'} — Folio`;
    if (settings.get('autoFullscreen') && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  async close() {
    this._stopReadTimer();
    if (this._sessionId) {
      await endSession(this._sessionId, this._wordsRead);
      this._sessionId = null;
    }
    if (this.currentCFI) {
      await saveProgress(this.bookId, { cfi: this.currentCFI, percent: this.currentPercent });
      await updateBookMeta(this.bookId, { readPercent: this.currentPercent });
    }
    this.tts.stop();
    this.engine.destroy();
    this.annotations = null;
    this._el.view.hidden = true;
    document.getElementById('view-library').hidden = false;
    document.title = 'Folio — EPUB Reader';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  // ─── Progress / Location ──────────────────────────────────────────────
  _onRelocated(loc) {
    this.currentCFI     = loc.start.cfi;
    this.currentPercent = this.engine.getPercentage(loc.start.cfi);
    this._updateProgress();
    this._autosaveProgress();
    this._updateBookmarkIcon();
    this._wordsRead += 50; // approximate words per page turn
  }

  _updateProgress() {
    const pct = this.currentPercent ?? 0;
    this._el.progress.value    = pct;
    this._el.locationPct.textContent = `${pct}%`;
    const wpm = 250;
    const wc  = this.bookMeta?.wordCount ?? 0;
    if (wc && pct < 100) {
      const remaining = Math.round((wc * (1 - pct / 100)) / wpm);
      this._el.timeLeft.textContent = remaining > 60
        ? `~${Math.round(remaining / 60)}h left`
        : `~${remaining}m left`;
    } else {
      this._el.timeLeft.textContent = '';
    }
  }

  _autosaveProgress = debounce(async () => {
    if (!this.currentCFI || !this.bookId) return;
    await saveProgress(this.bookId, { cfi: this.currentCFI, percent: this.currentPercent });
    await updateBookMeta(this.bookId, { readPercent: this.currentPercent });
  }, 5000);

  // ─── Progress Slider ─────────────────────────────────────────────────
  _bindProgressSlider() {
    this._el.progress.addEventListener('input', debounce(async (e) => {
      const pct = +e.target.value;
      const cfi = this.engine.getCFIFromPercent(pct);
      if (cfi) await this.engine.display(cfi);
    }, 300));
  }

  // ─── Display Settings ─────────────────────────────────────────────────
  _applyAllDisplaySettings() {
    const css = buildReaderCSS(settings.getAll());
    this.engine.applyCSS(css);
    const theme = READING_THEMES.find((t) => t.id === settings.get('readerTheme'));
    if (theme) {
      this.engine.applyTheme(settings.get('readerTheme'), { body: { background: theme.bg, color: theme.fg } });
    }
    this.engine.applyFontSize(settings.get('fontSize'));
    this.engine.setFlow(settings.get('flow') === 'scroll' ? 'scrolled-continuous' : 'paginated');
    this._updateSideNav(settings.get('flow') !== 'scroll');
  }

  _updateSideNav(showSwipeZones) {
    document.getElementById('swipe-prev').hidden = !showSwipeZones;
    document.getElementById('swipe-next').hidden = !showSwipeZones;
  }

  // ─── TOC ──────────────────────────────────────────────────────────────
  _buildTOC(toc) {
    this._el.tocNav.innerHTML = toc.length
      ? this._renderTOCItems(toc)
      : '<p class="toc-empty">No table of contents.</p>';

    this._el.tocNav.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-href]');
      if (!item) return;
      await this.engine.goToChapter(item.dataset.href);
      this._closeSidebars();
    });
  }

  _renderTOCItems(items, depth = 0) {
    return items.map((item) => `
      <div class="toc-item toc-item--d${Math.min(depth, 3)}" data-href="${escAttr(item.href ?? '')}">
        ${escHtml(item.label?.trim() ?? '')}
      </div>
      ${item.subitems?.length ? this._renderTOCItems(item.subitems, depth + 1) : ''}
    `).join('');
  }

  // ─── Annotations Sidebar ──────────────────────────────────────────────
  _refreshAnnotationSidebar(filter = 'all') {
    if (!this.annotations) return;
    this._el.annList.innerHTML = this.annotations.renderAnnotationList(filter);
    this._el.annList.querySelectorAll('.ann-item').forEach((el) => {
      el.addEventListener('click', async (e) => {
        if (e.target.classList.contains('ann-delete')) {
          const id = +e.target.dataset.id;
          await this.annotations.remove(id);
          this._refreshAnnotationSidebar(filter);
          return;
        }
        const cfi = el.dataset.cfi;
        if (cfi) {
          await this.engine.display(cfi);
          this._closeSidebars();
        }
      });
    });
  }

  // ─── Highlight Context Menu ───────────────────────────────────────────
  _showHighlightMenu(cfiRange, x, y, selectedText) {
    this._pendingHighlight = { cfiRange, selectedText };
    const menu = this._el.hlMenu;
    menu.hidden = false;
    const vw = document.documentElement.clientWidth;
    const menuW = 220;
    menu.style.left = `${Math.min(x, vw - menuW - 8)}px`;
    menu.style.top  = `${y + 8}px`;

    menu.querySelectorAll('.hl-color').forEach((btn) => {
      btn.onclick = async () => {
        const { cfiRange: cfr, selectedText: txt } = this._pendingHighlight ?? {};
        if (!cfr) return;
        await this.annotations.addHighlight(cfr, btn.dataset.color, txt);
        this._hideHighlightMenu();
        toast(`Highlighted in ${btn.dataset.color}`);
      };
    });
  }

  _hideHighlightMenu() {
    this._el.hlMenu.hidden = true;
    this._pendingHighlight = null;
  }

  // ─── Iframe Events ────────────────────────────────────────────────────
  _attachIframeEvents() {
    try {
      const contents = this.engine.rendition?.getContents() ?? [];
      contents.forEach((c) => {
        const doc = c.document;
        if (!doc) return;

        doc.addEventListener('mouseup', (e) => this._onIframeMouseUp(e, c));
        doc.addEventListener('touchend', (e) => this._onIframeMouseUp(e, c));
        doc.addEventListener('click', () => this._toggleToolbars());
      });
    } catch (_) {}
  }

  _onIframeMouseUp(e, contents) {
    const sel = contents.window?.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      this._hideHighlightMenu();
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      const cfiRange = contents.cfiFromRange(range);
      const text     = sel.toString().trim();
      const rect     = range.getBoundingClientRect();
      const iframe   = this._el.renderArea.querySelector('iframe');
      const iRect    = iframe?.getBoundingClientRect() ?? { left: 0, top: 0 };
      this._showHighlightMenu(cfiRange, iRect.left + rect.left, iRect.top + rect.bottom, text);
    } catch (_) {}
  }

  // ─── Toolbar Visibility ───────────────────────────────────────────────
  _toggleToolbars() {
    const hidden = this._el.toolbarTop.classList.toggle('hidden');
    this._el.toolbarBot.classList.toggle('hidden', hidden);
  }

  // ─── Bookmark ─────────────────────────────────────────────────────────
  async _toggleBookmark() {
    if (!this.currentCFI || !this.annotations) return;
    const has = this.annotations.hasBookmark(this.currentCFI);
    if (has) {
      await this.annotations.removeBookmark(this.currentCFI);
      toast('Bookmark removed');
    } else {
      await this.annotations.addBookmark(this.currentCFI);
      toast('Bookmark added 🔖');
    }
    this._updateBookmarkIcon();
    this._refreshAnnotationSidebar();
  }

  _updateBookmarkIcon() {
    const btn = document.getElementById('btn-bookmark-add');
    if (!btn || !this.annotations) return;
    const has = this.currentCFI && this.annotations.hasBookmark(this.currentCFI);
    btn.querySelector('path')?.setAttribute('fill', has ? 'currentColor' : 'none');
    btn.setAttribute('aria-label', has ? 'Remove bookmark' : 'Add bookmark');
  }

  // ─── TTS ──────────────────────────────────────────────────────────────
  async _startTTS() {
    const text = await this.engine.getVisibleText();
    if (!text.trim()) { toast('No text to read'); return; }

    this._el.ttsBar.hidden = false;
    document.getElementById('tts-voice').innerHTML = this.tts.buildVoiceOptions();
    this.tts.setRate(settings.get('ttsRate'));
    if (settings.get('ttsVoice')) this.tts.setVoice(settings.get('ttsVoice'));

    this.tts.speak(text, {
      onEnd: () => {
        this._updateTTSPlayIcon(false);
        // Auto-advance to next page/chapter
        this.engine.next().then(() => setTimeout(() => this._startTTS(), 400));
      },
    });
    this._updateTTSPlayIcon(true);
  }

  _updateTTSPlayIcon(playing) {
    document.getElementById('tts-play-icon').hidden  =  playing;
    document.getElementById('tts-pause-icon').hidden = !playing;
  }

  // ─── In-Book Search ───────────────────────────────────────────────────
  async _runSearch(query) {
    this._el.searchResults.innerHTML = '<div class="search-loading">Searching…</div>';
    const results = await this.engine.search(query, { maxResults: 50 });
    if (!results.length) {
      this._el.searchResults.innerHTML = '<div class="search-empty">No results found.</div>';
      return;
    }
    this._el.searchResults.innerHTML = results.map((r) =>
      `<div class="search-result" data-cfi="${escAttr(r.cfi)}" role="option" tabindex="0">
        <span class="search-excerpt">${highlight(escHtml(r.excerpt), query)}</span>
      </div>`
    ).join('');
    this._el.searchResults.querySelectorAll('.search-result').forEach((el) => {
      el.addEventListener('click', async () => {
        await this.engine.display(el.dataset.cfi);
        this._closeModals();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.click();
      });
    });
  }

  // ─── Settings Panel Build ─────────────────────────────────────────────
  _buildSettingsPanel() {
    // Themes
    const themeGrid = document.getElementById('theme-grid');
    themeGrid.innerHTML = READING_THEMES.map((t) => `
      <label class="theme-swatch ${settings.get('readerTheme') === t.id ? 'active' : ''}"
             style="--bg:${t.bg};--fg:${t.fg};--acc:${t.accent}"
             data-theme="${t.id}" role="radio"
             aria-checked="${settings.get('readerTheme') === t.id}"
             tabindex="0">
        <input type="radio" name="reader-theme" value="${t.id}" ${settings.get('readerTheme') === t.id ? 'checked' : ''} />
        <span class="theme-swatch-preview"><span></span><span></span><span></span></span>
        <span class="theme-swatch-label">${t.label}</span>
      </label>
    `).join('');

    // Fonts
    const fontGrid = document.getElementById('font-grid');
    const { FONT_OPTIONS: fonts } = await import('./settings.js').catch(() => ({ FONT_OPTIONS: [] }));
    fontGrid.innerHTML = FONT_OPTIONS.map((f) => `
      <label class="font-chip ${settings.get('fontFamily') === f.id ? 'active' : ''}"
             style="${f.style}" data-font="${f.id}" role="radio"
             aria-checked="${settings.get('fontFamily') === f.id}">
        <input type="radio" name="reader-font" value="${f.id}" ${settings.get('fontFamily') === f.id ? 'checked' : ''} />
        ${f.label}
      </label>
    `).join('');

    // Sync slider values from settings
    document.getElementById('font-size-slider').value    = settings.get('fontSize');
    document.getElementById('font-size-value').textContent = `${settings.get('fontSize')}px`;
    document.getElementById('line-height-slider').value  = settings.get('lineHeight');
    document.getElementById('line-height-value').textContent = settings.get('lineHeight').toFixed(1);
    document.getElementById('margin-slider').value       = settings.get('margin');
    document.getElementById('margin-value').textContent  = `${settings.get('margin')}%`;
    document.getElementById('toggle-justify').checked    = settings.get('justify');
    document.getElementById('toggle-hyphenate').checked  = settings.get('hyphenate');
    const flowPag = document.querySelector('input[name="flow"][value="paginated"]');
    const flowScr = document.querySelector('input[name="flow"][value="scroll"]');
    if (flowPag) flowPag.checked = settings.get('flow') === 'paginated';
    if (flowScr) flowScr.checked = settings.get('flow') === 'scroll';
  }

  // ─── Static Event Binding ─────────────────────────────────────────────
  _bindStaticEvents() {
    const { _el: el } = this;

    // Back button
    document.getElementById('btn-back-to-library')
      ?.addEventListener('click', () => this.close());

    // Previous / Next page
    document.getElementById('swipe-prev')
      ?.addEventListener('click', () => this.engine.prev());
    document.getElementById('swipe-next')
      ?.addEventListener('click', () => this.engine.next());
    document.getElementById('btn-prev-chapter')
      ?.addEventListener('click', () => this.engine.prev());
    document.getElementById('btn-next-chapter')
      ?.addEventListener('click', () => this.engine.next());

    // Progress scrubber
    this._bindProgressSlider();

    // TOC
    document.getElementById('btn-sidebar-toc')?.addEventListener('click', () => {
      el.sidebarToc.hidden = !el.sidebarToc.hidden;
      el.sbBackdrop.hidden = el.sidebarToc.hidden && el.sidebarAnn.hidden;
    });
    document.getElementById('btn-close-toc')?.addEventListener('click', () => this._closeSidebars());

    // Annotations sidebar
    document.getElementById('btn-close-annotations')?.addEventListener('click', () => this._closeSidebars());
    document.querySelectorAll('.ann-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ann-filter-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this._refreshAnnotationSidebar(btn.dataset.filter);
      });
    });
    document.getElementById('btn-export-annotations')?.addEventListener('click', () => {
      const md = this.annotations?.exportMarkdown(this.bookMeta?.title ?? '', this.bookMeta?.author ?? '');
      if (!md) return;
      downloadText(md, `${this.bookMeta?.title ?? 'notes'}.md`, 'text/markdown');
    });

    // Bookmark
    document.getElementById('btn-bookmark-add')
      ?.addEventListener('click', () => this._toggleBookmark());

    // Search
    document.getElementById('btn-search-in-book')?.addEventListener('click', () => {
      el.searchModal.hidden = false; el.backdrop.hidden = false;
      el.searchInput.focus();
    });
    document.getElementById('btn-close-book-search')
      ?.addEventListener('click', () => this._closeModals());
    el.searchInput?.addEventListener('input', debounce((e) => {
      const q = e.target.value.trim();
      if (q.length >= 2) this._runSearch(q);
    }, 400));

    // TTS
    document.getElementById('btn-tts')?.addEventListener('click', () => {
      el.ttsBar.hidden ? this._startTTS() : this.tts.stop();
      if (!el.ttsBar.hidden) el.ttsBar.hidden = true;
    });
    document.getElementById('tts-play-pause')?.addEventListener('click', () => {
      if (this.tts.isPlaying) this.tts.pause();
      else if (this.tts.isPaused) this.tts.resume();
      else this._startTTS();
      this._updateTTSPlayIcon(this.tts.isPlaying);
    });
    document.getElementById('tts-stop')?.addEventListener('click', () => {
      this.tts.stop(); el.ttsBar.hidden = true;
    });
    document.getElementById('tts-prev-sentence')?.addEventListener('click', () => this.tts.skipBack());
    document.getElementById('tts-next-sentence')?.addEventListener('click', () => this.tts.skipForward());
    document.getElementById('tts-rate')?.addEventListener('input', async (e) => {
      const r = +e.target.value;
      this.tts.setRate(r);
      document.getElementById('tts-rate-label').textContent = `${r.toFixed(1)}×`;
      await settings.set('ttsRate', r);
    });
    document.getElementById('tts-voice')?.addEventListener('change', async (e) => {
      this.tts.setVoice(e.target.value);
      await settings.set('ttsVoice', e.target.value);
    });

    // Reader settings modal
    document.getElementById('btn-reader-settings')?.addEventListener('click', async () => {
      this._buildSettingsPanel();
      el.settingsModal.hidden = false; el.backdrop.hidden = false;
    });
    document.getElementById('btn-close-reader-settings')?.addEventListener('click', () => this._closeModals());
    this._bindSettingControls();

    // Note modal
    document.getElementById('btn-note-save')?.addEventListener('click', async () => {
      const text = document.getElementById('note-text').value.trim();
      if (!text) return;
      const { cfiRange, selectedText } = this._pendingHighlight ?? {};
      if (cfiRange) {
        const hl = await this.annotations.addHighlight(cfiRange, 'yellow', selectedText);
        await this.annotations.addNote(hl.id, text);
      }
      this._closeModals();
      this._refreshAnnotationSidebar();
      toast('Note saved 📝');
    });
    document.getElementById('btn-note-cancel')?.addEventListener('click', () => this._closeModals());
    document.getElementById('btn-close-note')?.addEventListener('click',  () => this._closeModals());

    // Highlight menu actions
    document.getElementById('ctx-add-note')?.addEventListener('click', () => {
      el.hlMenu.hidden = true;
      const { selectedText } = this._pendingHighlight ?? {};
      el.noteQuote.textContent = (selectedText ?? '').slice(0, 200);
      el.noteText.value = '';
      el.noteModal.hidden = false; el.backdrop.hidden = false;
    });
    document.getElementById('ctx-define')?.addEventListener('click', () => {
      const word = (this._pendingHighlight?.selectedText ?? '').trim().split(/\s+/)[0];
      if (word) window.open(`https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`, '_blank', 'noopener');
      this._hideHighlightMenu();
    });
    document.getElementById('ctx-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(this._pendingHighlight?.selectedText ?? '').catch(() => {});
      this._hideHighlightMenu();
      toast('Copied');
    });
    document.getElementById('ctx-remove-hl')?.addEventListener('click', async () => {
      const cfi = this._pendingHighlight?.cfiRange;
      if (cfi) {
        const ann = this.annotations.getHighlights().find((a) => a.cfi === cfi);
        if (ann) await this.annotations.remove(ann.id);
      }
      this._hideHighlightMenu();
    });

    // Backdrop closes modals
    el.backdrop?.addEventListener('click', () => this._closeModals());
    el.sbBackdrop?.addEventListener('click', () => this._closeSidebars());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if (!this._el.view || this._el.view.hidden) return;
      if (e.key === 'Escape') { this._closeModals(); this._closeSidebars(); this._hideHighlightMenu(); }
      if (e.key === 'b' || e.key === 'B') this._toggleBookmark();
      if (e.key === 't' || e.key === 'T') document.getElementById('btn-tts')?.click();
      if (e.key === 'c' || e.key === 'C') document.getElementById('btn-sidebar-toc')?.click();
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('btn-search-in-book')?.click();
      }
    });
  }

  _bindSettingControls() {
    // Theme swatches
    document.getElementById('theme-grid')?.addEventListener('click', async (e) => {
      const sw = e.target.closest('[data-theme]');
      if (!sw) return;
      await settings.set('readerTheme', sw.dataset.theme);
      this._applyAllDisplaySettings();
      document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.theme === sw.dataset.theme));
    });

    // Font chips
    document.getElementById('font-grid')?.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-font]');
      if (!chip) return;
      await settings.set('fontFamily', chip.dataset.font);
      this._applyAllDisplaySettings();
      document.querySelectorAll('.font-chip').forEach((c) => c.classList.toggle('active', c.dataset.font === chip.dataset.font));
    });

    // Font size slider
    document.getElementById('font-size-slider')?.addEventListener('input', async (e) => {
      const val = +e.target.value;
      document.getElementById('font-size-value').textContent = `${val}px`;
      await settings.set('fontSize', val);
      this.engine.applyFontSize(val);
    });
    document.getElementById('font-size-dec')?.addEventListener('click', async () => {
      const cur = settings.get('fontSize');
      const next = Math.max(12, cur - 1);
      await settings.set('fontSize', next);
      document.getElementById('font-size-slider').value = next;
      document.getElementById('font-size-value').textContent = `${next}px`;
      this.engine.applyFontSize(next);
    });
    document.getElementById('font-size-inc')?.addEventListener('click', async () => {
      const cur = settings.get('fontSize');
      const next = Math.min(36, cur + 1);
      await settings.set('fontSize', next);
      document.getElementById('font-size-slider').value = next;
      document.getElementById('font-size-value').textContent = `${next}px`;
      this.engine.applyFontSize(next);
    });

    // Line height
    document.getElementById('line-height-slider')?.addEventListener('input', async (e) => {
      const val = parseFloat(e.target.value);
      document.getElementById('line-height-value').textContent = val.toFixed(1);
      await settings.set('lineHeight', val);
      this._applyAllDisplaySettings();
    });

    // Margin
    document.getElementById('margin-slider')?.addEventListener('input', async (e) => {
      const val = +e.target.value;
      document.getElementById('margin-value').textContent = `${val}%`;
      await settings.set('margin', val);
      this._applyAllDisplaySettings();
    });

    // Flow
    document.querySelectorAll('input[name="flow"]').forEach((radio) => {
      radio.addEventListener('change', async (e) => {
        await settings.set('flow', e.target.value);
        this.engine.setFlow(e.target.value === 'scroll' ? 'scrolled-continuous' : 'paginated');
        this._updateSideNav(e.target.value !== 'scroll');
      });
    });

    // Toggles
    document.getElementById('toggle-justify')?.addEventListener('change', async (e) => {
      await settings.set('justify', e.target.checked);
      this._applyAllDisplaySettings();
    });
    document.getElementById('toggle-hyphenate')?.addEventListener('change', async (e) => {
      await settings.set('hyphenate', e.target.checked);
      this._applyAllDisplaySettings();
    });
    document.getElementById('toggle-fullscreen')?.addEventListener('change', async (e) => {
      await settings.set('autoFullscreen', e.target.checked);
      if (e.target.checked) document.documentElement.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.().catch(() => {});
    });
  }

  // ─── Sidebar / Modal Helpers ──────────────────────────────────────────
  _closeSidebars() {
    this._el.sidebarToc.hidden = true;
    this._el.sidebarAnn.hidden = true;
    this._el.sbBackdrop.hidden = true;
  }

  _closeModals() {
    this._el.settingsModal.hidden = true;
    this._el.searchModal.hidden  = true;
    this._el.noteModal.hidden    = true;
    this._el.backdrop.hidden     = true;
  }

  // ─── Read Timer ───────────────────────────────────────────────────────
  _startReadTimer() {
    this._readTimer = setInterval(() => {
      this._wordsRead += Math.round(settings.get('ttsRate') * 250 / 60); // approx WPM per minute
    }, 60_000);
  }

  _stopReadTimer() {
    clearInterval(this._readTimer);
    this._readTimer = null;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escHtml(s)  { return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s)  { return (s ?? '').replace(/"/g, '&quot;'); }

function highlight(text, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

function downloadText(content, filename, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { debounce };
