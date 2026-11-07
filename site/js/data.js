const cache = new Map();
const commentCache = new Map();
const subtitleCache = new Map();
const chapterCache = new Map();
const NOTES_MAX = 2000;

async function fetchJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const promise = fetch(path).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${path}`);
    return response.json();
  });
  cache.set(path, promise);
  try {
    return await promise;
  } catch (error) {
    cache.delete(path);
    throw error;
  }
}

export const load = {
  feed: () => fetchJSON('data/feed.json'),
  feedRest: () => fetchJSON('data/feed-rest.json').catch(() => []),
  meta: () => fetchJSON('data/meta.json'),
  related: () => fetchJSON('data/related.json'),
  series: () => fetchJSON('data/series.json'),
};

let seriesCache = null;

/** 合集索引（series.json）：vid → 所属合集。加载失败时静默禁用合集功能。 */
export function seriesData() {
  if (!seriesCache) {
    seriesCache = load.series()
      .then((payload) => ({
        byVid: new Map(Object.entries(payload?.byVid || {})),
        byId: new Map((payload?.series || []).map((row) => [row.id, row])),
      }))
      .catch(() => {
        seriesCache = null;
        return { byVid: new Map(), byId: new Map() };
      });
  }
  return seriesCache;
}

export async function comments(vid) {
  if (commentCache.has(vid)) return commentCache.get(vid);
  try {
    const payload = await fetchJSON(`data/comments/${vid}.json`);
    commentCache.set(vid, payload);
    return payload;
  } catch {
    commentCache.set(vid, null);
    return null;
  }
}

export async function subs(vid) {
  if (subtitleCache.has(vid)) return subtitleCache.get(vid);
  try {
    const payload = await fetchJSON(`data/subs/${vid}.json`);
    subtitleCache.set(vid, payload);
    return payload;
  } catch {
    subtitleCache.set(vid, null);
    return null;
  }
}

export async function chapters(vid) {
  if (chapterCache.has(vid)) return chapterCache.get(vid);
  try {
    const payload = await fetchJSON(`data/chapters/${vid}.json`);
    chapterCache.set(vid, payload);
    return payload;
  } catch {
    chapterCache.set(vid, null);
    return null;
  }
}

export function indexByVid(rows) {
  return new Map(rows.map((row) => [row.vid, row]));
}

function loadNotesMap() {
  const raw = store.get('notes', {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function makeNoteId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 修剪笔记总量，localStorage 里最老的先走（按写入时间）。 */
function trimNotes(map) {
  let entries = Object.entries(map);
  const total = entries.reduce((sum, [, rows]) => sum + rows.length, 0);
  if (total <= NOTES_MAX) return;
  const all = entries.flatMap(([vid, rows]) => rows.map((note) => ({ vid, note })));
  all.sort((a, b) => (a.note.u || 0) - (b.note.u || 0));
  const doomed = new Set(all.slice(0, total - NOTES_MAX).map(({ vid, note }) => `${vid}/${note.id}`));
  for (const [vid, rows] of entries) {
    map[vid] = rows.filter((note) => !doomed.has(`${vid}/${note.id}`));
    if (!map[vid].length) delete map[vid];
  }
}

let progressCache = null;

function loadProgressMap() {
  if (!progressCache) {
    const raw = store.get('progress', {});
    progressCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  return progressCache;
}

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('ht.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('ht.' + key, JSON.stringify(value));
    } catch {
      /* ignore quota and private-mode errors */
    }
  },
  list(key) {
    const value = this.get(key, []);
    return Array.isArray(value) ? value : [];
  },
  toggle(key, id) {
    const current = new Set(this.list(key));
    if (current.has(id)) current.delete(id);
    else current.add(id);
    this.set(key, [...current]);
    return current.has(id);
  },
  has(key, id) {
    return this.list(key).includes(id);
  },
  clear(key) {
    this.set(key, []);
  },
  getProgress(vid) {
    if (!vid) return null;
    const map = loadProgressMap();
    return map[vid] || null;
  },
  setProgress(vid, seconds, duration = 0, force = false) {
    if (!vid || !Number.isFinite(seconds) || seconds < 5) return;
    const t = Math.floor(seconds);
    const d = Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
    const map = loadProgressMap();
    const prev = map[vid];
    if (!force && prev && Math.abs((prev.t || 0) - t) < 4) return;
    delete map[vid];
    map[vid] = { t, d: d || prev?.d || 0, u: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > 400) {
      for (const oldKey of keys.slice(0, keys.length - 400)) {
        delete map[oldKey];
      }
    }
    this.set('progress', map);
  },
  clearProgress(vid) {
    const map = loadProgressMap();
    if (vid) {
      delete map[vid];
      this.set('progress', map);
    } else {
      progressCache = {};
      this.set('progress', {});
    }
  },
  // ── 随手记 / 时间戳书签（ht.notes: { [vid]: Array<{id, t, text, cue, u}> }）──
  getNotes(vid) {
    const rows = loadNotesMap()[vid];
    return Array.isArray(rows) ? rows.slice() : [];
  },
  addNote(vid, { t, text = '', cueZh = '' }) {
    if (!vid || !Number.isFinite(t)) return null;
    const map = loadNotesMap();
    const rows = Array.isArray(map[vid]) ? map[vid] : [];
    const note = {
      id: makeNoteId(),
      t: Math.max(0, Math.floor(t)),
      text: String(text || '').trim(),
      cue: String(cueZh || ''),
      u: Date.now(),
    };
    rows.unshift(note);
    map[vid] = rows;
    trimNotes(map);
    this.set('notes', map);
    return note;
  },
  updateNote(vid, noteId, text) {
    const map = loadNotesMap();
    const rows = Array.isArray(map[vid]) ? map[vid] : [];
    const note = rows.find((row) => row.id === noteId);
    if (!note) return false;
    note.text = String(text || '').trim();
    note.u = Date.now();
    this.set('notes', map);
    return true;
  },
  removeNote(vid, noteId) {
    const map = loadNotesMap();
    const rows = Array.isArray(map[vid]) ? map[vid] : [];
    const next = rows.filter((row) => row.id !== noteId);
    if (next.length === rows.length) return false;
    if (next.length) map[vid] = next;
    else delete map[vid];
    this.set('notes', map);
    return true;
  },
  notesForVid(vid) {
    const map = loadNotesMap();
    if (vid) return Array.isArray(map[vid]) ? map[vid].slice() : [];
    return Object.fromEntries(Object.entries(map).map(([key, rows]) => [key, rows.slice()]));
  },
};
