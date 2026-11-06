import { subs } from './data.js';

/*
 * Full-text subtitle search. The build step (tools/subindex.py) ships a
 * compact video-level inverted index; we intersect postings to find candidate
 * videos, then lazily load each candidate's subtitle file to pinpoint the
 * matching cue and its timestamp.
 *
 * Keep STOPWORDS in sync with tools/subindex.py.
 */

const STOPWORDS = new Set(
  ('the a an and or of to in on for is are was were be been being it its '
    + 'this that these those i you he she we they as at by with from but not '
    + 'no do does did so if then than there here what which who when how all '
    + 'can will just don should now').split(' '),
);

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

const MAX_HITS = 15;
const MAX_VIDEO_LOADS = 12;
const PER_VIDEO = 2;
const CHUNK_SIZE = 3;

let indexPromise = null;

function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('data/subs-index.json').then((response) => {
      if (!response.ok) throw new Error(`subs-index ${response.status}`);
      return response.json();
    });
    indexPromise.catch(() => {
      indexPromise = null;
    });
  }
  return indexPromise;
}

function decodePostings(encoded) {
  const out = [];
  let acc = 0;
  for (const part of encoded.split(' ')) {
    acc += parseInt(part, 36);
    out.push(acc);
  }
  return out;
}

/** Tokens that constrain the candidate set for one search term ([] = no constraint). */
function lookupTokens(term) {
  if (CJK_RE.test(term)) {
    const chars = [...term].filter((ch) => CJK_RE.test(ch));
    if (chars.length < 2) return [];
    return chars.slice(0, -1).map((ch, i) => ch + chars[i + 1]);
  }
  const words = term.match(/[a-z0-9][a-z0-9'-]*/g) || [];
  return words.filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

/**
 * @returns {Set<number>|null} candidate video indices, or null when nothing
 *   constrains the search (the caller then scans every subtitled video).
 *
 * Tokens missing from the index are unconstraining, not "impossible": the
 * build prunes tokens seen in fewer than 2 videos, so a rare word (e.g. a
 * place name) legitimately has no postings.
 */
function candidateIndices(index, terms) {
  let set = null;
  for (const term of terms) {
    const tokens = lookupTokens(term);
    if (!tokens.length) continue;
    let termSet = null;
    for (const token of tokens) {
      const encoded = index.i[token];
      if (!encoded) continue;
      const postings = new Set(decodePostings(encoded));
      termSet = termSet
        ? new Set([...termSet].filter((idx) => postings.has(idx)))
        : postings;
    }
    if (!termSet) continue;
    set = set
      ? new Set([...set].filter((idx) => termSet.has(idx)))
      : termSet;
    if (!set.size) return set;
  }
  return set;
}

/**
 * The term whose token appears in the fewest videos — used as the cue-level
 * fallback when no single cue contains every term (phrase split across cues).
 */
function rarestTerm(index, terms) {
  let best = null;
  let bestCount = Infinity;
  for (const term of terms) {
    let count = 0;
    for (const token of lookupTokens(term)) {
      const encoded = index.i[token];
      const tokenCount = encoded ? encoded.split(' ').length : 0;
      count = count === 0 ? tokenCount : Math.min(count, tokenCount);
    }
    if (count > 0 && count < bestCount) {
      best = term;
      bestCount = count;
    }
  }
  return best || terms[terms.length - 1];
}

/**
 * Search the subtitle corpus: videos must mention every term, then cue hits
 * prefer sentences containing all terms and fall back to the rarest term.
 *
 * @param {string} query raw user query
 * @param {{ feedIndex: Map<string, object> }} ctx app context for score ranking
 * @returns {Promise<{hits: Array<{video: object, cue: object}>, videoCount: number,
 *   loadedVideos: number, truncated: boolean}>}
 */
export async function searchSubtitles(query, ctx) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const required = terms.filter((term) => !STOPWORDS.has(term));
  const empty = { hits: [], videoCount: 0, loadedVideos: 0, truncated: false };
  if (!required.length) return empty;
  // Terms like "C++" yield no indexable token; say so instead of "not found".
  if (!required.some((term) => lookupTokens(term).length)) return { ...empty, unsupported: true };

  const index = await loadIndex();
  const candidates = candidateIndices(index, required);
  if (candidates && !candidates.size) return empty;

  // Unconstrained (all tokens pruned): scan the catalogue in score order.
  const pool = candidates ? [...candidates].map((idx) => index.v[idx]) : index.v;
  const ranked = pool
    .map((vid) => ctx.feedIndex.get(vid))
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!ranked.length) return empty;

  const fallbackTerm = rarestTerm(index, required);
  const hits = [];
  let loaded = 0;
  for (
    let i = 0;
    i < ranked.length && loaded < MAX_VIDEO_LOADS && hits.length < MAX_HITS;
    i += CHUNK_SIZE
  ) {
    const batch = ranked.slice(i, i + CHUNK_SIZE);
    const payloads = await Promise.all(batch.map((video) => subs(video.vid)));
    loaded += batch.length;
    batch.forEach((video, j) => {
      const cues = payloads[j]?.cues || [];
      let count = 0;
      // Pass 1: sentences with every term; pass 2: rarest-term sentences when
      // the phrase straddles cue boundaries.
      for (const pass of [required, [fallbackTerm]]) {
        if (count >= PER_VIDEO || hits.length >= MAX_HITS) break;
        for (const cue of cues) {
          if (count >= PER_VIDEO || hits.length >= MAX_HITS) break;
          const text = `${cue.zh || ''} ${cue.en || ''}`.toLowerCase();
          if (pass.every((term) => text.includes(term))) {
            hits.push({ video, cue });
            count += 1;
          }
        }
        if (count > 0) break;
      }
    });
  }
  return {
    hits,
    videoCount: ranked.length,
    loadedVideos: loaded,
    truncated: loaded < ranked.length,
  };
}
