// pdf-viewer.js — Acrobat-style PDF viewer built on pdf.js
// Features: continuous scroll, zoom/fit modes, rotate, two-page spread, thumbnails,
// outline, find, text markup (highlight/underline/strikethrough), ink, sticky notes,
// eraser, links, print, download, document properties, fullscreen, dark-page mode.
import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import '../styles/pdf.css';
import {
  saveProgress, getProgress, updateBookMeta, saveAnnotation, getAnnotationsForBook,
  deleteAnnotation, getSetting, setSetting, startSession, endSession,
} from './db.js';
import { toast } from './utils.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const CSS_UNITS = 96 / 72;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const COLORS = ['#FFD60A', '#30D158', '#0A84FF', '#FF375F', '#FF9F0A'];
const SVGNS = 'http://www.w3.org/2000/svg';

const ICONS = {
  back: '<path d="M13 4L7 10l6 6"/>',
  sidebar: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M8 4v12"/>',
  minus: '<path d="M4 10h12"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  fitw: '<path d="M3 5v10M17 5v10M6 10h8M8 8l-2 2 2 2M12 8l2 2-2 2"/>',
  fitp: '<rect x="5" y="3" width="10" height="14" rx="1"/><path d="M8 7h4M8 10h4"/>',
  rotate: '<path d="M16 10a6 6 0 1 1-2-4.5"/><path d="M16 3v3.5h-3.5"/>',
  spread: '<rect x="3" y="4" width="6" height="12" rx="1"/><rect x="11" y="4" width="6" height="12" rx="1"/>',
  ink: '<path d="M3 17l1-4 9-9 3 3-9 9-4 1z"/><path d="M11 6l3 3"/>',
  note: '<path d="M4 4h12v9H9l-4 3v-3H4z"/>',
  eraser: '<path d="M4 13l7-8 5 4-6 7H6z"/><path d="M8 17h9"/>',
  find: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 3.5 3.5"/>',
  print: '<path d="M6 8V3h8v5M6 14H4V8h12v6h-2"/><rect x="6" y="12" width="8" height="5"/>',
  download: '<path d="M10 3v10M6 9l4 4 4-4M4 17h12"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5v.5"/>',
  full: '<path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4"/>',
  moon: '<path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5z"/>',
  hl: '<path d="M4 15l4-1 8-8-3-3-8 8-1 4z"/><path d="M3 18h14"/>',
  ul: '<path d="M6 4v6a4 4 0 0 0 8 0V4M4 17h12"/>',
  st: '<path d="M14 6c-1-2-6-2-7 0s1 3 3 4 4 2 3 4-6 2-7 0M3 10h14"/>',
  copy: '<rect x="7" y="7" width="9" height="10" rx="1"/><path d="M13 7V4H4v10h3"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/>',
};
const ico = (n) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ─── Import helper (used by library.js) ───────────────────────────────────────
export async function readPdfInfo(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => ({ info: {} }));
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 360 / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const info = meta?.info ?? {};
    return {
      title: info.Title || '',
      author: info.Author || '',
      subject: info.Subject || '',
      keywords: info.Keywords || '',
      pageCount: doc.numPages,
      cover: canvas.toDataURL('image/jpeg', 0.82),
    };
  } finally {
    doc.destroy();
  }
}

// ─── Viewer ───────────────────────────────────────────────────────────────────
export class PdfViewer {
  constructor() {
    this.doc = null;
    this.recs = [];
    this.marks = [];
    this.zoom = 'width'; // 'width' | 'page' | number (1 = 100%)
    this.rotation = 0;
    this.spread = false;
    this.tool = 'select';
    this.color = COLORS[0];
    this.scale = 1;
    this.curPage = 1;
    this.findQuery = '';
    this.findHits = [];
    this.findIdx = -1;
    this._textCache = new Map();
    this._build();
    this._bind();
  }

  // ─── DOM ────────────────────────────────────────────────────────────────
  _build() {
    const v = document.createElement('div');
    v.id = 'view-pdf';
    v.className = 'view pdf-view';
    v.hidden = true;
    v.dataset.tool = 'select';
    v.innerHTML = `
      <header class="pdf-toolbar">
        <button class="btn-icon" data-act="back" title="Back (Esc)" aria-label="Back to library">${ico('back')}</button>
        <button class="btn-icon" data-act="sidebar" title="Sidebar (S)" aria-label="Toggle sidebar">${ico('sidebar')}</button>
        <span class="pdf-title" id="pdf-title">—</span>
        <div class="pdf-group">
          <input id="pdf-page-input" class="pdf-page-input" type="number" min="1" value="1" aria-label="Page number" />
          <span class="pdf-page-total" id="pdf-page-total">/ 1</span>
        </div>
        <div class="pdf-group">
          <button class="btn-icon" data-act="zoom-out" title="Zoom out (−)" aria-label="Zoom out">${ico('minus')}</button>
          <select id="pdf-zoom" class="pdf-zoom" aria-label="Zoom level">
            <option value="width">Fit width</option><option value="page">Fit page</option>
            ${ZOOM_STEPS.map((z) => `<option value="${z}">${Math.round(z * 100)}%</option>`).join('')}
          </select>
          <button class="btn-icon" data-act="zoom-in" title="Zoom in (+)" aria-label="Zoom in">${ico('plus')}</button>
        </div>
        <div class="pdf-group pdf-group--view">
          <button class="btn-icon" data-act="fit-width" title="Fit width (0)" aria-label="Fit width">${ico('fitw')}</button>
          <button class="btn-icon" data-act="fit-page" title="Fit page" aria-label="Fit page">${ico('fitp')}</button>
          <button class="btn-icon" data-act="rotate" title="Rotate (R)" aria-label="Rotate clockwise">${ico('rotate')}</button>
          <button class="btn-icon" data-act="spread" title="Two-page view" aria-label="Two-page view">${ico('spread')}</button>
        </div>
        <div class="pdf-group pdf-group--tools">
          <button class="btn-icon" data-tool="ink" title="Draw (D)" aria-label="Draw">${ico('ink')}</button>
          <button class="btn-icon" data-tool="note" title="Add note (N)" aria-label="Add note">${ico('note')}</button>
          <button class="btn-icon" data-tool="eraser" title="Eraser (E)" aria-label="Erase markup">${ico('eraser')}</button>
          <span class="pdf-swatches" role="radiogroup" aria-label="Markup colour">
            ${COLORS.map((c, i) => `<button class="pdf-swatch${i ? '' : ' is-on'}" data-color="${c}" style="--c:${c}" role="radio" aria-label="Colour ${i + 1}"></button>`).join('')}
          </span>
        </div>
        <div class="pdf-group pdf-group--end">
          <button class="btn-icon" data-act="find" title="Find (Ctrl+F)" aria-label="Find">${ico('find')}</button>
          <button class="btn-icon" data-act="invert" title="Dark pages" aria-label="Toggle dark pages">${ico('moon')}</button>
          <button class="btn-icon" data-act="print" title="Print (Ctrl+P)" aria-label="Print">${ico('print')}</button>
          <button class="btn-icon" data-act="download" title="Download" aria-label="Download PDF">${ico('download')}</button>
          <button class="btn-icon" data-act="props" title="Document properties" aria-label="Document properties">${ico('info')}</button>
          <button class="btn-icon" data-act="full" title="Full screen (F)" aria-label="Full screen">${ico('full')}</button>
        </div>
      </header>
      <div class="pdf-body">
        <aside class="pdf-sidebar" id="pdf-sidebar" hidden>
          <div class="pdf-tabs" role="tablist">
            <button role="tab" data-tab="thumbs" class="is-on">Pages</button>
            <button role="tab" data-tab="outline">Outline</button>
            <button role="tab" data-tab="marks">Markups</button>
            <button role="tab" data-tab="find">Find</button>
          </div>
          <div class="pdf-pane" data-pane="thumbs"></div>
          <div class="pdf-pane" data-pane="outline" hidden></div>
          <div class="pdf-pane" data-pane="marks" hidden></div>
          <div class="pdf-pane" data-pane="find" hidden>
            <div class="pdf-find-bar">
              <input id="pdf-find-input" type="search" placeholder="Find in document" aria-label="Find in document" />
              <button class="btn-icon" data-act="find-prev" aria-label="Previous match">${ico('back')}</button>
              <button class="btn-icon pdf-next" data-act="find-next" aria-label="Next match">${ico('back')}</button>
            </div>
            <div class="pdf-find-status" id="pdf-find-status"></div>
            <ol class="pdf-find-list" id="pdf-find-list"></ol>
          </div>
        </aside>
        <div class="pdf-scroll" id="pdf-scroll" tabindex="0"><div class="pdf-pages" id="pdf-pages"></div></div>
      </div>
      <div class="pdf-pop" id="pdf-pop" hidden>
        <button data-pop="highlight" aria-label="Highlight">${ico('hl')}</button>
        <button data-pop="underline" aria-label="Underline">${ico('ul')}</button>
        <button data-pop="strike" aria-label="Strikethrough">${ico('st')}</button>
        <button data-pop="copy" aria-label="Copy">${ico('copy')}</button>
      </div>
      <dialog class="pdf-dialog" id="pdf-note-dialog">
        <form method="dialog">
          <h3 id="pdf-note-title">Note</h3>
          <textarea id="pdf-note-text" rows="5" aria-label="Note text"></textarea>
          <div class="pdf-dialog-actions">
            <button value="delete" class="btn-ghost danger" id="pdf-note-delete">Delete</button>
            <span style="flex:1"></span>
            <button value="cancel" class="btn-ghost">Cancel</button>
            <button value="save" class="btn-primary">Save</button>
          </div>
        </form>
      </dialog>
      <dialog class="pdf-dialog" id="pdf-props-dialog">
        <form method="dialog">
          <h3>Document properties</h3>
          <dl class="pdf-props" id="pdf-props-list"></dl>
          <div class="pdf-dialog-actions"><span style="flex:1"></span><button value="close" class="btn-primary">Close</button></div>
        </form>
      </dialog>`;
    document.body.appendChild(v);
    this.view = v;
    this.scroll = v.querySelector('#pdf-scroll');
    this.pagesEl = v.querySelector('#pdf-pages');
    this.sidebar = v.querySelector('#pdf-sidebar');
    this.pageInput = v.querySelector('#pdf-page-input');
    this.zoomSel = v.querySelector('#pdf-zoom');
    this.pop = v.querySelector('#pdf-pop');
  }

  _bind() {
    this.view.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) return this._action(act);
      const tool = e.target.closest('[data-tool]')?.dataset.tool;
      if (tool) return this.setTool(this.tool === tool ? 'select' : tool);
      const sw = e.target.closest('[data-color]');
      if (sw) return this._setColor(sw.dataset.color);
      const tab = e.target.closest('[data-tab]')?.dataset.tab;
      if (tab) return this._showTab(tab);
    });

    this.pageInput.addEventListener('change', () => this.goTo(parseInt(this.pageInput.value, 10) || 1));
    this.zoomSel.addEventListener('change', () => {
      const v = this.zoomSel.value;
      this.setZoom(v === 'width' || v === 'page' ? v : parseFloat(v));
    });

    this.scroll.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    new ResizeObserver(debounce(() => { if (!this.view.hidden && this.doc && typeof this.zoom === 'string') this._layout(); }, 150))
      .observe(this.scroll);

    // Selection popover (highlight / underline / strikethrough / copy)
    document.addEventListener('selectionchange', debounce(() => this._updatePop(), 120));
    this.pop.addEventListener('mousedown', (e) => e.preventDefault());
    this.pop.addEventListener('click', (e) => {
      const kind = e.target.closest('[data-pop]')?.dataset.pop;
      if (!kind) return;
      if (kind === 'copy') {
        navigator.clipboard?.writeText(String(getSelection())).then(() => toast('Copied'));
        getSelection().removeAllRanges();
      } else {
        this._markFromSelection(kind);
      }
      this.pop.hidden = true;
    });

    // Find
    const fi = this.view.querySelector('#pdf-find-input');
    fi.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = fi.value.trim();
      if (q !== this.findQuery) this._find(q);
      else this._findStep(e.shiftKey ? -1 : 1);
    });

    // Marks sidebar interactions
    this.view.querySelector('[data-pane="marks"]').addEventListener('click', (e) => {
      const li = e.target.closest('[data-mark]');
      if (!li) return;
      const id = Number(li.dataset.mark);
      if (e.target.closest('[data-del]')) this._deleteMark(id);
      else { const m = this.marks.find((x) => x.id === id); if (m) this.goTo(m.page); }
    });
    this.view.querySelector('[data-pane="outline"]').addEventListener('click', (e) => {
      const a = e.target.closest('[data-dest]');
      if (a) this._goDest(JSON.parse(a.dataset.dest));
    });

    document.addEventListener('keydown', (e) => this._onKey(e));
    document.addEventListener('fullscreenchange', () => this._relayoutSoon());
  }

  // ─── Open / Close ───────────────────────────────────────────────────────
  async open(id, buffer, meta) {
    this.bookId = id;
    this.meta = meta;
    this._bytes = buffer;
    const copy = new Uint8Array(buffer.slice(0));
    this.doc = await pdfjs.getDocument({ data: copy, isEvalSupported: false }).promise;
    const first = await this.doc.getPage(1);
    this._page1 = first;
    this.recs = [];

    const saved = (await getProgress(id)) ?? {};
    this.zoom = saved.zoom ?? 'width';
    this.rotation = saved.rotation ?? 0;
    this.spread = !!saved.spread;
    this.curPage = Math.min(Math.max(saved.page ?? 1, 1), this.doc.numPages);
    this.tool = 'select';
    this.view.dataset.tool = 'select';
    this.view.classList.toggle('pdf-invert', !!(await getSetting('pdfInvert', false)));
    this.view.classList.toggle('is-spread', this.spread);
    this.view.querySelector('#pdf-title').textContent = meta?.title ?? 'PDF';
    this.view.querySelector('#pdf-page-total').textContent = `/ ${this.doc.numPages}`;
    this.pageInput.max = this.doc.numPages;
    this.sidebar.hidden = true;

    this.marks = (await getAnnotationsForBook(id)).filter((a) => String(a.type).startsWith('pdf-'));
    this._buildPages();
    document.getElementById('view-library').hidden = true;
    this.view.hidden = false;
    document.title = `${meta?.title ?? 'PDF'} — Folio`;
    await updateBookMeta(id, { lastOpened: Date.now() });
    this._sessionId = await startSession(id).catch(() => null);
    this._layout(this.curPage);
    this._buildThumbs();
    this._buildOutline();
    this._renderMarksList();
    this.scroll.focus({ preventScroll: true });
  }

  async close() {
    await this._saveNow();
    if (this._sessionId) await endSession(this._sessionId, 0).catch(() => {});
    this._sessionId = null;
    this.recs.forEach((r) => this._cleanup(r));
    this.pagesEl.replaceChildren();
    this._thumbObs?.disconnect();
    this.doc?.destroy();
    this.doc = null;
    this.pop.hidden = true;
    this.view.hidden = true;
    document.getElementById('view-library').hidden = false;
    document.title = 'Folio — EPUB Reader';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.onClose?.();
  }

  get isOpen() { return !this.view.hidden; }

  // ─── Layout & rendering ─────────────────────────────────────────────────
  _buildPages() {
    this.pagesEl.replaceChildren();
    this.recs = Array.from({ length: this.doc.numPages }, (_, i) => {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = i + 1;
      el.innerHTML = '<canvas class="pdf-canvas"></canvas><div class="textLayer"></div><div class="pdf-links"></div>';
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'pdf-svg');
      el.appendChild(svg);
      this.pagesEl.appendChild(el);
      const rec = {
        num: i + 1, el, canvas: el.querySelector('canvas'), text: el.querySelector('.textLayer'),
        links: el.querySelector('.pdf-links'), svg, page: null, vp: null, rendered: false, busy: false, token: 0,
      };
      this._bindInk(rec);
      return rec;
    });
  }

  _vpFor(page) {
    return page.getViewport({ scale: this.scale, rotation: (page.rotate + this.rotation) % 360 });
  }

  _computeScale() {
    const vp1 = this._page1.getViewport({ scale: 1, rotation: (this._page1.rotate + this.rotation) % 360 });
    const cols = this.spread ? 2 : 1;
    const gap = 12;
    const availW = Math.max(200, this.scroll.clientWidth - 32 - (cols - 1) * gap) / cols;
    const availH = Math.max(200, this.scroll.clientHeight - 32);
    const w = availW / vp1.width;
    if (this.zoom === 'width') return w;
    if (this.zoom === 'page') return Math.min(w, availH / vp1.height);
    return this.zoom * CSS_UNITS;
  }

  _layout(gotoPage) {
    if (!this.doc) return;
    const keep = gotoPage ?? this.curPage;
    this.scale = this._computeScale();
    this.pagesEl.classList.toggle('is-spread', this.spread);
    const v1 = this._vpFor(this._page1);
    for (const r of this.recs) {
      this._cleanup(r);
      const vp = r.page ? this._vpFor(r.page) : v1;
      this._size(r, vp);
    }
    this._syncZoomUi();
    this._metrics();
    this.goTo(keep, false);
    this._renderVisible();
  }

  _size(r, vp) {
    r.el.style.width = `${vp.width}px`;
    r.el.style.height = `${vp.height}px`;
    r.el.style.setProperty('--scale-factor', vp.scale);
    r.text.style.setProperty('--scale-factor', vp.scale);
    r.svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    r.svg.setAttribute('width', vp.width);
    r.svg.setAttribute('height', vp.height);
  }

  _metrics() {
    this.tops = this.recs.map((r) => r.el.offsetTop);
    this.hts = this.recs.map((r) => r.el.offsetHeight);
  }

  _relayoutSoon = debounce(() => { if (this.isOpen && this.doc) this._layout(); }, 200);

  _renderVisible() {
    if (!this.doc || !this.tops) return;
    const top = this.scroll.scrollTop;
    const bot = top + this.scroll.clientHeight;
    const near = 1200;
    const far = 3500;
    for (let i = 0; i < this.recs.length; i++) {
      const t = this.tops[i];
      const b = t + this.hts[i];
      if (b >= top - near && t <= bot + near) this._renderPage(this.recs[i]);
      else if (this.recs[i].rendered && (b < top - far || t > bot + far)) this._cleanup(this.recs[i]);
    }
  }

  async _renderPage(r) {
    if (r.rendered || r.busy || !this.doc) return;
    r.busy = true;
    const token = ++r.token;
    try {
      r.page ??= await this.doc.getPage(r.num);
      if (token !== r.token) return;
      const vp = this._vpFor(r.page);
      if (Math.abs(vp.width - r.el.offsetWidth) > 1 || Math.abs(vp.height - r.el.offsetHeight) > 1) {
        this._size(r, vp);
        this._metrics();
      }
      r.vp = vp;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      r.canvas.width = Math.floor(vp.width * dpr);
      r.canvas.height = Math.floor(vp.height * dpr);
      r.canvas.style.width = `${vp.width}px`;
      r.canvas.style.height = `${vp.height}px`;
      const ctx = r.canvas.getContext('2d', { alpha: false });
      r.task = r.page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      await r.task.promise;
      if (token !== r.token) return;

      r.text.replaceChildren();
      const tl = new pdfjs.TextLayer({ textContentSource: r.page.streamTextContent(), container: r.text, viewport: vp });
      await tl.render();
      if (token !== r.token) return;
      this._applyFind(r);
      await this._drawLinks(r);
      this._drawMarks(r);
      r.rendered = true;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('[PDF] render failed', r.num, err);
    } finally {
      r.busy = false;
    }
  }

  _cleanup(r) {
    r.token++;
    try { r.task?.cancel(); } catch { /* noop */ }
    r.task = null;
    r.canvas.width = 0;
    r.canvas.height = 0;
    r.text.replaceChildren();
    r.links.replaceChildren();
    r.svg.replaceChildren();
    r.rendered = false;
    r.busy = false;
  }

  async _drawLinks(r) {
    r.links.replaceChildren();
    const anns = await r.page.getAnnotations({ intent: 'display' }).catch(() => []);
    for (const a of anns) {
      if (a.subtype !== 'Link' || (!a.url && !a.dest && !a.unsafeUrl)) continue;
      const [x1, y1, x2, y2] = r.vp.convertToViewportRectangle(a.rect);
      const el = document.createElement('a');
      el.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px`;
      if (a.url || a.unsafeUrl) {
        el.href = a.url || a.unsafeUrl;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
      } else {
        el.href = '#';
        el.addEventListener('click', (ev) => { ev.preventDefault(); this._goDest(a.dest); });
      }
      r.links.appendChild(el);
    }
  }

  // ─── Navigation ─────────────────────────────────────────────────────────
  goTo(n, smooth = true) {
    n = Math.min(Math.max(Math.round(n) || 1, 1), this.recs.length);
    if (!this.tops) return;
    this.scroll.scrollTo({ top: Math.max(0, this.tops[n - 1] - 8), behavior: smooth ? 'smooth' : 'instant' });
    this._setCurrent(n);
  }

  async _goDest(dest) {
    try {
      const d = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!d) return;
      const ref = d[0];
      const idx = typeof ref === 'object' ? await this.doc.getPageIndex(ref) : ref;
      this.goTo(idx + 1);
    } catch (e) { console.warn('[PDF] bad destination', e); }
  }

  _onScroll() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      if (!this.tops) return;
      const y = this.scroll.scrollTop + this.scroll.clientHeight * 0.3;
      let lo = 0; let hi = this.tops.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.tops[m] <= y) lo = m; else hi = m - 1; }
      this._setCurrent(lo + 1);
      this._renderVisible();
    });
  }

  _setCurrent(n) {
    if (n === this.curPage && this.pageInput.value === String(n)) return;
    this.curPage = n;
    this.pageInput.value = n;
    this.view.querySelectorAll('.pdf-thumb.is-on').forEach((t) => t.classList.remove('is-on'));
    const th = this.view.querySelector(`.pdf-thumb[data-page="${n}"]`);
    if (th) { th.classList.add('is-on'); if (!this.sidebar.hidden) th.scrollIntoView({ block: 'nearest' }); }
    this._saveSoon();
  }

  // ─── Zoom / rotate / spread ─────────────────────────────────────────────
  setZoom(z) { this.zoom = z; this._layout(); this._saveSoon(); }

  zoomBy(dir) {
    const cur = this.scale / CSS_UNITS;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.01);
    if (next) this.setZoom(next);
  }

  _syncZoomUi() {
    const v = typeof this.zoom === 'number' ? String(this.zoom) : this.zoom;
    if (![...this.zoomSel.options].some((o) => o.value === v)) {
      this.zoomSel.querySelector('[data-custom]')?.remove();
      this.zoomSel.add(Object.assign(new Option(`${Math.round(this.zoom * 100)}%`, v), { dataset: { custom: 1 } }));
    }
    this.zoomSel.value = v;
  }

  rotate() { this.rotation = (this.rotation + 90) % 360; this._layout(); this._saveSoon(); }

  toggleSpread() {
    this.spread = !this.spread;
    this.view.classList.toggle('is-spread', this.spread);
    this._layout();
    this._saveSoon();
  }

  // ─── Tools & markup ─────────────────────────────────────────────────────
  setTool(t) {
    this.tool = t;
    this.view.dataset.tool = t;
    this.view.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === t));
    if (t !== 'select') { getSelection().removeAllRanges(); this.pop.hidden = true; }
  }

  _setColor(c) {
    this.color = c;
    this.view.querySelectorAll('.pdf-swatch').forEach((s) => s.classList.toggle('is-on', s.dataset.color === c));
  }

  _updatePop() {
    if (!this.isOpen) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { this.pop.hidden = true; return; }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const host = (node.nodeType === 1 ? node : node.parentElement)?.closest('.pdf-pages');
    if (!host) { this.pop.hidden = true; return; }
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    this.pop.hidden = false;
    const w = this.pop.offsetWidth || 160;
    const x = Math.min(Math.max(8, last.right - w), window.innerWidth - w - 8);
    const y = last.bottom + 8 + 40 > window.innerHeight ? Math.max(8, last.top - 48) : last.bottom + 8;
    this.pop.style.left = `${x}px`;
    this.pop.style.top = `${y}px`;
  }

  async _markFromSelection(kind) {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = String(sel).replace(/\s+/g, ' ').trim().slice(0, 300);
    let first = true;
    for (const r of this.recs) {
      if (!r.rendered || !r.vp) continue;
      const pr = r.el.getBoundingClientRect();
      const rects = [];
      for (const span of r.text.querySelectorAll('span')) {
        if (span.querySelector('span')) continue; // skip wrapper spans, only leaf text spans
        if (!range.intersectsNode(span)) continue;
        const sub = document.createRange();
        if (span.contains(range.startContainer)) sub.setStart(range.startContainer, range.startOffset); else sub.setStart(span, 0);
        if (span.contains(range.endContainer)) sub.setEnd(range.endContainer, range.endOffset); else sub.setEnd(span, span.childNodes.length);
        const b = sub.getBoundingClientRect();
        if (b.width < 0.5 || b.height < 0.5) continue;
        const x = b.left - pr.left; const y = b.top - pr.top;
        const p1 = r.vp.convertToPdfPoint(x, y);
        const p2 = r.vp.convertToPdfPoint(x + b.width, y + b.height);
        rects.push([p1[0], p1[1], p2[0], p2[1]]);
      }
      if (!rects.length) continue;
      await this._addMark({ type: `pdf-${kind}`, page: r.num, color: this.color, rects, text: first ? text : '' });
      first = false;
    }
    sel.removeAllRanges();
    if (first) toast('Select text on a rendered page first');
  }

  async _addMark(m) {
    const rec = { bookId: this.bookId, ...m };
    rec.id = await saveAnnotation(rec);
    this.marks.push(rec);
    const r = this.recs[m.page - 1];
    if (r?.rendered) this._drawMarks(r);
    this._renderMarksList();
    return rec;
  }

  async _deleteMark(id) {
    await deleteAnnotation(id);
    const m = this.marks.find((x) => x.id === id);
    this.marks = this.marks.filter((x) => x.id !== id);
    if (m) { const r = this.recs[m.page - 1]; if (r?.rendered) this._drawMarks(r); }
    this._renderMarksList();
  }

  _drawMarks(r) {
    r.svg.replaceChildren();
    const vp = r.vp;
    if (!vp) return;
    const mk = (tag, attrs, id) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      e.classList.add('pdf-mark');
      e.dataset.id = id;
      r.svg.appendChild(e);
      return e;
    };
    for (const m of this.marks) {
      if (m.page !== r.num) continue;
      if (m.type === 'pdf-ink') {
        const pts = m.points.map(([x, y]) => vp.convertToViewportPoint(x, y).map((n) => n.toFixed(1)).join(',')).join(' ');
        mk('polyline', { points: pts, fill: 'none', stroke: m.color, 'stroke-width': (m.w ?? 1.5) * vp.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, m.id);
      } else if (m.type === 'pdf-note') {
        const [x, y] = vp.convertToViewportPoint(...m.point);
        const g = mk('g', { transform: `translate(${x},${y})` }, m.id);
        g.classList.add('pdf-note');
        g.innerHTML = `<title>${esc(m.text)}</title><path d="M0 0h20a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H9l-6 5v-5H0z" transform="translate(-3 -24)" fill="${m.color}" stroke="rgba(0,0,0,.45)" stroke-width="1"/><path d="M3 -18h14M3 -13h9" stroke="rgba(0,0,0,.55)" stroke-width="1.4" stroke-linecap="round"/>`;
        g.addEventListener('click', (ev) => { if (this.tool !== 'eraser') { ev.stopPropagation(); this._editNote(m); } });
      } else {
        for (const rect of m.rects) {
          const [a, b, c, d] = vp.convertToViewportRectangle(rect);
          const x = Math.min(a, c); const y = Math.min(b, d); const w = Math.abs(c - a); const h = Math.abs(d - b);
          if (m.type === 'pdf-highlight') mk('rect', { x, y, width: w, height: h, fill: m.color, 'fill-opacity': 0.38, rx: 2 }, m.id);
          else {
            const yy = m.type === 'pdf-underline' ? y + h - 1.5 : y + h * 0.55;
            mk('line', { x1: x, x2: x + w, y1: yy, y2: yy, stroke: m.color, 'stroke-width': Math.max(1.5, h * 0.09) }, m.id);
          }
        }
      }
    }
    // Eraser: delete on click
    r.svg.querySelectorAll('.pdf-mark').forEach((el) => el.addEventListener('click', (ev) => {
      if (this.tool !== 'eraser') return;
      ev.stopPropagation();
      this._deleteMark(Number(el.dataset.id));
    }));
  }

  _bindInk(r) {
    let pts = null; let line = null;
    const local = (e) => { const b = r.svg.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    r.svg.addEventListener('pointerdown', (e) => {
      if (!r.vp) return;
      if (this.tool === 'note') {
        e.preventDefault();
        const [x, y] = local(e);
        const point = r.vp.convertToPdfPoint(x, y);
        this._editNote({ page: r.num, point, color: this.color, text: '' }, true);
        return;
      }
      if (this.tool !== 'ink') return;
      e.preventDefault();
      r.svg.setPointerCapture(e.pointerId);
      pts = [local(e)];
      line = document.createElementNS(SVGNS, 'polyline');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', this.color);
      line.setAttribute('stroke-width', 2.5);
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-linejoin', 'round');
      r.svg.appendChild(line);
    });
    r.svg.addEventListener('pointermove', (e) => {
      if (!pts) return;
      const p = local(e);
      const l = pts[pts.length - 1];
      if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 1.5) return;
      pts.push(p);
      line.setAttribute('points', pts.map((q) => q.join(',')).join(' '));
    });
    const end = async () => {
      if (!pts) return;
      const done = pts; pts = null; line?.remove(); line = null;
      if (done.length < 2) return;
      await this._addMark({
        type: 'pdf-ink', page: r.num, color: this.color, w: 2.5 / r.vp.scale,
        points: done.map(([x, y]) => r.vp.convertToPdfPoint(x, y)),
      });
    };
    r.svg.addEventListener('pointerup', end);
    r.svg.addEventListener('pointercancel', end);
  }

  _editNote(m, isNew = false) {
    const dlg = this.view.querySelector('#pdf-note-dialog');
    const ta = dlg.querySelector('#pdf-note-text');
    dlg.querySelector('#pdf-note-title').textContent = isNew ? 'New note' : `Note — page ${m.page}`;
    dlg.querySelector('#pdf-note-delete').hidden = isNew;
    ta.value = m.text ?? '';
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      if (v === 'delete' && m.id) return this._deleteMark(m.id);
      if (v !== 'save') return;
      const text = ta.value.trim();
      if (isNew) { if (text) await this._addMark({ type: 'pdf-note', page: m.page, point: m.point, color: m.color, text }); return; }
      if (!text) return this._deleteMark(m.id);
      m.text = text;
      await saveAnnotation(m);
      this._drawMarks(this.recs[m.page - 1]);
      this._renderMarksList();
    };
    dlg.returnValue = '';
    dlg.showModal();
    ta.focus();
  }

  // ─── Sidebar ────────────────────────────────────────────────────────────
  _showTab(name) {
    this.sidebar.hidden = false;
    this.view.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === name));
    this.view.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name === 'find') this.view.querySelector('#pdf-find-input').focus();
    this._relayoutSoon();
  }

  _toggleSidebar() {
    this.sidebar.hidden = !this.sidebar.hidden;
    if (!this.sidebar.hidden) this.view.querySelector(`.pdf-thumb[data-page="${this.curPage}"]`)?.scrollIntoView({ block: 'nearest' });
    this._relayoutSoon();
  }

  _buildThumbs() {
    const pane = this.view.querySelector('[data-pane="thumbs"]');
    pane.replaceChildren();
    this._thumbObs?.disconnect();
    const v1 = this._page1.getViewport({ scale: 1, rotation: this._page1.rotate });
    const ratio = v1.height / v1.width;
    this._thumbObs = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting || en.target.dataset.done) continue;
        en.target.dataset.done = 1;
        this._renderThumb(en.target);
      }
    }, { root: pane, rootMargin: '300px' });
    for (let i = 1; i <= this.doc.numPages; i++) {
      const b = document.createElement('button');
      b.className = `pdf-thumb${i === this.curPage ? ' is-on' : ''}`;
      b.dataset.page = i;
      b.style.aspectRatio = `${1 / ratio}`;
      b.setAttribute('aria-label', `Go to page ${i}`);
      b.innerHTML = `<canvas></canvas><span>${i}</span>`;
      b.addEventListener('click', () => this.goTo(i));
      pane.appendChild(b);
      this._thumbObs.observe(b);
    }
  }

  async _renderThumb(btn) {
    try {
      const page = await this.doc.getPage(Number(btn.dataset.page));
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 140 / base.width });
      const c = btn.querySelector('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
    } catch { /* doc closed */ }
  }

  async _buildOutline() {
    const pane = this.view.querySelector('[data-pane="outline"]');
    const outline = await this.doc.getOutline().catch(() => null);
    if (!outline?.length) { pane.innerHTML = '<p class="pdf-empty">This document has no outline.</p>'; return; }
    const render = (items) => `<ul class="pdf-outline">${items.map((o) => `<li>
      <button data-dest='${esc(JSON.stringify(o.dest))}'>${esc(o.title || 'Untitled')}</button>${o.items?.length ? render(o.items) : ''}</li>`).join('')}</ul>`;
    pane.innerHTML = render(outline);
  }

  _renderMarksList() {
    const pane = this.view.querySelector('[data-pane="marks"]');
    if (!this.marks.length) { pane.innerHTML = '<p class="pdf-empty">No markups yet. Select text to highlight, or use the draw and note tools.</p>'; return; }
    const label = { 'pdf-highlight': 'Highlight', 'pdf-underline': 'Underline', 'pdf-strike': 'Strikethrough', 'pdf-ink': 'Drawing', 'pdf-note': 'Note' };
    const sorted = [...this.marks].sort((a, b) => a.page - b.page || a.id - b.id);
    pane.innerHTML = `<ul class="pdf-marks">${sorted.map((m) => `
      <li data-mark="${m.id}"><span class="pdf-dot" style="background:${m.color}"></span>
        <div><b>${label[m.type] ?? 'Markup'}</b> <small>· page ${m.page}</small>
        ${m.text ? `<p>${esc(m.text)}</p>` : ''}</div>
        <button class="btn-icon" data-del aria-label="Delete markup">${ico('trash')}</button></li>`).join('')}</ul>`;
  }

  // ─── Find ───────────────────────────────────────────────────────────────
  async _pageText(n) {
    if (this._textCache.has(n)) return this._textCache.get(n);
    const page = await this.doc.getPage(n);
    const tc = await page.getTextContent();
    const text = tc.items.map((i) => i.str).join(' ');
    this._textCache.set(n, text);
    return text;
  }

  async _find(q) {
    const status = this.view.querySelector('#pdf-find-status');
    const list = this.view.querySelector('#pdf-find-list');
    this.findQuery = q;
    this.findHits = [];
    this.findIdx = -1;
    list.replaceChildren();
    const token = (this._findToken = (this._findToken ?? 0) + 1);
    if (!q) { status.textContent = ''; this.recs.forEach((r) => r.rendered && this._applyFind(r)); return; }
    const needle = q.toLowerCase();
    for (let n = 1; n <= this.doc.numPages; n++) {
      if (token !== this._findToken) return;
      status.textContent = `Searching… ${n}/${this.doc.numPages}`;
      const text = await this._pageText(n);
      const low = text.toLowerCase();
      let i = low.indexOf(needle);
      while (i !== -1 && this.findHits.length < 500) {
        const s = Math.max(0, i - 30); const e = Math.min(text.length, i + q.length + 50);
        const li = document.createElement('li');
        li.innerHTML = `<button><small>p.${n}</small> ${esc(text.slice(s, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length, e))}</button>`;
        const idx = this.findHits.push({ page: n }) - 1;
        li.firstChild.addEventListener('click', () => this._findStep(0, idx));
        list.appendChild(li);
        i = low.indexOf(needle, i + q.length);
      }
      if (this.findHits.length >= 500) break;
    }
    status.textContent = this.findHits.length ? `${this.findHits.length}${this.findHits.length >= 500 ? '+' : ''} matches` : 'No matches';
    this.recs.forEach((r) => r.rendered && this._applyFind(r));
    if (this.findHits.length) this._findStep(0, 0);
  }

  _findStep(dir, to) {
    if (!this.findHits.length) return;
    this.findIdx = to ?? (this.findIdx + dir + this.findHits.length) % this.findHits.length;
    this.view.querySelectorAll('#pdf-find-list li').forEach((li, i) => li.classList.toggle('is-on', i === this.findIdx));
    this.view.querySelectorAll('#pdf-find-list li')[this.findIdx]?.scrollIntoView({ block: 'nearest' });
    this.goTo(this.findHits[this.findIdx].page);
  }

  _applyFind(r) {
    const q = this.findQuery;
    r.text.querySelectorAll('mark.pdf-find-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    if (!q) return;
    const needle = q.toLowerCase();
    for (const span of r.text.querySelectorAll('span')) {
      if (span.querySelector('span') || !span.textContent) continue;
      const t = span.textContent; const low = t.toLowerCase();
      if (!low.includes(needle)) continue;
      let html = ''; let pos = 0; let i;
      while ((i = low.indexOf(needle, pos)) !== -1) {
        html += `${esc(t.slice(pos, i))}<mark class="pdf-find-hit">${esc(t.slice(i, i + q.length))}</mark>`;
        pos = i + q.length;
      }
      span.innerHTML = html + esc(t.slice(pos));
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────────
  _action(act) {
    switch (act) {
      case 'back': return this.close();
      case 'sidebar': return this._toggleSidebar();
      case 'zoom-in': return this.zoomBy(1);
      case 'zoom-out': return this.zoomBy(-1);
      case 'fit-width': return this.setZoom('width');
      case 'fit-page': return this.setZoom('page');
      case 'rotate': return this.rotate();
      case 'spread': return this.toggleSpread();
      case 'find': return this._showTab('find');
      case 'find-next': return this._findStep(1);
      case 'find-prev': return this._findStep(-1);
      case 'invert': return this._toggleInvert();
      case 'print': return this.print();
      case 'download': return this.download();
      case 'props': return this.showProperties();
      case 'full':
        return document.fullscreenElement ? document.exitFullscreen() : this.view.requestFullscreen?.().catch(() => {});
      default: return undefined;
    }
  }

  async _toggleInvert() {
    const on = this.view.classList.toggle('pdf-invert');
    await setSetting('pdfInvert', on);
  }

  download() {
    const blob = new Blob([this._bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.meta?.fileName ?? `${this.meta?.title ?? 'document'}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async print() {
    const n = this.doc.numPages;
    if (n > 200 && !confirm(`Print all ${n} pages? Preparing them may take a while.`)) return;
    toast('Preparing to print…');
    const root = document.createElement('div');
    root.id = 'pdf-print-root';
    document.body.appendChild(root);
    try {
      for (let i = 1; i <= n; i++) {
        const page = await this.doc.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        const ctx = c.getContext('2d', { alpha: false });
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const img = new Image();
        img.src = c.toDataURL('image/jpeg', 0.9);
        root.appendChild(img);
        c.width = 0;
      }
      document.body.classList.add('pdf-printing');
      await Promise.all([...root.children].map((i) => i.decode().catch(() => {})));
      window.print();
    } finally {
      document.body.classList.remove('pdf-printing');
      root.remove();
    }
  }

  async showProperties() {
    const dlg = this.view.querySelector('#pdf-props-dialog');
    const { info = {} } = await this.doc.getMetadata().catch(() => ({}));
    const vp = this._page1.getViewport({ scale: 1 });
    const mm = (pt) => Math.round((pt / 72) * 25.4);
    const fmtDate = (s) => {
      const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s ?? '');
      return m ? new Date(m[1], (m[2] ?? 1) - 1, m[3] ?? 1, m[4] ?? 0, m[5] ?? 0, m[6] ?? 0).toLocaleString() : (s ?? '');
    };
    const size = this._bytes.byteLength;
    const rows = [
      ['File name', this.meta?.fileName ?? ''],
      ['File size', size > 1048576 ? `${(size / 1048576).toFixed(2)} MB` : `${Math.round(size / 1024)} KB`],
      ['Title', info.Title], ['Author', info.Author], ['Subject', info.Subject], ['Keywords', info.Keywords],
      ['Created', fmtDate(info.CreationDate)], ['Modified', fmtDate(info.ModDate)],
      ['Application', info.Creator], ['PDF producer', info.Producer], ['PDF version', info.PDFFormatVersion],
      ['Page count', this.doc.numPages],
      ['Page size', `${mm(vp.width)} × ${mm(vp.height)} mm (${(vp.width / 72).toFixed(1)} × ${(vp.height / 72).toFixed(1)} in)`],
    ].filter(([, v]) => v !== undefined && v !== '');
    dlg.querySelector('#pdf-props-list').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    dlg.showModal();
  }

  _onKey(e) {
    if (!this.isOpen || e.defaultPrevented) return;
    if (this.view.querySelector('dialog[open]')) return;
    const inField = e.target.closest?.('input, textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); return this._showTab('find'); }
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); return this.print(); }
    if (inField) return;
    if (mod || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') {
      if (this.tool !== 'select') this.setTool('select');
      else if (!this.pop.hidden) { this.pop.hidden = true; getSelection().removeAllRanges(); }
      else if (!document.fullscreenElement) this.close();
    } else if (k === '+' || k === '=') this.zoomBy(1);
    else if (k === '-' || k === '_') this.zoomBy(-1);
    else if (k === '0') this.setZoom('width');
    else if (k === 'ArrowLeft') this.goTo(this.curPage - 1);
    else if (k === 'ArrowRight') this.goTo(this.curPage + 1);
    else if (k === 'Home') this.goTo(1);
    else if (k === 'End') this.goTo(this.recs.length);
    else if (k.toLowerCase() === 'r') this.rotate();
    else if (k.toLowerCase() === 's') this._toggleSidebar();
    else if (k.toLowerCase() === 'g') { this.pageInput.focus(); this.pageInput.select(); e.preventDefault(); }
    else if (k.toLowerCase() === 'd') this.setTool(this.tool === 'ink' ? 'select' : 'ink');
    else if (k.toLowerCase() === 'n') this.setTool(this.tool === 'note' ? 'select' : 'note');
    else if (k.toLowerCase() === 'e') this.setTool(this.tool === 'eraser' ? 'select' : 'eraser');
    else if (k.toLowerCase() === 'f') this._action('full');
  }

  // ─── Persistence ────────────────────────────────────────────────────────
  _saveSoon = debounce(() => this._saveNow(), 800);

  async _saveNow() {
    if (!this.doc || !this.bookId) return;
    const percent = Math.round((this.curPage / this.doc.numPages) * 100);
    await saveProgress(this.bookId, { page: this.curPage, zoom: this.zoom, rotation: this.rotation, spread: this.spread, percent });
    const upd = { readPercent: percent };
    if (this.curPage >= this.doc.numPages) upd.finished = true;
    await updateBookMeta(this.bookId, upd);
  }
}
