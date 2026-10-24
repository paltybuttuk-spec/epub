// db.js — IndexedDB wrapper via idb
import { openDB } from 'idb';

const DB_NAME = 'folio-db';
const DB_VERSION = 3;

let _db = null;

export async function getDB() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Books store — stores ArrayBuffer + metadata
      if (!db.objectStoreNames.contains('books')) {
        const books = db.createObjectStore('books', { keyPath: 'id' });
        books.createIndex('title', 'title');
        books.createIndex('author', 'author');
        books.createIndex('addedAt', 'addedAt');
        books.createIndex('lastOpened', 'lastOpened');
        books.createIndex('finished', 'finished');
      }

      // Annotations store
      if (!db.objectStoreNames.contains('annotations')) {
        const ann = db.createObjectStore('annotations', { keyPath: 'id', autoIncrement: true });
        ann.createIndex('bookId', 'bookId');
        ann.createIndex('type', 'type');
        ann.createIndex('cfi', 'cfi');
        ann.createIndex('createdAt', 'createdAt');
      }

      // Progress store — per-book reading positions
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'bookId' });
      }

      // Settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Reading sessions — for stats
      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        sessions.createIndex('bookId', 'bookId');
        sessions.createIndex('date', 'date');
      }

      // Collections
      if (!db.objectStoreNames.contains('collections')) {
        db.createObjectStore('collections', { keyPath: 'id', autoIncrement: true });
      }
    },
  });
  return _db;
}

// ─── Books ────────────────────────────────────────────────────────────────────

export async function saveBook(book) {
  const db = await getDB();
  await db.put('books', { ...book, updatedAt: Date.now() });
}

export async function getBook(id) {
  const db = await getDB();
  return db.get('books', id);
}

export async function getAllBooks() {
  const db = await getDB();
  return db.getAll('books');
}

export async function deleteBook(id) {
  const db = await getDB();
  const tx = db.transaction(['books', 'annotations', 'progress', 'sessions'], 'readwrite');
  await tx.objectStore('books').delete(id);
  // Cascade delete annotations
  const annStore = tx.objectStore('annotations');
  const byBook = annStore.index('bookId');
  let cursor = await byBook.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore('progress').delete(id);
  await tx.done;
}

export async function updateBookMeta(id, updates) {
  const db = await getDB();
  const book = await db.get('books', id);
  if (!book) return;
  await db.put('books', { ...book, ...updates, updatedAt: Date.now() });
}

// ─── Progress ─────────────────────────────────────────────────────────────────

export async function saveProgress(bookId, data) {
  const db = await getDB();
  await db.put('progress', { bookId, ...data, savedAt: Date.now() });
}

export async function getProgress(bookId) {
  const db = await getDB();
  return db.get('progress', bookId);
}

// ─── Annotations ──────────────────────────────────────────────────────────────

export async function saveAnnotation(annotation) {
  const db = await getDB();
  if (annotation.id) {
    const existing = await db.get('annotations', annotation.id);
    if (existing) {
      await db.put('annotations', { ...existing, ...annotation, updatedAt: Date.now() });
      return annotation.id;
    }
  }
  return db.add('annotations', { ...annotation, createdAt: Date.now() });
}

export async function getAnnotationsForBook(bookId) {
  const db = await getDB();
  const index = db.transaction('annotations').store.index('bookId');
  return index.getAll(bookId);
}

export async function deleteAnnotation(id) {
  const db = await getDB();
  await db.delete('annotations', id);
}

export async function updateAnnotation(id, updates) {
  const db = await getDB();
  const ann = await db.get('annotations', id);
  if (!ann) return;
  await db.put('annotations', { ...ann, ...updates, updatedAt: Date.now() });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const db = await getDB();
  const record = await db.get('settings', key);
  return record ? record.value : defaultValue;
}

export async function setSetting(key, value) {
  const db = await getDB();
  await db.put('settings', { key, value, updatedAt: Date.now() });
}

export async function getAllSettings() {
  const db = await getDB();
  const all = await db.getAll('settings');
  return Object.fromEntries(all.map((s) => [s.key, s.value]));
}

// ─── Reading Sessions / Stats ─────────────────────────────────────────────────

export async function startSession(bookId) {
  const db = await getDB();
  const id = await db.add('sessions', {
    bookId,
    date: new Date().toISOString().slice(0, 10),
    startedAt: Date.now(),
    endedAt: null,
    wordsRead: 0,
  });
  return id;
}

export async function endSession(sessionId, wordsRead = 0) {
  const db = await getDB();
  const session = await db.get('sessions', sessionId);
  if (!session) return;
  await db.put('sessions', { ...session, endedAt: Date.now(), wordsRead });
}

export async function getReadingStats() {
  const db = await getDB();
  const sessions = await db.getAll('sessions');
  const totalMs = sessions.reduce((acc, s) => {
    if (s.endedAt && s.startedAt) return acc + (s.endedAt - s.startedAt);
    return acc;
  }, 0);
  const totalWords = sessions.reduce((acc, s) => acc + (s.wordsRead || 0), 0);
  const dates = [...new Set(sessions.map((s) => s.date))].sort();
  const streak = calcStreak(dates);
  return {
    totalHours: +(totalMs / 3_600_000).toFixed(1),
    totalWords,
    avgWpm: totalMs > 0 ? Math.round((totalWords / totalMs) * 60_000) : 0,
    streak,
    sessionCount: sessions.length,
    dates,
  };
}

function calcStreak(sortedDates) {
  if (!sortedDates.length) return 0;
  const today = new Date().toISOString().slice(0, 10);
  let streak = 0;
  let check = today;
  for (let i = sortedDates.length - 1; i >= 0; i--) {
    if (sortedDates[i] === check) {
      streak++;
      const d = new Date(check);
      d.setDate(d.getDate() - 1);
      check = d.toISOString().slice(0, 10);
    } else break;
  }
  return streak;
}

// ─── Collections ──────────────────────────────────────────────────────────────

export async function getCollections() {
  const db = await getDB();
  return db.getAll('collections');
}

export async function saveCollection(collection) {
  const db = await getDB();
  if (collection.id) return db.put('collections', collection);
  return db.add('collections', { ...collection, createdAt: Date.now() });
}

export async function deleteCollection(id) {
  const db = await getDB();
  return db.delete('collections', id);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

export async function exportAllData() {
  const db = await getDB();
  const books = (await db.getAll('books')).map(({ data: _data, coverBlob: _c, ...rest }) => rest); // strip blobs
  const annotations = await db.getAll('annotations');
  const progress = await db.getAll('progress');
  const settings = await db.getAll('settings');
  const collections = await db.getAll('collections');
  return JSON.stringify({ version: 2, exportedAt: Date.now(), books, annotations, progress, settings, collections }, null, 2);
}

export async function importData(json) {
  const payload = JSON.parse(json);
  if (!payload.version) throw new Error('Invalid export file');
  const db = await getDB();
  const tx = db.transaction(['annotations', 'progress', 'settings', 'collections'], 'readwrite');
  for (const ann of payload.annotations ?? []) await tx.objectStore('annotations').put(ann);
  for (const p of payload.progress ?? []) await tx.objectStore('progress').put(p);
  for (const s of payload.settings ?? []) await tx.objectStore('settings').put(s);
  for (const c of payload.collections ?? []) await tx.objectStore('collections').put(c);
  await tx.done;
}
