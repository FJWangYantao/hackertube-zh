import { el, toast } from './ui.js';
import { store } from './data.js';
import { buildExportMenu } from './subexport.js';

const YT_API = 'https://www.youtube.com/iframe_api';
const STREAM_GAP = 2.5;
const SUB_SIZES = ['sm', 'md', 'lg'];
const SUB_DEFAULT_OFFSET = 9;
const SUB_MIN_OFFSET = 4;
const SUB_MAX_OFFSET = 78;

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

export function findActiveStreamCue(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].s <= time + 0.12) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return -1;
  const cue = cues[candidate];
  if (time <= cue.e + STREAM_GAP) return candidate;
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

  // ── 字号与底部偏移：localStorage 记忆，字幕胶囊可直接上下拖拽 ──
  const savedSize = store.get('sub_size', 'md');
  line.dataset.size = SUB_SIZES.includes(savedSize) ? savedSize : 'md';
  let offset = clampOffset(store.get('sub_offset', SUB_DEFAULT_OFFSET));
  applyOffset();

  function clampOffset(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return SUB_DEFAULT_OFFSET;
    return Math.min(SUB_MAX_OFFSET, Math.max(SUB_MIN_OFFSET, num));
  }

  function applyOffset() {
    layer.style.setProperty('--sub-bottom', `${offset}%`);
  }

  function persistOffset() {
    store.set('sub_offset', Math.round(offset * 10) / 10);
  }

  let drag = null;
  line.addEventListener('pointerdown', (event) => {
    drag = { id: event.pointerId, startY: event.clientY, startOffset: offset };
    line.classList.add('is-dragging');
    line.setPointerCapture?.(event.pointerId);
  });
  line.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const height = layer.getBoundingClientRect().height || 1;
    offset = clampOffset(drag.startOffset - ((event.clientY - drag.startY) / height) * 100);
    applyOffset();
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    line.classList.remove('is-dragging');
    persistOffset();
  };
  line.addEventListener('pointerup', endDrag);
  line.addEventListener('pointercancel', endDrag);
  line.addEventListener('dblclick', () => {
    offset = SUB_DEFAULT_OFFSET;
    applyOffset();
    persistOffset();
    toast('字幕位置已复位');
  });

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
    setSize(size) {
      if (!SUB_SIZES.includes(size)) return;
      line.dataset.size = size;
      store.set('sub_size', size);
    },
    getSize() {
      return SUB_SIZES.includes(line.dataset.size) ? line.dataset.size : 'md';
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

export function stamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderHighlighted(container, text, regex) {
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

/**
 * Build the live subtitle stream panel.
 * @param {Array<{s: number, e: number, zh: string, en: string}>} cues
 * @param {(seconds: number) => void} onSeek
 * @param {{ chapters?: Array<{s: number, t: string}>, meta?: {vid: string, title: string},
 *           onNotesChange?: () => void }} [opts]
 */
export function renderTranscript(cues, onSeek, opts = {}) {
  const { chapters = [], meta = {}, onNotesChange } = opts;
  const vid = meta.vid || '';
  let showEn = store.get('stream_en', true) !== false;
  const list = el('div', { class: 'transcript-list' + (showEn ? '' : ' hide-en') });
  const items = [];
  let activeIndex = -1;
  let pastBound = 0;
  let autoFollow = true;
  let hasQuery = false;
  let userPausedUntil = 0;

  const syncResumeBtn = el('button', {
    class: 'stream-resume-btn',
    type: 'button',
    hidden: true,
    on: {
      click: () => {
        userPausedUntil = 0;
        syncResumeBtn.hidden = true;
        scrollToActive(true);
      },
    },
  }, '回到当前播放处');

  function updatePastStates(nextIndex) {
    const targetBound = nextIndex >= 0 ? nextIndex : 0;
    if (targetBound > pastBound) {
      for (let i = pastBound; i < targetBound; i++) {
        items[i]?.node.classList.add('is-past');
      }
    } else if (targetBound < pastBound) {
      for (let i = targetBound; i < pastBound; i++) {
        items[i]?.node.classList.remove('is-past');
      }
    }
    pastBound = targetBound;
  }

  function setActive(nextIndex, shouldScroll = true) {
    if (nextIndex === activeIndex) return;
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].node.classList.remove('is-active');
    }
    activeIndex = nextIndex;
    updatePastStates(activeIndex);

    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].node.classList.remove('is-past');
      items[activeIndex].node.classList.add('is-active');
      if (shouldScroll && autoFollow && !hasQuery) {
        if (Date.now() < userPausedUntil) {
          syncResumeBtn.hidden = false;
        } else {
          syncResumeBtn.hidden = true;
          scrollToActive(true);
        }
      }
    } else {
      syncResumeBtn.hidden = true;
    }
  }

  function scrollToActive(smooth = true) {
    if (activeIndex < 0) return;
    const target = items[activeIndex]?.node;
    if (!target || target.hidden || !list.clientHeight) return;
    const top = target.offsetTop - list.offsetTop - (list.clientHeight * 0.36) + (target.offsetHeight / 2);
    list.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  const pauseByUserScroll = () => {
    if (!autoFollow || activeIndex < 0 || hasQuery) return;
    userPausedUntil = Date.now() + 5500;
    syncResumeBtn.hidden = false;
  };
  list.addEventListener('wheel', pauseByUserScroll, { passive: true });
  list.addEventListener('touchmove', pauseByUserScroll, { passive: true });

  // ── 行内书签：同一句重复点击即为取消 ──
  function noteIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function lineNoteAt(seconds) {
    return store.getNotes(vid).find((note) => Math.abs(note.t - seconds) <= 1) || null;
  }

  function toggleLineNote(cue) {
    if (!vid) return;
    const existing = lineNoteAt(cue.s);
    if (existing) {
      store.removeNote(vid, existing.id);
      toast('已取消书签');
    } else {
      store.addNote(vid, { t: cue.s, cueZh: cue.zh || '' });
      toast(`已在 ${stamp(cue.s)} 添加书签，可在「随手记」中补充文字`);
    }
    refreshNoteMarks();
    onNotesChange?.();
  }

  function refreshNoteMarks() {
    const times = new Set(store.getNotes(vid).map((note) => Math.floor(note.t)));
    for (const item of items) {
      item.node.classList.toggle('is-marked', times.has(Math.floor(item.cue.s)));
    }
  }

  // Optional chapter dividers interleaved with the cue lines.
  const chapterNodes = [];
  let chapterPos = 0;
  const addChapterHeader = (chapter) => {
    const node = el('button', {
      class: 'transcript-chapter',
      type: 'button',
      title: `跳到 ${stamp(chapter.s)}`,
      on: {
        click: () => {
          userPausedUntil = 0;
          syncResumeBtn.hidden = true;
          onSeek(chapter.s);
        },
      },
    },
      el('span', { class: 'transcript-chapter-ts' }, stamp(chapter.s)),
      el('span', { class: 'transcript-chapter-title' }, chapter.t),
    );
    chapterNodes.push(node);
    list.append(node);
  };

  cues.forEach((cue, idx) => {
    while (chapterPos < chapters.length && cue.s >= chapters[chapterPos].s - 0.01) {
      addChapterHeader(chapters[chapterPos]);
      chapterPos += 1;
    }
    const enText = (cue.en || '').trim();
    const zhText = (cue.zh || '').trim();
    const enEl = enText ? el('span', { class: 'transcript-en' }, enText) : null;
    const zhEl = el('span', { class: 'transcript-zh' }, zhText);
    const noteBtn = el('span', {
      class: 'line-note-btn',
      title: '标记 / 取消书签',
      'aria-hidden': 'true',
    }, noteIcon());
    noteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleLineNote(cue);
    });
    const node = el('button', {
      class: 'transcript-line',
      type: 'button',
      on: {
        click: () => {
          userPausedUntil = 0;
          syncResumeBtn.hidden = true;
          setActive(idx, false);
          onSeek(cue.s);
        },
      },
    },
      el('span', { class: 'transcript-ts' }, stamp(cue.s)),
      el('span', { class: 'transcript-text' }, zhEl, enEl),
      noteBtn,
    );
    items.push({
      cue,
      node,
      enEl,
      zhEl,
      haystack: `${zhText} ${enText}`.toLowerCase(),
    });
    list.append(node);
  });

  refreshNoteMarks();

  const emptyEl = el('p', { class: 'transcript-empty muted', hidden: true }, '没有匹配的字幕句');
  list.append(emptyEl);

  const searchInput = el('input', {
    class: 'transcript-input',
    type: 'search',
    placeholder: '搜索字幕（中 / 英）…',
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

  const biBtn = el('button', {
    class: 'transcript-follow',
    type: 'button',
    'aria-pressed': showEn ? 'true' : 'false',
    title: '切换显示中英对照或仅中文',
  }, showEn ? '中英' : '仅中');

  biBtn.addEventListener('click', () => {
    showEn = !showEn;
    store.set('stream_en', showEn);
    list.classList.toggle('hide-en', !showEn);
    biBtn.textContent = showEn ? '中英' : '仅中';
    biBtn.setAttribute('aria-pressed', showEn ? 'true' : 'false');
    if (autoFollow && !hasQuery) requestAnimationFrame(() => scrollToActive(false));
  });

  const followBtn = el('button', {
    class: 'transcript-follow',
    type: 'button',
    'aria-pressed': 'true',
    title: '播放时自动滚动字幕流',
  }, '跟随');

  followBtn.addEventListener('click', () => {
    autoFollow = !autoFollow;
    userPausedUntil = 0;
    syncResumeBtn.hidden = true;
    followBtn.setAttribute('aria-pressed', autoFollow ? 'true' : 'false');
    if (autoFollow && !hasQuery) scrollToActive(true);
  });

  const copyBtn = el('button', {
    class: 'transcript-copy',
    type: 'button',
    title: '复制字幕文稿到剪贴板',
  }, '复制');

  copyBtn.addEventListener('click', async () => {
    const visible = items.filter((item) => !item.node.hidden);
    if (!visible.length) {
      toast('没有可复制的字幕');
      return;
    }
    const text = visible.map(({ cue }) => {
      const ts = `[${stamp(cue.s)}]`;
      return showEn && cue.en ? `${ts} ${cue.zh}\n${cue.en}` : `${ts} ${cue.zh}`;
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(hasQuery ? `已复制 ${visible.length} 句匹配字幕` : '已复制全部字幕');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
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
        item.zhEl.textContent = item.cue.zh;
        if (item.enEl) item.enEl.textContent = item.cue.en;
      }
      for (const node of chapterNodes) node.hidden = false;
      emptyEl.hidden = true;
      if (autoFollow) scrollToActive(false);
      return;
    }

    const regex = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
    let matches = 0;
    for (const item of items) {
      const matched = terms.every((t) => item.haystack.includes(t));
      item.node.hidden = !matched;
      if (matched) {
        matches += 1;
        renderHighlighted(item.zhEl, item.cue.zh, regex);
        if (item.enEl) renderHighlighted(item.enEl, item.cue.en, regex);
      }
    }
    // Searching is about the matching lines; chapter dividers only add noise.
    for (const node of chapterNodes) node.hidden = true;
    matchCountEl.textContent = `${matches} 句`;
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

  const exportMenu = buildExportMenu(cues, meta);
  const toolbar = el('div', { class: 'transcript-bar' },
    el('div', { class: 'transcript-search' }, searchInput, matchCountEl, clearBtn),
    biBtn,
    followBtn,
    copyBtn,
    exportMenu.node,
  );

  const panel = el('div', { class: 'stream-panel' },
    toolbar,
    list,
    syncResumeBtn,
  );

  return {
    node: panel,
    update(time) {
      const idx = findActiveStreamCue(cues, time);
      setActive(idx, true);
    },
    scrollToCurrent() {
      requestAnimationFrame(() => scrollToActive(false));
    },
    clear() {
      setActive(-1, false);
    },
    refreshNotes: refreshNoteMarks,
    destroy() {
      exportMenu.destroy();
    },
  };
}
