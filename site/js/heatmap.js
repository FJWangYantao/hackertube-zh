import { el, formatClock, toast } from './ui.js';
import { store } from './data.js';
import { emitSettingsChanged } from './settings.js';
import { findActiveStreamCue } from './subtitles.js';

/**
 * 📊 播放器「高能声波热力条」 (heatmap.js)
 * 融合 4 重信号：
 *   1. 双语字幕信息密度 (Subtitle Speech Density)
 *   2. HN 评论区提及的时间戳热力峰值 (Comment Timestamp Hotspots 🔥)
 *   3. AI 章节切分线 (Chapter Boundaries)
 *   4. 个人随手记书签锚点 (Personal Notes 📌)
 */

const BINS = 96;
const TS_COLON_RE = /(?<![0-9:/-])\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b(?![0-9:/-])/g;
const TS_MIN_ZH_RE = /(?:约|大约|第)?\s*(\d{1,3})\s*分钟(?:处|左右)?/g;
const TS_MIN_EN_RE = /\b(?:about|around|at)\s+(\d{1,3})\s*(?:min|minute|minutes)\b/gi;

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'they', 'have', 'what', 'about', 'which',
  'there', 'their', 'when', 'make', 'know', 'like', 'just', 'some', 'good', 'very', 'also',
  'then', 'were', 'been', 'into', 'more', 'than', 'other', 'these', 'could', 'first', 'after',
  'where', 'being', 'because', 'would', 'your', 'them', 'does', 'will', 'here', 'over', 'only',
  'such', 'time', 'even', 'most', 'much', 'take', 'well', 'people', 'going', 'want', 'think',
  'look', 'come', 'right', 'thing', 'things', 'really', 'something', 'actually', 'every',
  'between', 'through', 'using', 'used', 'need', 'means', 'call', 'case', 'point', 'said',
  'tell', 'work', 'works', 'working', 'talking', 'talk', 'kind', 'many', 'sort', 'give',
  'gives', 'problem', 'saying', 'probably', 'little', 'down', 'back', 'different', 'another',
  'always', 'together', 'everything', 'anyone', 'someone', 'anything', 'might', 'great',
  'course', 'part', 'sure', 'same', 'done', 'should', 'each', 'before', 'those', 'around',
  'while', 'never', 'must', 'still', 'without', 'again', 'place', 'under', 'last',
  'made', 'during', 'show', 'shows', 'looks', 'help', 'keep', 'start',
  'starts', 'started', 'number', 'system', 'systems', 'computer', 'science', 'video',
  'youtube', 'slides', 'slide', 'speaker', 'talks', 'question', 'questions', 'thank', 'thanks',
  'hello', 'welcome', 'everyone', 'today', 'morning', 'afternoon', 'guys', 'lets', 'please',
  'okay', 'yeah', 'cool', 'nice', 'awesome', 'fine', 'sorry', 'zero', 'gonna', 'wanna', 'gotta',
  'raw', 'list', 'use', 'new', 'dot', 'line', 'next', 'bit', 'piece', 'turn', 'side', 'set',
  'get', 'put', 'lot', 'way', 'single', 'stuff', 'basically', 'example', 'simple', 'big',
  'high', 'low', 'see', 'saw', 'seen', 'four', 'three', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'two', 'one', 'second', 'third', 'times', 'went', 'gone', 'feel', 'felt',
  'try', 'tried', 'trying', 'kept', 'keeping', 'run', 'ran', 'running', 'read',
  'write', 'wrote', 'written', 'stop', 'stopped', 'hear', 'heard', 'walk', 'step', 'steps',
  'already', 'either', 'neither', 'whether', 'whose', 'whom', 'since', 'until', 'unless',
  'upon', 'towards', 'onto', 'behind', 'beside', 'beyond',
  'further', 'longer', 'shorter', 'higher', 'lower', 'larger', 'smaller', 'better', 'worse',
  'best', 'worst', 'least', 'less', 'almost', 'nearly', 'quite', 'fairly',
  'pretty', 'rather', 'somewhat', 'entirely', 'completely', 'totally', 'partly', 'mainly',
  'mostly', 'largely', 'simply', 'merely', 'hardly', 'scarcely', 'barely', 'indeed',
  'certainly', 'definitely', 'absolutely', 'possibly', 'perhaps', 'maybe', 'obviously',
  'clearly', 'apparently', 'presumably', 'supposedly', 'truly',
  'fact', 'sense', 'idea', 'whole', 'half', 'full', 'empty', 'open', 'close', 'closed',
  'easy', 'hard', 'difficult', 'fast', 'slow', 'quick', 'quickly',
  'true', 'false', 'yes', 'none', 'any', 'all', 'both',
  'can', 'had', 'has', 'how', 'why', 'who', 'our', 'out', 'off', 'not', 'too', 'now',
  'you', 'your', 'yours', 'for', 'was', 'were', 'are', 'is', 'am',
  'change', 'changes', 'world', 'years', 'days', 'hours', 'minutes', 'seconds',
]);

const TECH_TERMS = new Set([
  // AI, LLM, ML & NLP
  'gpt', 'llm', 'token', 'tokens', 'tokenizer', 'tokenization', 'bpe', 'vocab', 'vocabulary',
  'encoder', 'decoder', 'encode', 'decode', 'attention', 'transformer', 'embedding', 'embeddings',
  'vector', 'vectors', 'tensor', 'tensors', 'gradient', 'weights', 'loss', 'training', 'inference',
  'prompt', 'dataset', 'corpus', 'unicode', 'utf', 'byte', 'bytes', 'regex',
  // Systems, Concurrency & Operating Systems
  'systemd', 'init', 'pid', 'daemon', 'service', 'cgroup', 'journal', 'dbus', 'kernel',
  'thread', 'threads', 'async', 'sync', 'await', 'mutex', 'lock', 'locks', 'concurrency', 'parallel',
  'memory', 'cache', 'caching', 'buffer', 'buffers', 'pointer', 'pointers', 'allocator', 'stack', 'heap',
  'cpu', 'gpu', 'registers', 'instruction', 'latency', 'throughput', 'bandwidth',
  'compiler', 'parser', 'syntax', 'ast', 'ir', 'llvm', 'wasm', 'bytecode', 'runtime', 'gc',
  // Linux, Networks & Databases
  'linux', 'unix', 'posix', 'socket', 'packet', 'packets', 'tcp', 'udp', 'http', 'api', 'protocol', 'protocols',
  'database', 'query', 'queries', 'table', 'tables', 'schema', 'index', 'indexes', 'transaction',
  'btree', 'hash', 'cluster', 'replica', 'sharding', 'consensus', 'raft', 'paxos',
  'graph', 'tree', 'nodes', 'edges', 'matrix', 'matrices', 'algorithm', 'complexity', 'entropy',
  // Speaking, Presentation & Pedagogy
  'boards', 'board', 'blackboard', 'chalk', 'props', 'presentation', 'lecture', 'audience', 'heuristic',
]);

function normalizeStem(word) {
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && word.length > 4 && /[sxhz]/.test(word[word.length - 3])) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

export function extractKeywords(cues = [], video = null) {
  if (!cues || cues.length < 15) return [];

  const metaTokens = new Set();
  if (video) {
    const rawMeta = `${video.title || ''} ${video.topic || ''} ${video.summary || ''} ${(video.categories || []).join(' ')}`.toLowerCase();
    const mTokens = rawMeta.match(/\b[a-z]{3,18}\b/g) || [];
    for (const tok of mTokens) {
      if (!STOP_WORDS.has(tok) && tok.length >= 3) {
        metaTokens.add(normalizeStem(tok));
        metaTokens.add(tok);
      }
    }
  }

  const freq = new Map();
  const times = new Map();
  const bestWord = new Map();

  for (const cue of cues) {
    const text = (cue.en || cue.zh || '').toLowerCase();
    const tokens = text.match(/\b[a-z]{3,18}\b/g) || [];
    const seenInCue = new Set();
    for (const raw of tokens) {
      if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
      const stem = normalizeStem(raw);
      if (STOP_WORDS.has(stem) || seenInCue.has(stem)) continue;
      seenInCue.add(stem);

      freq.set(stem, (freq.get(stem) || 0) + 1);
      if (!times.has(stem)) times.set(stem, []);
      times.get(stem).push(cue.s);

      if (!bestWord.has(stem) || (raw.length > bestWord.get(stem).length && !raw.endsWith('s'))) {
        bestWord.set(stem, raw);
      }
    }
  }

  const candidates = [];
  for (const [stem, count] of freq.entries()) {
    if (count < 3) continue;
    let score = count;

    // Direct match with video metadata (title, topic, summary, categories)
    if (metaTokens.has(stem)) {
      score *= 12.0;
    } else {
      for (const mt of metaTokens) {
        if (mt.length >= 4 && (stem.includes(mt) || mt.includes(stem))) {
          score *= 5.0;
          break;
        }
      }
    }

    // Domain tech vocabulary match
    if (TECH_TERMS.has(stem)) {
      score *= 6.0;
    }

    candidates.push({
      stem,
      displayWord: bestWord.get(stem) || stem,
      count,
      score,
      times: times.get(stem) || [],
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.count - a.count);

  // Deduplicate overlapping stems (e.g. avoid 'token' + 'tokenizer' + 'tokenization' occupying all 5 slots)
  const selected = [];
  for (const cand of candidates) {
    const w = cand.displayWord;
    const isDuplicate = selected.some((s) => {
      const sw = s.displayWord;
      return (w.startsWith(sw) || sw.startsWith(w)) && Math.abs(w.length - sw.length) >= 2;
    });
    if (!isDuplicate) {
      selected.push(cand);
      if (selected.length >= 5) break;
    }
  }

  return selected.map((c) => ({
    word: c.displayWord,
    count: c.count,
    times: c.times,
  }));
}

function extractCommentHotspots(comments = [], maxDuration = 7200) {
  const spots = [];
  for (const c of comments) {
    const text = `${c.text_zh || ''} ${c.text || ''}`;
    const seenInComment = new Set();
    const pushSec = (sec, label) => {
      if (!Number.isFinite(sec) || sec <= 5 || (maxDuration > 0 && sec > maxDuration)) return;
      const bucket = Math.round(sec / 10);
      if (seenInComment.has(bucket)) return;
      seenInComment.add(bucket);
      spots.push({
        t: sec,
        label: label || formatClock(sec),
        author: c.author || 'HN 网友',
        snippet: (c.quote_zh || c.why_zh || c.text_zh || c.text || '').slice(0, 56),
      });
    };

    TS_COLON_RE.lastIndex = 0;
    let m;
    while ((m = TS_COLON_RE.exec(text)) !== null) {
      const sec = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
      pushSec(sec, m[0]);
    }
    TS_MIN_ZH_RE.lastIndex = 0;
    while ((m = TS_MIN_ZH_RE.exec(text)) !== null) {
      pushSec(Number(m[1]) * 60, `${m[1]}:00`);
    }
    TS_MIN_EN_RE.lastIndex = 0;
    while ((m = TS_MIN_EN_RE.exec(text)) !== null) {
      pushSec(Number(m[1]) * 60, `${m[1]}:00`);
    }
  }
  spots.sort((a, b) => a.t - b.t);
  return spots;
}

export function createHeatmapBar({ video, onSeek, visible = true }) {
  let cues = [];
  let chapters = [];
  let comments = [];
  let hotspots = [];
  let notes = store.getNotes(video.vid);
  let duration = 0;
  let currentTime = 0;
  let hoverRatio = -1;
  let bins = new Float32Array(BINS);
  let hotBins = new Float32Array(BINS);
  let searchHitQuery = '';
  let searchHitTimes = [];
  let searchActiveTime = null;
  let kwExpanded = false;
  let hotExpanded = false;

  const subStatEl = el('span', { class: 'muted', style: { fontSize: '11.5px' } }, '');
  const searchLegText = el('span', {}, '搜索命中');
  const searchLegItem = el('span', { class: 'heatmap-leg-item', hidden: true },
    el('span', { class: 'heatmap-leg-swatch', style: { background: '#10b981' } }),
    searchLegText,
  );
  const hideButton = el('button', {
    class: 'heatmap-close',
    type: 'button',
    title: '隐藏内容热力，可在设置中重新打开',
    'aria-label': '隐藏内容热力',
    on: {
      click: () => {
        visible = false;
        wrap.hidden = true;
        store.set('heatmap_enabled', false);
        emitSettingsChanged('heatmap_enabled', false, 'heatmap');
        toast('已隐藏内容热力，可在右上角「设置」中重新打开');
      },
    },
  }, el('span', { 'aria-hidden': 'true' }, '×'));
  const head = el('div', { class: 'heatmap-head' },
    el('span', { class: 'heatmap-label' }, '内容热力'),
    subStatEl,
    el('div', { class: 'heatmap-legend' },
      searchLegItem,
      el('span', { class: 'heatmap-leg-item', title: '橙色表示语速密度，亮色表示已播放部分' },
        el('span', { class: 'heatmap-leg-swatch', style: { background: '#ff6600' } }),
        '语速 / 已播',
      ),
      el('span', { class: 'heatmap-leg-item' },
        el('span', { class: 'heatmap-leg-swatch', style: { background: '#facc15' } }),
        '评论提及',
      ),
      el('span', { class: 'heatmap-leg-item' },
        el('span', { class: 'heatmap-leg-swatch', style: { background: '#38bdf8' } }),
        '我的书签',
      ),
    ),
    hideButton,
  );

  const canvas = el('canvas', { class: 'heatmap-canvas' });
  const tipTs = el('span', { class: 'heatmap-tip-ts' }, '0:00');
  const tipChap = el('span', { class: 'heatmap-tip-chap' }, '');
  const tipCue = el('p', { class: 'heatmap-tip-cue' }, '');
  const tipHot = el('p', { class: 'heatmap-tip-hot', hidden: true }, '');
  const tip = el('div', { class: 'heatmap-tip', hidden: true },
    el('div', { class: 'heatmap-tip-head' }, tipTs, tipChap),
    tipCue,
    tipHot,
  );

  const stage = el('div', { class: 'heatmap-stage' }, canvas, tip);
  const kwRow = el('div', { class: 'heatmap-kw-row', hidden: true });
  const hotspotsBar = el('div', { class: 'heatmap-hotspots', hidden: true });
  const wrap = el('div', { class: 'heatmap-wrap', hidden: true }, head, stage, kwRow, hotspotsBar);

  let keywords = [];
  let activeKeyword = null;
  let activeKwOccurrences = [];
  let activeKwIdx = -1;

  const ctx2d = canvas.getContext('2d');
  let width = 600;
  let height = 44;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function computeDuration() {
    let maxD = duration || 0;
    if (cues.length) {
      const lastCue = cues[cues.length - 1];
      maxD = Math.max(maxD, lastCue.e || lastCue.s || 0);
    }
    if (chapters.length) {
      const lastCh = chapters[chapters.length - 1];
      maxD = Math.max(maxD, (lastCh.s || 0) + 120);
    }
    return maxD;
  }

  function recomputeBins() {
    if (!visible) {
      wrap.hidden = true;
      return;
    }
    const dur = computeDuration();
    duration = dur;
    bins = new Float32Array(BINS);
    hotBins = new Float32Array(BINS);

    if (!dur || (!cues.length && !hotspots.length)) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    if (cues.length) {
      for (const cue of cues) {
        const mid = ((cue.s || 0) + (cue.e || cue.s || 0)) * 0.5;
        const idx = Math.min(BINS - 1, Math.max(0, Math.floor((mid / dur) * BINS)));
        const weight = Math.max(4, (cue.zh || cue.en || '').length);
        bins[idx] += weight;
      }
      // Smooth 3-tap filter & normalize to [0.18, 1.0]
      const smoothed = new Float32Array(BINS);
      let maxVal = 1;
      for (let i = 0; i < BINS; i++) {
        const prev = bins[Math.max(0, i - 1)];
        const cur = bins[i];
        const next = bins[Math.min(BINS - 1, i + 1)];
        smoothed[i] = prev * 0.22 + cur * 0.56 + next * 0.22;
        if (smoothed[i] > maxVal) maxVal = smoothed[i];
      }
      for (let i = 0; i < BINS; i++) {
        bins[i] = 0.18 + (smoothed[i] / maxVal) * 0.82;
      }
    } else {
      for (let i = 0; i < BINS; i++) {
        bins[i] = 0.28 + Math.sin(i * 0.35) * 0.12;
      }
    }

    hotspots = extractCommentHotspots(comments, dur);
    for (const h of hotspots) {
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((h.t / dur) * BINS)));
      hotBins[idx] = Math.min(1, hotBins[idx] + 0.65);
      if (idx > 0) hotBins[idx - 1] = Math.min(1, hotBins[idx - 1] + 0.3);
      if (idx + 1 < BINS) hotBins[idx + 1] = Math.min(1, hotBins[idx + 1] + 0.3);
    }

    const parts = [];
    if (cues.length) parts.push(`${cues.length} 句双语字幕`);
    if (chapters.length) parts.push(`${chapters.length} 个章节`);
    if (hotspots.length) parts.push(`${hotspots.length} 处网友空降点`);
    subStatEl.textContent = parts.join(' · ');

    keywords = extractKeywords(cues, video);
    renderKeywords();
    renderHotspotChips();
    draw();
  }

  function renderKeywords() {
    if (!keywords.length) {
      kwRow.hidden = true;
      kwRow.replaceChildren();
      return;
    }
    // 默认只展示前 3 个关键词，其余收进「+N」；有选中词时全部展开以便定位。
    const visibleKeywords = (kwExpanded || activeKeyword) ? keywords : keywords.slice(0, 3);
    const chips = visibleKeywords.map((k) => {
      const active = activeKeyword === k.word;
      return el('button', {
        class: 'heatmap-kw-chip' + (active ? ' is-active' : ''),
        type: 'button',
        'aria-pressed': String(active),
        title: `在波形条上点亮「${k.word}」出现的全部时间点（共 ${k.count} 次）并跳播`,
        on: {
          click: () => {
            if (activeKeyword === k.word) {
              activeKeyword = null;
              activeKwOccurrences = [];
              activeKwIdx = -1;
            } else {
              activeKeyword = k.word;
              activeKwOccurrences = k.times || [];
              activeKwIdx = 0;
              if (activeKwOccurrences[0] != null) onSeek(activeKwOccurrences[0]);
            }
            renderKeywords();
            draw();
          },
        },
      },
        el('span', {}, k.word),
        el('span', { class: 'heatmap-kw-count' }, String(k.count)),
      );
    });

    let navGroup = null;
    if (activeKeyword && activeKwOccurrences.length > 1) {
      navGroup = el('div', { class: 'heatmap-kw-nav' },
        el('button', {
          class: 'heatmap-kw-step',
          type: 'button',
          title: '跳至上一处',
          'aria-label': '跳至上一处',
          on: {
            click: (e) => {
              e.stopPropagation();
              activeKwIdx = (activeKwIdx - 1 + activeKwOccurrences.length) % activeKwOccurrences.length;
              onSeek(activeKwOccurrences[activeKwIdx]);
              renderKeywords();
            },
          },
        }, el('span', { 'aria-hidden': 'true' }, '‹')),
        el('span', { class: 'heatmap-kw-pos' }, `${activeKwIdx + 1} / ${activeKwOccurrences.length}`),
        el('button', {
          class: 'heatmap-kw-step',
          type: 'button',
          title: '跳至下一处',
          'aria-label': '跳至下一处',
          on: {
            click: (e) => {
              e.stopPropagation();
              activeKwIdx = (activeKwIdx + 1) % activeKwOccurrences.length;
              onSeek(activeKwOccurrences[activeKwIdx]);
              renderKeywords();
            },
          },
        }, el('span', { 'aria-hidden': 'true' }, '›')),
      );
    }

    let moreChip = null;
    if (keywords.length > 3 && !activeKeyword) {
      moreChip = el('button', {
        class: 'heatmap-kw-chip heatmap-kw-more',
        type: 'button',
        'aria-expanded': String(kwExpanded),
        title: kwExpanded ? '收起关键词' : `还有 ${keywords.length - 3} 个关键词`,
        on: { click: () => { kwExpanded = !kwExpanded; renderKeywords(); } },
      }, kwExpanded ? '收起' : `+${keywords.length - 3}`);
    }

    kwRow.replaceChildren(
      el('span', { class: 'heatmap-kw-title' }, '关键词'),
      ...chips,
      ...(moreChip ? [moreChip] : []),
      ...(navGroup ? [navGroup] : []),
    );
    kwRow.hidden = false;
  }

  function renderHotspotChips() {
    if (!hotspots.length) {
      hotspotsBar.hidden = true;
      hotspotsBar.replaceChildren();
      return;
    }
    const unique = [];
    let lastT = -999;
    for (const spot of hotspots) {
      if (spot.t - lastT >= 15) {
        unique.push(spot);
        lastT = spot.t;
      }
      if (unique.length >= 6) break;
    }
    const visibleSpots = hotExpanded ? unique : unique.slice(0, 3);
    hotspotsBar.replaceChildren(
      el('span', { class: 'heatmap-hot-label' }, '评论时间点'),
      ...visibleSpots.map((spot) => el('button', {
        class: 'heatmap-hot-chip',
        type: 'button',
        title: `@${spot.author}: ${spot.snippet}`,
        on: { click: () => onSeek(spot.t) },
      },
        el('span', { class: 'heatmap-hot-ts' }, formatClock(spot.t)),
        el('span', {}, `@${spot.author}`),
      )),
      ...(unique.length > 3 ? [el('button', {
        class: 'heatmap-hot-chip heatmap-hot-more',
        type: 'button',
        'aria-expanded': String(hotExpanded),
        title: hotExpanded ? '收起评论时间点' : `还有 ${unique.length - 3} 处空降点`,
        on: { click: () => { hotExpanded = !hotExpanded; renderHotspotChips(); } },
      }, hotExpanded ? '收起' : `+${unique.length - 3}`)] : []),
    );
    hotspotsBar.hidden = false;
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    width = rect.width;
    height = rect.height || 44;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    draw();
  }

  function draw() {
    if (wrap.hidden || !width) return;
    const isDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme
        && window.matchMedia('(prefers-color-scheme: dark)').matches);

    ctx2d.save();
    ctx2d.scale(dpr, dpr);
    ctx2d.clearRect(0, 0, width, height);

    const dur = duration || 1;
    const playRatio = Math.min(1, Math.max(0, currentTime / dur));
    const barGap = 2;
    const barW = Math.max(2, (width - (BINS - 1) * barGap) / BINS);
    const baseY = height - 6;
    const maxBarH = height - 12;

    // 1. Draw Chapter segment separators
    if (chapters.length > 1) {
      ctx2d.strokeStyle = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.14)';
      ctx2d.lineWidth = 1;
      for (let i = 1; i < chapters.length; i++) {
        const cx = (chapters[i].s / dur) * width;
        if (cx > 4 && cx < width - 4) {
          ctx2d.beginPath();
          ctx2d.moveTo(cx, 2);
          ctx2d.lineTo(cx, baseY);
          ctx2d.stroke();
        }
      }
    }

    // 2. Draw Waveform Bars
    for (let i = 0; i < BINS; i++) {
      const ratio = (i + 0.5) / BINS;
      const x = i * (barW + barGap);
      const val = Math.min(1, bins[i] + hotBins[i] * 0.35);
      const h = Math.max(4, val * maxBarH);
      const y = baseY - h;

      const isPlayed = ratio <= playRatio;
      const isHovered = hoverRatio >= 0 && Math.abs(ratio - hoverRatio) < (1.2 / BINS);
      const isHot = hotBins[i] > 0.25;

      if (isHovered) {
        ctx2d.fillStyle = '#ffffff';
      } else if (isHot) {
        ctx2d.fillStyle = isPlayed ? '#facc15' : '#eab308';
      } else if (isPlayed) {
        ctx2d.fillStyle = '#ff6600';
      } else {
        ctx2d.fillStyle = isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(15, 23, 42, 0.18)';
      }

      ctx2d.beginPath();
      ctx2d.roundRect(x, y, barW, h, 2);
      ctx2d.fill();
    }

    // 3. Draw Personal Bookmark Pins (📌)
    for (const note of notes) {
      const nx = Math.min(width - 4, Math.max(4, (note.t / dur) * width));
      ctx2d.fillStyle = '#38bdf8';
      ctx2d.beginPath();
      ctx2d.arc(nx, 5, 3.5, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // 4. Draw Playhead Indicator
    if (currentTime > 0) {
      const px = playRatio * width;
      ctx2d.fillStyle = '#ff6600';
      ctx2d.fillRect(Math.max(0, px - 1), 0, 2, height);
    }

    // 5. Draw Active Keyword Pulse Needles
    if (activeKeyword && activeKwOccurrences.length) {
      ctx2d.save();
      ctx2d.strokeStyle = '#38bdf8';
      ctx2d.lineWidth = 2;
      for (const t of activeKwOccurrences) {
        const kx = (t / dur) * width;
        if (kx >= 2 && kx <= width - 2) {
          ctx2d.beginPath();
          ctx2d.moveTo(kx, 2);
          ctx2d.lineTo(kx, baseY);
          ctx2d.stroke();

          ctx2d.fillStyle = '#38bdf8';
          ctx2d.beginPath();
          ctx2d.arc(kx, 4, 3, 0, Math.PI * 2);
          ctx2d.fill();
        }
      }
      ctx2d.restore();
    }

    // 6. Draw Subtitle Live Search Hit Needles (🔍)
    if (searchHitTimes.length) {
      ctx2d.save();
      for (const t of searchHitTimes) {
        const sx = (t / dur) * width;
        if (sx >= 2 && sx <= width - 2) {
          const isFocused = searchActiveTime != null && Math.abs(t - searchActiveTime) < 0.25;
          ctx2d.strokeStyle = isFocused ? '#34d399' : '#10b981';
          ctx2d.lineWidth = isFocused ? 2.5 : 1.75;
          ctx2d.beginPath();
          ctx2d.moveTo(sx, 2);
          ctx2d.lineTo(sx, baseY);
          ctx2d.stroke();

          ctx2d.fillStyle = isFocused ? '#a7f3d0' : '#10b981';
          ctx2d.beginPath();
          ctx2d.arc(sx, 4, isFocused ? 4.2 : 3, 0, Math.PI * 2);
          ctx2d.fill();
        }
      }
      ctx2d.restore();
    }

    ctx2d.restore();
  }

  function findChapterAt(sec) {
    let cur = null;
    for (const ch of chapters) {
      if (ch.s <= sec + 0.5) cur = ch;
      else break;
    }
    return cur;
  }

  stage.addEventListener('pointermove', (event) => {
    if (!duration) return;
    const rect = stage.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    hoverRatio = ratio;
    const sec = ratio * duration;

    tipTs.textContent = formatClock(sec);
    const ch = findChapterAt(sec);
    tipChap.textContent = ch ? `· ${ch.t}` : '';

    if (cues.length) {
      const idx = findActiveStreamCue(cues, sec);
      const cue = idx >= 0 ? cues[idx] : null;
      tipCue.textContent = cue ? `“${cue.zh || cue.en}”` : '（间奏 / 无台词片段）';
    } else {
      tipCue.textContent = '点击跳转到此时间点';
    }

    const nearHot = hotspots.find((h) => Math.abs(h.t - sec) <= Math.max(18, duration * 0.025));
    const nearNote = notes.find((n) => Math.abs(n.t - sec) <= Math.max(15, duration * 0.02));
    if (nearNote) {
      tipHot.textContent = `📌 我的随手记：${nearNote.text || nearNote.cue || '书签'}`;
      tipHot.hidden = false;
    } else if (nearHot) {
      tipHot.textContent = `🔥 @${nearHot.author} 提及 (${nearHot.label})：${nearHot.snippet}`;
      tipHot.hidden = false;
    } else {
      tipHot.hidden = true;
    }

    const clampedLeft = Math.min(rect.width - 90, Math.max(90, event.clientX - rect.left));
    tip.style.left = `${clampedLeft}px`;
    tip.hidden = false;
    draw();
  });

  stage.addEventListener('pointerleave', () => {
    hoverRatio = -1;
    tip.hidden = true;
    draw();
  });

  stage.addEventListener('click', (event) => {
    if (!duration) return;
    const rect = stage.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onSeek(Math.floor(ratio * duration));
  });

  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);

  return {
    node: wrap,
    setVisible(nextVisible) {
      const next = nextVisible === true;
      if (visible === next) return;
      visible = next;
      recomputeBins();
      if (visible) requestAnimationFrame(resize);
    },
    setCues(nextCues) {
      cues = Array.isArray(nextCues) ? nextCues : [];
      recomputeBins();
      requestAnimationFrame(resize);
    },
    setChapters(nextChapters, dur = 0) {
      chapters = Array.isArray(nextChapters) ? nextChapters : [];
      if (dur > 0) duration = Math.max(duration, dur);
      recomputeBins();
      requestAnimationFrame(resize);
    },
    setComments(nextComments) {
      comments = Array.isArray(nextComments) ? nextComments : (nextComments?.comments || []);
      recomputeBins();
    },
    setSearchHits(query, times, activeTime = null) {
      searchHitQuery = (query || '').trim();
      searchHitTimes = Array.isArray(times) ? times : [];
      searchActiveTime = activeTime;
      if (searchHitQuery && searchHitTimes.length) {
        searchLegText.textContent = `搜索「${searchHitQuery.slice(0, 12)}」(${searchHitTimes.length}) 🔍`;
        searchLegItem.hidden = false;
      } else {
        searchLegItem.hidden = true;
      }
      draw();
    },
    refreshNotes() {
      notes = store.getNotes(video.vid);
      draw();
    },
    refresh() {
      notes = store.getNotes(video.vid);
      draw();
    },
    setProgress(sec, dur = 0) {
      this.updateTime(sec, dur);
    },
    updateTime(sec, dur = 0) {
      currentTime = sec || 0;
      if (dur > 0 && Math.abs(dur - duration) > 5) {
        duration = dur;
        recomputeBins();
      } else {
        draw();
      }
    },
    getHotspots() {
      return hotspots;
    },
    destroy() {
      ro.disconnect();
    },
  };
}
