# 📚 Folio — Premium EPUB Reader PWA

A fully-featured, offline-capable EPUB reader Progressive Web App. Built with vanilla JS, epub.js, IndexedDB, and the Web Speech API — no subscription, no ads, no tracking.

---

## ✨ Premium Features

### Reading Experience
- **EPUB 2 & 3** — full spec support via epub.js
- **5 reading themes** — Dark, Light, Sepia, Amoled, Forest, Ocean
- **10 font options** — Literata, Georgia, Times, Palatino, Inter, Verdana and more
- **Paginated or scroll** — switch modes on the fly
- **Font size, line spacing, margin** — fine-grained controls
- **Text justification & hyphenation** — typographic polish
- **Full-screen immersive mode**
- **Swipe & keyboard navigation**

### Annotations
- **Highlights** in 5 colours (yellow, green, blue, orange, purple)
- **Bookmarks** per position with chapter label
- **Notes** attached to highlights or as stand-alone comments
- **Underlines** for secondary marking
- **Export to Markdown or JSON** — all your notes portable

### Navigation
- **Table of Contents** — full nested chapter tree
- **Progress bar** — scrub to any position
- **Estimated reading time remaining**
- **Reading history** — last-opened tracking

### Text to Speech (TTS)
- **Web Speech API** — works in Chrome, Edge, Safari
- **50+ voice options** grouped by language
- **Speed control** from 0.5× to 3×
- **Sentence-by-sentence navigation**
- **Auto-advance** to next page when chapter ends

### Library
- **Drag & drop import** — drop EPUBs directly onto the page
- **Cover extraction** from EPUB metadata
- **Generated covers** with colour-coded initials for missing art
- **Sort** by title, author, date added, last read, or progress
- **Filter** by recent, finished, or all
- **Library search** across title, author, and genre
- **Grid and list view** toggle
- **Reading statistics** — total hours, streak, words per minute

### In-Book Search
- **Full-text search** across all spine items
- **50 results** with excerpt context
- **Click to jump** to any match

### PWA
- **Offline-first** — reads cached EPUBs with no connection
- **Installable** on Windows, macOS, Android, iOS, ChromeOS
- **File association** — `.epub` files open Folio directly
- **Share Target API** — share EPUBs to Folio from other apps
- **Background Sync** — annotation sync stub ready for your backend
- **Push Notifications** — reading reminder support
- **Edge Side Panel** — works as a sidebar in Microsoft Edge
- **PWA Builder ready** — passes all manifest and service worker checks

---

## 🚀 Quick Start

### Prerequisites
- Node.js ≥ 18
- npm ≥ 9

### Development

```bash
git clone https://github.com/YOUR_USER/epub-reader-pwa.git
cd epub-reader-pwa
npm install
npm run dev
# → http://localhost:3000
```

### Production Build

```bash
npm run build
npm run preview   # preview the dist/ folder
```

---

## 📁 Repository Structure

```
epub-reader-pwa/
├── index.html                  # App shell — all views, modals, sidebars in HTML
├── manifest.json               # (root — for Vite) → public/manifest.json served
├── sw.js                       # Service worker (cache-first + background sync)
├── public/
│   ├── manifest.json           # PWA manifest
│   └── icons/                  # All required icon sizes (add PNGs here)
├── src/
│   ├── main.js                 # Entry: library controller, routing, install prompt
│   └── modules/
│       ├── epub-engine.js      # epub.js wrapper — open, render, search, annotations
│       ├── library.js          # Book import, metadata, cover extraction, card HTML
│       ├── reader.js           # Reader UI controller — settings, TTS, TOC, search
│       ├── annotations.js      # Highlights, bookmarks, notes — CRUD + export
│       ├── tts.js              # Web Speech API engine with sentence queue
│       ├── settings.js         # Preferences store + CSS builders for reader themes
│       ├── db.js               # IndexedDB via idb — books, annotations, progress, stats
│       └── utils.js            # Toast, debounce, drag-drop, SW helpers, wake lock
│   └── styles/
│       ├── main.css            # Imports all partials; reset, buttons, modals, toasts
│       ├── themes.css          # CSS custom property tokens for dark/light app themes
│       ├── library.css         # Library grid, book cards, header, tabs, FAB
│       └── reader.css          # Reader toolbars, canvas, TTS bar, TOC, annotation list
├── vite.config.js              # Vite + vite-plugin-pwa config
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI: build → GitHub Pages; PR: Lighthouse audit
└── README.md
```

---

## 🏗 Deploy to GitHub Pages

1. Push to `main` — the workflow builds and deploys automatically.
2. Go to **Settings → Pages → Source: GitHub Actions**.
3. Your app is live at `https://YOUR_USER.github.io/epub-reader-pwa/`.

---

## 📱 PWA Builder (Microsoft)

1. Deploy the app to any HTTPS host (GitHub Pages, Netlify, Vercel, Cloudflare Pages).
2. Open [pwabuilder.com](https://www.pwabuilder.com) and enter your URL.
3. Folio's manifest passes all required checks:
   - ✅ `name`, `short_name`, `description`
   - ✅ Icons: 72, 96, 128, 144, 152, 192, 384, 512px + maskable 192 & 512
   - ✅ `display: standalone` + `display_override: window-controls-overlay`
   - ✅ `start_url`, `scope`, `id`
   - ✅ `screenshots` (wide + narrow)
   - ✅ `shortcuts`
   - ✅ `file_handlers` for `.epub`
   - ✅ `share_target` for sharing EPUBs from other apps
   - ✅ `protocol_handlers` for `web+epub://`
   - ✅ `edge_side_panel` for Edge sidebar mode
4. Download Windows (MSIX), Android (APK/AAB), or iOS packages directly from PWA Builder.

### Adding Icons

Place PNG files in `public/icons/` at these sizes:

```
icon-72.png   icon-96.png   icon-128.png   icon-144.png
icon-152.png  icon-192.png  icon-384.png   icon-512.png
icon-maskable-192.png       icon-maskable-512.png
apple-touch-icon.png  (180×180)
favicon.svg
shortcut-library.png  (96×96)
shortcut-read.png     (96×96)
```

Use [PWA Asset Generator](https://github.com/elegantapp/pwa-asset-generator) to generate all sizes from a single SVG:

```bash
npx pwa-asset-generator logo.svg public/icons --manifest public/manifest.json
```

---

## 🔧 Adding Your Backend (Cloud Sync)

The service worker's `sync` event handler in `sw.js` stubs out annotation and progress sync. To wire it up:

1. Implement a REST or GraphQL API for `POST /sync/annotations` and `POST /sync/progress`.
2. In `src/modules/db.js`, call `navigator.serviceWorker.ready.then(sw => sw.sync.register('sync-annotations'))` after saving offline.
3. In `sw.js`, replace the stub inside `syncAnnotations()` with `fetch('/api/sync/annotations', { method: 'POST', body: ... })`.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `→` / `Space` / `Page Down` | Next page |
| `←` / `Page Up` | Previous page |
| `B` | Toggle bookmark |
| `T` | Toggle TTS |
| `C` | Open table of contents |
| `Ctrl+F` | Search in book |
| `S` | Open settings (library) |
| `I` | Import EPUB (library) |
| `/` | Search library |
| `Esc` | Close modal / sidebar |

---

## 📄 License

MIT — use freely, modify freely, no attribution required.
