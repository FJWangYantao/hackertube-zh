import { el } from './ui.js';

const YT_API = 'https://www.youtube.com/iframe_api';
const TRANSCRIPT_CHARS = 140;
const TRANSCRIPT_GAP = 3;

let apiPromise = null;

export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previous === 'function') previous();
        resolve(window.YT);
      };
      const script = document.createElement('script');
      script.src = YT_API;
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        reject(new Error('YouTube IFrame API 加载失败'));
      };
      document.head.append(script);
    });
  }
  return apiPromise;
}

export function findCue(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].e < time) low = mid + 1;
    else if (cues[mid].s > time) high = mid - 1;
    else return mid;
  }
  return -1;
}

export function createOverlay() {
  const enLine = el('span', { class: 'sub-en', hidden: true });
  const zhLine = el('span', { class: 'sub-zh' });
  const line = el('span', { class: 'sub-line', hidden: true }, enLine, zhLine);
  const layer = el('div', { class: 'sub-layer', 'aria-hidden': 'true' }, line);
  let cues = [];
  let enabled = true;
  let bilingual = false;
  let index = -1;

  function render(cue) {
    const zh = cue?.zh || '';
    const en = bilingual ? (cue?.en || '') : '';
    zhLine.textContent = zh;
    enLine.textContent = en;
    enLine.hidden = !en;
    line.hidden = !zh && !en;
  }

  function reset() {
    index = -1;
    line.hidden = true;
    zhLine.textContent = '';
    enLine.textContent = '';
  }

  return {
    layer,
    setCues(next) {
      cues = Array.isArray(next) ? next : [];
      reset();
    },
    setEnabled(on) {
      enabled = on;
      if (!on) reset();
    },
    setBilingual(on) {
      bilingual = on;
      if (enabled && index >= 0) render(cues[index]);
    },
    update(time) {
      if (!enabled) return;
      const next = findCue(cues, time);
      if (next === index) return;
      index = next;
      render(next >= 0 ? cues[next] : null);
    },
    clear: reset,
  };
}

export function groupTranscript(cues, maxChars = TRANSCRIPT_CHARS) {
  const blocks = [];
  let current = null;
  for (const cue of cues) {
    if (!cue?.zh) continue;
    if (!current) {
      current = { s: cue.s, e: cue.e, text: cue.zh, en: cue.en || '' };
      continue;
    }
    const gap = cue.s - current.e;
    if (gap > TRANSCRIPT_GAP || current.text.length + cue.zh.length > maxChars) {
      blocks.push(current);
      current = { s: cue.s, e: cue.e, text: cue.zh, en: cue.en || '' };
    } else {
      const joiner = /[A-Za-z0-9]$/.test(current.text) ? ' ' : '';
      const enJoiner = current.en && cue.en ? ' ' : '';
      current = {
        ...current,
        e: cue.e,
        text: current.text + joiner + cue.zh,
        en: current.en + enJoiner + (cue.en || ''),
      };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

export function stamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

export function findBlock(blocks, time) {
  let low = 0;
  let high = blocks.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (blocks[mid].s <= time + 0.15) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return -1;
  const block = blocks[candidate];
  if (time <= block.e + TRANSCRIPT_GAP) return candidate;
  return -1;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlighted(container, text, regex) {
  container.replaceChildren();
  if (!text) return;
  if (!regex) {
    container.textContent = text;
    return;
  }
  let lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const start = match.index;
    if (start > lastIndex) {
      container.append(document.createTextNode(text.slice(lastIndex, start)));
    }
    container.append(el('mark', { class: 'sub-mark' }, match[0]));
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    container.append(document.createTextNode(text.slice(lastIndex)));
  }
}

export function renderTranscript(cues, onSeek) {
  const blocks = groupTranscript(cues);
  const list = el('div', { class: 'transcript-list' });
  const items = [];
  let activeIndex = -1;
  let autoFollow = true;
  let hasQuery = false;

  function setActive(nextIndex, shouldScroll = true) {
    if (nextIndex === activeIndex) return;
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].node.classList.remove('is-active');
    }
    activeIndex = nextIndex;
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].node.classList.add('is-active');
      if (shouldScroll && autoFollow && details.open && !hasQuery) {
        scrollToActive(true);
      }
    }
  }

  function scrollToActive(smooth = true) {
    if (activeIndex < 0) return;
    const target = items[activeIndex]?.node;
    if (!target || target.hidden) return;
    const top = target.offsetTop - list.offsetTop - (list.clientHeight / 2) + (target.offsetHeight / 2);
    list.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  blocks.forEach((block, idx) => {
    const enEl = block.en ? el('span', { class: 'transcript-en' }, block.en) : null;
    const zhEl = el('span', { class: 'transcript-zh' }, block.text);
    const node = el('button', {
      class: 'transcript-line',
      type: 'button',
      on: {
        click: () => {
          setActive(idx, false);
          onSeek(block.s);
        },
      },
    },
      el('span', { class: 'transcript-ts' }, stamp(block.s)),
      el('span', { class: 'transcript-text' }, enEl, zhEl),
    );
    items.push({
      block,
      node,
      enEl,
      zhEl,
      haystack: `${block.text} ${block.en || ''}`.toLowerCase(),
    });
    list.append(node);
  });

  const emptyEl = el('p', { class: 'transcript-empty muted', hidden: true }, '没有匹配的字幕段落');
  list.append(emptyEl);

  const searchInput = el('input', {
    class: 'transcript-input',
    type: 'search',
    placeholder: '搜索字幕内容（中 / 英）…',
    autocomplete: 'off',
    'aria-label': '搜索字幕内容',
  });
  const matchCountEl = el('span', { class: 'transcript-match', hidden: true });
  const clearBtn = el('button', {
    class: 'transcript-clear',
    type: 'button',
    'aria-label': '清除字幕搜索',
    hidden: true,
  }, '×');

  const followBtn = el('button', {
    class: 'transcript-follow',
    type: 'button',
    'aria-pressed': 'true',
    title: '播放时自动滚动到当前字幕段落',
  }, '自动跟随');

  followBtn.addEventListener('click', () => {
    autoFollow = !autoFollow;
    followBtn.setAttribute('aria-pressed', autoFollow ? 'true' : 'false');
    if (autoFollow && !hasQuery) scrollToActive(true);
  });

  function applyFilter() {
    const raw = searchInput.value.trim();
    const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    hasQuery = terms.length > 0;
    clearBtn.hidden = !hasQuery;
    matchCountEl.hidden = !hasQuery;

    if (!hasQuery) {
      for (const item of items) {
        item.node.hidden = false;
        item.zhEl.textContent = item.block.text;
        if (item.enEl) item.enEl.textContent = item.block.en;
      }
      emptyEl.hidden = true;
      if (autoFollow && details.open) scrollToActive(false);
      return;
    }

    const regex = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
    let matches = 0;
    for (const item of items) {
      const matched = terms.every((t) => item.haystack.includes(t));
      item.node.hidden = !matched;
      if (matched) {
        matches += 1;
        renderHighlighted(item.zhEl, item.block.text, regex);
        if (item.enEl) renderHighlighted(item.enEl, item.block.en, regex);
      }
    }
    matchCountEl.textContent = `${matches} 段`;
    emptyEl.hidden = matches > 0;
  }

  searchInput.addEventListener('input', applyFilter);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.stopPropagation();
      searchInput.value = '';
      applyFilter();
    }
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    applyFilter();
    searchInput.focus();
  });

  const toolbar = el('div', { class: 'transcript-bar' },
    el('div', { class: 'transcript-search' }, searchInput, matchCountEl, clearBtn),
    followBtn,
  );

  const details = el('details', { class: 'transcript' },
    el('summary', {},
      el('span', {}, `字幕文稿 · ${cues.length} 句`),
      el('span', { class: 'transcript-hint' }, `共 ${blocks.length} 段 · 点击时间轴可跳转`),
    ),
    toolbar,
    list,
  );

  details.addEventListener('toggle', () => {
    if (details.open && autoFollow && !hasQuery) {
      requestAnimationFrame(() => scrollToActive(false));
    }
  });

  return {
    node: details,
    update(time) {
      const idx = findBlock(blocks, time);
      setActive(idx, true);
    },
    clear() {
      setActive(-1, false);
    },
  };
}
