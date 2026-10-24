// main.js — Folio EPUB Reader: entry point & library controller
import './styles/main.css';
import { importEpubFiles, getLibrary, renderBookCard, showBookMenu, refreshLibraryStats } from './modules/library.js';
import { getBookData, deleteBook, updateBookMeta, exportAllData } from './modules/db.js';
import { ReaderController } from './modules/reader.js';
import { settings, applyAppTheme } from './modules/settings.js';
import { toast, registerSW, requestPersistentStorage, setupDropZone, downloadJSON } from './modules/utils.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async function boot() {
  await settings.init();
  applyAppTheme(settings.get('appTheme'));
  registerSW(import.meta.env.BASE_URL + 'sw.js');
  requestPersistentStorage();
  setupInstallPrompt();
  await renderLibrary();
  bindLibraryEvents();
  bindAppSettingsModal();
  handleFileProtocol();
})();

// ─── Library Render ───────────────────────────────────────────────────────────
let currentTab    = 'all';
let currentSort   = settings.get('librarySort') ?? 'addedAt';
let currentView   = settings.get('libraryView') ?? 'grid';
let searchQuery   = '';
let reader        = null;

async function renderLibrary() {
  const grid  = document.getElementById('lib-grid');
  const empty = document.getElementById('lib-empty');
  const books = await getLibrary(currentSort, currentTab, searchQuery);

  if (!books.length) {
    grid.innerHTML = '';
    grid.hidden = true;
    empty.hidden = false;
  } else {
    grid.hidden = false;
    empty.hidden = true;
    grid.className = `lib-grid lib-grid--${currentView}`;
    grid.innerHTML = books.map((b) => renderBookCard(b, currentView)).join('');
  }

  // Stats
  const stats = await refreshLibraryStats();
  const countEl = document.getElementById('stat-book-count');
  const timeEl  = document.getElementById('stat-reading-time');
  const streakEl = document.getElementById('streak-days');
  if (countEl) countEl.textContent = `${stats.bookCount} book${stats.bookCount !== 1 ? 's' : ''}`;
  if (timeEl)  timeEl.textContent  = `${stats.totalHours}h read`;
  if (streakEl) streakEl.textContent = stats.streak;
}

// ─── Library Events ───────────────────────────────────────────────────────────
function bindLibraryEvents() {
  const grid     = document.getElementById('lib-grid');
  const fileInput = document.getElementById('file-input');

  // Book card click — open reader
  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-id]:not(.book-menu-btn)');
    if (card && !e.target.closest('.book-menu-btn')) openBook(card.dataset.id);
  });

  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const card = e.target.closest('[data-id]');
      if (card) openBook(card.dataset.id);
    }
  });

  // Book context menu
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.book-menu-btn');
    if (!btn) return;
    e.stopPropagation();
    const menu = showBookMenu(btn.dataset.id, btn);
    menu.addEventListener('click', async (me) => {
      const action = me.target.closest('[data-action]')?.dataset.action;
      const id     = me.target.closest('[data-id]')?.dataset.id;
      if (!action || !id) return;
      await handleBookAction(action, id);
    });
  });

  // Import buttons
  document.getElementById('btn-import')?.addEventListener('click', () => fileInput.click());
  document.getElementById('btn-import-empty')?.addEventListener('click', () => fileInput.click());

  fileInput?.addEventListener('change', async (e) => {
    await handleImport([...e.target.files]);
    e.target.value = '';
  });

  // Drag & drop on entire library view
  setupDropZone(document.getElementById('view-library'), handleImport);

  // Library search
  document.getElementById('btn-lib-search')?.addEventListener('click', () => {
    const bar = document.getElementById('lib-search-bar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) document.getElementById('lib-search-input')?.focus();
  });
  document.getElementById('btn-lib-search-close')?.addEventListener('click', () => {
    document.getElementById('lib-search-bar').hidden = true;
    searchQuery = '';
    renderLibrary();
  });
  document.getElementById('lib-search-input')?.addEventListener('input', debounce(async (e) => {
    searchQuery = e.target.value.trim();
    await renderLibrary();
  }, 250));

  // Sort dropdown
  document.getElementById('btn-lib-sort')?.addEventListener('click', (e) => {
    const existing = document.getElementById('sort-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'sort-menu';
    menu.className = 'context-menu';
    menu.role = 'menu';
    const opts = [
      { val: 'addedAt',    label: 'Date Added' },
      { val: 'title',      label: 'Title' },
      { val: 'author',     label: 'Author' },
      { val: 'lastOpened', label: 'Last Read' },
      { val: 'readPercent',label: 'Progress' },
    ];
    menu.innerHTML = opts.map((o) =>
      `<button class="ctx-btn ${currentSort === o.val ? 'active' : ''}" data-sort="${o.val}" role="menuitem">${o.label}</button>`
    ).join('');
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top  = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 80}px`;
    document.body.appendChild(menu);
    menu.addEventListener('click', async (me) => {
      const sort = me.target.dataset.sort;
      if (sort) {
        currentSort = sort;
        await settings.set('librarySort', sort);
        await renderLibrary();
        menu.remove();
      }
    });
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  });

  // Grid / List toggle
  document.getElementById('btn-lib-grid-toggle')?.addEventListener('click', async () => {
    currentView = currentView === 'grid' ? 'list' : 'grid';
    await settings.set('libraryView', currentView);
    await renderLibrary();
  });

  // Tabs
  document.querySelectorAll('.lib-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.lib-tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      currentTab = tab.dataset.tab;
      await renderLibrary();
    });
  });

  // Keyboard shortcut: I = Import, / = Search, S = Settings
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (document.getElementById('view-reader') && !document.getElementById('view-reader').hidden) return;
    if (e.key === 'i' || e.key === 'I') document.getElementById('btn-import')?.click();
    if (e.key === '/' || (e.ctrlKey && e.key === 'f')) {
      e.preventDefault();
      document.getElementById('btn-lib-search')?.click();
    }
    if (e.key === 's' || e.key === 'S') document.getElementById('btn-settings')?.click();
  });
}

// ─── Book Actions ─────────────────────────────────────────────────────────────
async function openBook(id) {
  const data = await getBookData(id);
  if (!data) { toast('Book data not found', 'error'); return; }

  const { getAllBooks } = await import('./modules/db.js');
  const books = await getAllBooks();
  const meta  = books.find((b) => b.id === id);
  if (!meta) return;

  if (!reader) reader = new ReaderController();

  try {
    await reader.open(id, data, meta);
  } catch (err) {
    console.error('[Main] Failed to open book:', err);
    toast('Could not open this EPUB. The file may be corrupted.', 'error');
    reader.engine?.destroy?.();
    reader = null;
  }
}

async function handleBookAction(action, id) {
  switch (action) {
    case 'open':
      await openBook(id);
      break;
    case 'mark-done':
      await updateBookMeta(id, { finished: true, readPercent: 100 });
      await renderLibrary();
      toast('Marked as finished ✓');
      break;
    case 'export-ann': {
      const { getAnnotationsForBook } = await import('./modules/db.js');
      const { getAllBooks } = await import('./modules/db.js');
      const books = await getAllBooks();
      const meta  = books.find((b) => b.id === id);
      const anns  = await getAnnotationsForBook(id);
      downloadJSON({ book: meta?.title, author: meta?.author, annotations: anns },
        `${meta?.title ?? id}-annotations.json`);
      toast('Annotations exported');
      break;
    }
    case 'delete': {
      if (!confirm('Remove this book from your library? Annotations will also be deleted.')) return;
      await deleteBook(id);
      await renderLibrary();
      toast('Book removed');
      break;
    }
    default: break;
  }
}

// ─── Import ───────────────────────────────────────────────────────────────────
async function handleImport(files) {
  if (!files.length) return;
  const loadingToast = showLoadingToast(`Importing ${files.length} book${files.length > 1 ? 's' : ''}…`);
  const results = await importEpubFiles(files);
  loadingToast?.remove();

  const ok  = results.filter((r) => r.ok).length;
  const err = results.filter((r) => !r.ok);
  if (ok)  toast(`${ok} book${ok > 1 ? 's' : ''} imported 📚`);
  if (err.length) toast(`${err.length} file${err.length > 1 ? 's' : ''} failed to import`, 'error');

  await renderLibrary();
}

function showLoadingToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return null;
  const el = document.createElement('div');
  el.className = 'toast toast--loading';
  el.innerHTML = `<span class="spinner"></span> ${message}`;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  return el;
}

// ─── App Settings Modal ───────────────────────────────────────────────────────
function bindAppSettingsModal() {
  document.getElementById('btn-settings')?.addEventListener('click', async () => {
    // Populate reading stats
    const { getReadingStats } = await import('./modules/db.js');
    const stats = await getReadingStats();
    const statsEl = document.getElementById('reading-stats-display');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat-card"><span class="stat-val">${stats.totalHours}h</span><span class="stat-key">Read</span></div>
        <div class="stat-card"><span class="stat-val">${stats.streak}</span><span class="stat-key">Day streak</span></div>
        <div class="stat-card"><span class="stat-val">${stats.avgWpm || '—'}</span><span class="stat-key">Avg WPM</span></div>
        <div class="stat-card"><span class="stat-val">${stats.sessionCount}</span><span class="stat-key">Sessions</span></div>
      `;
    }
    document.getElementById('modal-settings').hidden = false;
    document.getElementById('modal-backdrop').hidden = false;
  });

  document.getElementById('btn-close-settings')?.addEventListener('click', closeSettingsModal);
  document.getElementById('modal-backdrop')?.addEventListener('click', closeAllModals);

  document.querySelectorAll('input[name="app-theme"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      await settings.set('appTheme', e.target.value);
      applyAppTheme(e.target.value);
    });
  });

  document.getElementById('btn-export-library')?.addEventListener('click', async () => {
    const json = await exportAllData();
    downloadJSON(json, `folio-library-${new Date().toISOString().slice(0,10)}.json`);
    toast('Library exported');
  });

  document.getElementById('btn-clear-library')?.addEventListener('click', async () => {
    if (!confirm('Clear ALL books and data? This cannot be undone.')) return;
    const { openDB } = await import('idb');
    indexedDB.deleteDatabase('folio-db');
    location.reload();
  });
}

function closeSettingsModal() {
  document.getElementById('modal-settings').hidden = true;
  document.getElementById('modal-backdrop').hidden = true;
}

function closeAllModals() {
  document.getElementById('modal-settings').hidden      = true;
  document.getElementById('modal-reader-settings').hidden = true;
  document.getElementById('modal-book-search').hidden   = true;
  document.getElementById('modal-note').hidden          = true;
  document.getElementById('modal-backdrop').hidden      = true;
}

// ─── PWA Install Prompt ───────────────────────────────────────────────────────
function setupInstallPrompt() {
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('install-banner').hidden = false;
  });

  document.getElementById('btn-install')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      toast('Folio installed! 🎉');
      document.getElementById('install-banner').hidden = true;
    }
    deferredPrompt = null;
  });

  document.getElementById('btn-dismiss-install')?.addEventListener('click', () => {
    document.getElementById('install-banner').hidden = true;
    deferredPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    document.getElementById('install-banner').hidden = true;
    toast('Folio installed successfully!');
  });
}

// ─── File Protocol Handler ────────────────────────────────────────────────────
function handleFileProtocol() {
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) fetch(src).then((r) => r.arrayBuffer()).then((ab) => {
    const file = new File([ab], src.split('/').pop() ?? 'book.epub', { type: 'application/epub+zip' });
    handleImport([file]);
  }).catch(() => toast('Could not load the shared EPUB file.', 'error'));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
