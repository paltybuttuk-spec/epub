// library.js — Book import, metadata, covers, collections
import { saveBook, getBook, getAllBooks, deleteBook, updateBookMeta, getReadingStats } from './db.js';
import { EpubEngine } from './epub-engine.js';
import { toast } from './utils.js';

// tiny uuid substitute
function makeId() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

// ─── Import ────────────────────────────────────────────────────────────────────
export async function importEpubFiles(files) {
  const results = [];
  for (const file of files) {
    try {
      const book = await importSingleEpub(file);
      results.push({ ok: true, book });
    } catch (err) {
      console.error('[Library] Import failed:', file.name, err);
      results.push({ ok: false, name: file.name, error: err.message });
    }
  }
  return results;
}

async function importSingleEpub(file) {
  const arrayBuffer = await file.arrayBuffer();

  // Peek at metadata without keeping the engine alive
  const engine = new EpubEngine();
  const { metadata, navigation } = await engine.open(arrayBuffer.slice(0));
  const coverBlob = await engine.getCoverBlob();
  const wordCount = await engine.estimateWordCount();
  engine.destroy();

  const id = makeId();
  const coverDataUrl = coverBlob ? await blobToDataUrl(coverBlob) : null;

  const bookRecord = {
    id,
    title: metadata.title || file.name.replace(/\.epub$/i, ''),
    author: metadata.creator || 'Unknown Author',
    publisher: metadata.publisher || '',
    language: metadata.language || '',
    description: metadata.description || '',
    rights: metadata.rights || '',
    pubDate: metadata.pubdate || '',
    identifier: metadata.identifier || id,
    subject: metadata.subject || '',
    cover: coverDataUrl,
    wordCount,
    tocDepth: depthOf(navigation?.toc ?? []),
    chapterCount: navigation?.toc?.length ?? 0,
    data: arrayBuffer,        // raw EPUB bytes
    addedAt: Date.now(),
    lastOpened: null,
    readPercent: 0,
    finished: false,
    tags: [],
    collectionIds: [],
    fileSize: file.size,
    fileName: file.name,
  };

  await saveBook(bookRecord);
  return bookRecord;
}

function depthOf(items, d = 0) {
  if (!items?.length) return d;
  return Math.max(...items.map((i) => depthOf(i.subitems, d + 1)));
}

async function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// ─── Getters / Sorting ────────────────────────────────────────────────────────
export async function getLibrary(sortBy = 'addedAt', filter = 'all', query = '') {
  let books = await getAllBooks();

  // Strip ArrayBuffer from list (keep only metadata for display)
  books = books.map(({ data: _d, ...rest }) => rest);

  // Filter
  if (filter === 'recent') {
    books = books.filter((b) => b.lastOpened).sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 20);
    return books;
  }
  if (filter === 'finished') books = books.filter((b) => b.finished);

  // Search
  if (query) {
    const q = query.toLowerCase();
    books = books.filter(
      (b) => b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q) || b.subject?.toLowerCase().includes(q)
    );
  }

  // Sort
  const sortFns = {
    addedAt: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => (a.title ?? '').localeCompare(b.title ?? ''),
    author: (a, b) => (a.author ?? '').localeCompare(b.author ?? ''),
    lastOpened: (a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0),
    readPercent: (a, b) => b.readPercent - a.readPercent,
  };
  books.sort(sortFns[sortBy] ?? sortFns.addedAt);
  return books;
}

export async function getBookData(id) {
  const book = await getBook(id);
  return book?.data ?? null;
}

// ─── Book Card HTML ───────────────────────────────────────────────────────────
export function renderBookCard(book, viewMode = 'grid') {
  const pct = Math.round(book.readPercent ?? 0);
  const lastRead = book.lastOpened
    ? relativeTime(book.lastOpened)
    : 'Not started';

  if (viewMode === 'list') {
    return `
    <article class="book-card book-card--list" data-id="${book.id}" role="button" tabindex="0"
             aria-label="Open ${escHtml(book.title)}">
      <div class="book-cover-sm">
        ${book.cover
          ? `<img src="${book.cover}" alt="Cover of ${escHtml(book.title)}" loading="lazy" />`
          : defaultCoverSVG(book.title, book.author, 'sm')}
      </div>
      <div class="book-meta">
        <h3 class="book-title">${escHtml(book.title)}</h3>
        <p class="book-author">${escHtml(book.author)}</p>
        <p class="book-last-read">${lastRead}</p>
      </div>
      <div class="book-progress-wrap">
        <div class="book-progress-bar"><div class="book-progress-fill" style="width:${pct}%"></div></div>
        <span class="book-pct">${pct}%</span>
      </div>
      <button class="book-menu-btn btn-icon" data-id="${book.id}" aria-label="Book options" aria-haspopup="true">⋮</button>
    </article>`;
  }

  return `
  <article class="book-card" data-id="${book.id}" role="button" tabindex="0"
           aria-label="Open ${escHtml(book.title)}">
    <div class="book-cover">
      ${book.cover
        ? `<img src="${book.cover}" alt="Cover of ${escHtml(book.title)}" loading="lazy" />`
        : defaultCoverSVG(book.title, book.author, 'lg')}
      ${pct > 0 ? `<div class="cover-progress-ring" style="--pct:${pct}"><span>${pct}%</span></div>` : ''}
      ${book.finished ? '<div class="cover-badge cover-badge--done">✓ Done</div>' : ''}
    </div>
    <div class="book-info">
      <h3 class="book-title">${escHtml(book.title)}</h3>
      <p class="book-author">${escHtml(book.author)}</p>
      <p class="book-last-read">${lastRead}</p>
    </div>
    <button class="book-menu-btn btn-icon" data-id="${book.id}" aria-label="Book options" aria-haspopup="true">⋮</button>
  </article>`;
}

function defaultCoverSVG(title, author, size = 'lg') {
  const colors = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#FDCB6E', '#A29BFE'];
  const hue = colors[(title?.charCodeAt(0) ?? 0) % colors.length];
  const w = size === 'lg' ? 140 : 48;
  const h = size === 'lg' ? 196 : 68;
  const initials = (title ?? '?').slice(0, 2).toUpperCase();
  return `
  <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="${w}" height="${h}" rx="4" fill="${hue}"/>
    <rect x="${w * 0.07}" y="${h * 0.07}" width="${w * 0.86}" height="${h * 0.86}" rx="2" fill="rgba(0,0,0,.15)"/>
    <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle"
          font-family="Inter,system-ui" font-weight="700"
          font-size="${size === 'lg' ? 36 : 14}" fill="rgba(255,255,255,.9)">${initials}</text>
    <text x="50%" y="72%" dominant-baseline="middle" text-anchor="middle"
          font-family="Inter,system-ui" font-weight="400"
          font-size="${size === 'lg' ? 8 : 5}" fill="rgba(255,255,255,.6)">${escHtml((author ?? '').slice(0, 22))}</text>
  </svg>`;
}

// ─── Book Context Menu ────────────────────────────────────────────────────────
export function showBookMenu(bookId, anchorEl) {
  const existing = document.getElementById('book-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'book-context-menu';
  menu.className = 'context-menu context-menu--book';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button class="ctx-btn" data-action="open"   data-id="${bookId}" role="menuitem">📖 Read</button>
    <button class="ctx-btn" data-action="detail" data-id="${bookId}" role="menuitem">ℹ️ Details</button>
    <button class="ctx-btn" data-action="mark-done" data-id="${bookId}" role="menuitem">✓ Mark Finished</button>
    <button class="ctx-btn" data-action="export-ann" data-id="${bookId}" role="menuitem">💾 Export Notes</button>
    <button class="ctx-btn ctx-btn--danger" data-action="delete" data-id="${bookId}" role="menuitem">🗑 Remove Book</button>
  `;

  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left - 140}px`;
  document.body.appendChild(menu);

  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
  return menu;
}

// ─── Stats Helpers ────────────────────────────────────────────────────────────
export async function refreshLibraryStats() {
  const stats = await getReadingStats();
  const books = await getAllBooks();
  return { ...stats, bookCount: books.length };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (m < 2) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
