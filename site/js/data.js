const cache = new Map();
const commentCache = new Map();
const subtitleCache = new Map();
let videoIndexPromise = null;

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
  videos: () => fetchJSON('data/videos.json'),
  meta: () => fetchJSON('data/meta.json'),
  related: () => fetchJSON('data/related.json'),
};

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

export function videoIndex() {
  if (!videoIndexPromise) {
    videoIndexPromise = load.videos()
      .then((rows) => new Map(rows.map((row) => [row.vid, row])))
      .catch((error) => {
        videoIndexPromise = null;
        throw error;
      });
  }
  return videoIndexPromise;
}

export function indexByVid(rows) {
  return new Map(rows.map((row) => [row.vid, row]));
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
};
