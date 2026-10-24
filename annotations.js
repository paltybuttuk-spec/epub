// annotations.js — Highlights, bookmarks, and notes management
import {
  saveAnnotation, getAnnotationsForBook,
  deleteAnnotation, updateAnnotation,
} from './db.js';

export const HL_COLORS = {
  yellow: 'rgba(255,224,102,0.45)',
  green:  'rgba(111,207,151,0.45)',
  blue:   'rgba(86,204,242,0.45)',
  pink:   'rgba(242,153,74,0.45)',
  purple: 'rgba(187,107,217,0.45)',
};

export class AnnotationManager {
  constructor(engine, bookId) {
    this.engine  = engine;
    this.bookId  = bookId;
    this._cache  = [];        // in-memory cache for current session
    this._loaded = false;
  }

  // ─── Load ──────────────────────────────────────────────────────────────
  async load() {
    this._cache = await getAnnotationsForBook(this.bookId);
    this._loaded = true;
    return this._cache;
  }

  async reapplyAll() {
    if (!this._loaded) await this.load();
    for (const ann of this._cache) {
      this._applyToRendition(ann);
    }
  }

  _applyToRendition(ann) {
    if (!this.engine?.rendition) return;
    if (ann.type === 'highlight') {
      this.engine.addHighlight(ann.cfi, {
        id: ann.id,
        color: HL_COLORS[ann.color] ?? HL_COLORS.yellow,
        note: ann.note,
      });
    } else if (ann.type === 'underline') {
      this.engine.addUnderline(ann.cfi, { id: ann.id });
    } else if (ann.type === 'bookmark') {
      this.engine.addBookmarkMark(ann.cfi);
    }
  }

  // ─── Highlight ─────────────────────────────────────────────────────────
  async addHighlight(cfiRange, color = 'yellow', selectedText = '') {
    const ann = {
      bookId: this.bookId,
      type: 'highlight',
      cfi: cfiRange,
      color,
      text: selectedText.slice(0, 500),
      note: '',
      chapter: this._currentChapterTitle(),
    };
    const id = await saveAnnotation(ann);
    const saved = { ...ann, id };
    this._cache.push(saved);
    this._applyToRendition(saved);
    return saved;
  }

  // ─── Underline ─────────────────────────────────────────────────────────
  async addUnderline(cfiRange, selectedText = '') {
    const ann = {
      bookId: this.bookId,
      type: 'underline',
      cfi: cfiRange,
      text: selectedText.slice(0, 500),
      note: '',
      chapter: this._currentChapterTitle(),
    };
    const id = await saveAnnotation(ann);
    const saved = { ...ann, id };
    this._cache.push(saved);
    this._applyToRendition(saved);
    return saved;
  }

  // ─── Bookmark ──────────────────────────────────────────────────────────
  async addBookmark(cfi, label = '') {
    // Remove duplicate bookmark at same CFI
    await this.removeBookmark(cfi);
    const ann = {
      bookId: this.bookId,
      type: 'bookmark',
      cfi,
      label: label || this._currentChapterTitle(),
      chapter: this._currentChapterTitle(),
      percent: this.engine?.getPercentage(cfi) ?? 0,
    };
    const id = await saveAnnotation(ann);
    const saved = { ...ann, id };
    this._cache.push(saved);
    return saved;
  }

  async removeBookmark(cfi) {
    const existing = this._cache.find((a) => a.type === 'bookmark' && a.cfi === cfi);
    if (!existing) return false;
    await deleteAnnotation(existing.id);
    this._cache = this._cache.filter((a) => a.id !== existing.id);
    this.engine?.removeAnnotation(cfi, 'bookmark');
    return true;
  }

  hasBookmark(cfi) {
    return this._cache.some((a) => a.type === 'bookmark' && a.cfi === cfi);
  }

  // ─── Note ──────────────────────────────────────────────────────────────
  async addNote(cfiOrHighlightId, noteText) {
    if (typeof cfiOrHighlightId === 'number') {
      // Attach note to existing highlight
      await updateAnnotation(cfiOrHighlightId, { note: noteText });
      const idx = this._cache.findIndex((a) => a.id === cfiOrHighlightId);
      if (idx >= 0) this._cache[idx].note = noteText;
      return this._cache[idx];
    }
    // Stand-alone note
    const ann = {
      bookId: this.bookId,
      type: 'note',
      cfi: cfiOrHighlightId,
      note: noteText,
      chapter: this._currentChapterTitle(),
    };
    const id = await saveAnnotation(ann);
    const saved = { ...ann, id };
    this._cache.push(saved);
    return saved;
  }

  // ─── Remove ────────────────────────────────────────────────────────────
  async remove(id) {
    const ann = this._cache.find((a) => a.id === id);
    if (!ann) return;
    await deleteAnnotation(id);
    this._cache = this._cache.filter((a) => a.id !== id);
    if (ann.cfi) this.engine?.removeAnnotation(ann.cfi, ann.type);
  }

  // ─── Queries ───────────────────────────────────────────────────────────
  getAll(type = null) {
    if (!type) return [...this._cache];
    return this._cache.filter((a) => a.type === type);
  }

  getHighlights()  { return this.getAll('highlight'); }
  getBookmarks()   { return this.getAll('bookmark'); }
  getNotes()       { return this.getAll('note'); }

  // ─── Render List ───────────────────────────────────────────────────────
  renderAnnotationList(filter = 'all') {
    const items = filter === 'all' ? this._cache : this._cache.filter((a) => a.type === filter);
    if (!items.length) {
      return `<div class="ann-empty">
        <p>No ${filter === 'all' ? '' : filter + 's'} yet.</p>
        <p class="text-muted">Select text while reading to highlight or add notes.</p>
      </div>`;
    }
    return items
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map((ann) => this._renderAnnotationItem(ann))
      .join('');
  }

  _renderAnnotationItem(ann) {
    const colorDot = ann.color
      ? `<span class="hl-dot" style="background:${HL_COLORS[ann.color] ?? '#FFE066'}"></span>`
      : '';
    const icon = { highlight: '🖍', bookmark: '🔖', note: '📝', underline: '___' }[ann.type] ?? '📌';
    const pctLabel = ann.percent ? `${ann.percent}%` : '';
    return `
    <div class="ann-item" data-id="${ann.id}" data-cfi="${escHtml(ann.cfi ?? '')}" data-type="${ann.type}">
      <div class="ann-item-header">
        <span class="ann-type-icon">${icon}</span>
        ${colorDot}
        <span class="ann-chapter">${escHtml(ann.chapter ?? '')}</span>
        <span class="ann-pct">${pctLabel}</span>
        <button class="btn-icon ann-delete" data-id="${ann.id}" aria-label="Delete annotation">×</button>
      </div>
      ${ann.text ? `<blockquote class="ann-quote">${escHtml(ann.text.slice(0, 200))}</blockquote>` : ''}
      ${ann.note ? `<p class="ann-note">${escHtml(ann.note)}</p>` : ''}
      ${ann.label ? `<p class="ann-label">${escHtml(ann.label)}</p>` : ''}
      <time class="ann-date">${formatDate(ann.createdAt)}</time>
    </div>`;
  }

  // ─── Export ────────────────────────────────────────────────────────────
  exportMarkdown(bookTitle, bookAuthor) {
    const lines = [
      `# Notes: ${bookTitle}`,
      `*${bookAuthor}*`,
      '',
      `Exported: ${new Date().toLocaleDateString()}`,
      '',
    ];
    const byChapter = groupBy(this._cache, 'chapter');
    for (const [chapter, items] of Object.entries(byChapter)) {
      lines.push(`## ${chapter || 'Uncategorised'}`);
      for (const ann of items) {
        if (ann.type === 'highlight' || ann.type === 'underline') {
          lines.push(`> ${ann.text}`);
          if (ann.note) lines.push(`> *Note: ${ann.note}*`);
          lines.push('');
        } else if (ann.type === 'bookmark') {
          lines.push(`- 🔖 **Bookmark** — ${ann.label || ann.cfi}`);
        } else if (ann.type === 'note') {
          lines.push(`📝 ${ann.note}`);
          lines.push('');
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  exportJSON() {
    return JSON.stringify({ bookId: this.bookId, annotations: this._cache }, null, 2);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  _currentChapterTitle() {
    const loc = this.engine?.currentLocation;
    return loc?.start?.href?.split('/').pop()?.replace(/\.x?html?$/, '') ?? '';
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] ?? '';
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}
