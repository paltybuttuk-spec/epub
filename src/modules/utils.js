// utils.js — Shared utilities

// ─── Toast Notifications ──────────────────────────────────────────────────────
export function toast(message, type = 'info', duration = 2800) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', 'alert');
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  setTimeout(() => {
    el.classList.add('toast--out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}

// ─── Format Helpers ───────────────────────────────────────────────────────────
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

export function escHtml(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── File Download ────────────────────────────────────────────────────────────
export function downloadText(content, filename, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function downloadJSON(data, filename) {
  downloadText(typeof data === 'string' ? data : JSON.stringify(data, null, 2), filename, 'application/json');
}

// ─── Array / Object ───────────────────────────────────────────────────────────
export function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = typeof key === 'function' ? key(item) : item[key];
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

export function sortBy(arr, key, desc = false) {
  return [...arr].sort((a, b) => {
    const va = typeof key === 'function' ? key(a) : a[key];
    const vb = typeof key === 'function' ? key(b) : b[key];
    if (va < vb) return desc ? 1 : -1;
    if (va > vb) return desc ? -1 : 1;
    return 0;
  });
}

// ─── PWA Helpers ──────────────────────────────────────────────────────────────
export function registerSW(path = '/sw.js') {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(path, { scope: path.replace(/sw\.js$/, '') }).then((reg) => {
    console.log('[SW] Registered:', reg.scope);
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('App updated. Refresh to get the latest version.', 'info', 6000);
        }
      });
    });
  }).catch((err) => console.error('[SW] Registration failed:', err));
}

export function requestPersistentStorage() {
  if (navigator.storage?.persist) {
    navigator.storage.persist().then((granted) => {
      if (granted) console.log('[Storage] Persistent storage granted.');
    });
  }
}

// ─── Screen Wake Lock ─────────────────────────────────────────────────────────
export class WakeLock {
  constructor() { this._lock = null; }

  async acquire() {
    if (!('wakeLock' in navigator)) return;
    try {
      this._lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.acquire();
      });
    } catch (_) {}
  }

  async release() {
    try { await this._lock?.release(); this._lock = null; } catch (_) {}
  }
}

// ─── Drag and Drop ────────────────────────────────────────────────────────────
export function setupDropZone(element, onDrop) {
  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    element.classList.add('drag-over');
  });
  element.addEventListener('dragleave', () => element.classList.remove('drag-over'));
  element.addEventListener('drop', (e) => {
    e.preventDefault();
    element.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter((f) =>
      f.type === 'application/epub+zip' || /\.(epub|pdf)$/i.test(f.name) || f.type === 'application/pdf'
    );
    if (files.length) onDrop(files);
  });
}
