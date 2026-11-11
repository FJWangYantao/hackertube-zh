import { el, toast } from './ui.js';
import { store } from './data.js';
import { buildExportMenu } from './subexport.js';

const YT_API = 'https://www.youtube.com/iframe_api';
const STREAM_GAP = 2.5;
const SUB_SIZES = ['sm', 'md', 'lg'];
const SUB_SIZE_SCALES = { sm: 0.85, md: 1, lg: 1.22 };
const SUB_DEFAULTS = {
  x: 50,
  y: 86,
  scale: 1,
  maxW: 84,
  alpha: 0.68,
};
const SUB_MIN_SCALE = 0.55;
const SUB_MAX_SCALE = 2.4;
const SUB_MIN_MAX_W = 28;
const SUB_MAX_MAX_W = 96;
const SUB_MIN_ALPHA = 0;
const SUB_MAX_ALPHA = 0.95;
const SNAP_THRESHOLD_PCT = 1.8;

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
  const hudBadge = el('span', { class: 'sub-hud', hidden: true });

  // ── 四角缩放手柄 (nw/ne/sw/se) 与左右折行宽度手柄 (w/e) ──
  const cornerHandles = ['nw', 'ne', 'sw', 'se'].map((dir) => el('span', {
    class: `sub-handle is-corner is-${dir}`,
    dataset: { handle: dir },
    title: '拖拽四角：无级缩放字幕大小',
  }));
  const edgeHandles = ['w', 'e'].map((dir) => el('span', {
    class: `sub-handle is-edge is-${dir}`,
    dataset: { handle: dir },
    title: '拖拽左右边缘：调节字幕折行宽度',
  }));

  const guideV = el('div', { class: 'sub-guide-v', hidden: true });
  const line = el(
    'div',
    { class: 'sub-line', hidden: true },
    hudBadge,
    enLine,
    zhLine,
    ...cornerHandles,
    ...edgeHandles,
  );
  const layer = el('div', { class: 'sub-layer', 'aria-hidden': 'true' }, guideV, line);

  let cues = [];
  let enabled = true;
  let bilingual = false;
  let subMode = 'zh';
  let index = -1;
  let hudTimer = null;
  let onChangeCallback = null;

  // ── 读取并兼容历史配置（sub_box 优先，回退兼容旧版 sub_offset / sub_size） ──
  const legacySize = store.get('sub_size', 'md');
  const legacyOffset = Number(store.get('sub_offset', 9));
  const savedBox = store.get('sub_box', null);

  const state = {
    x: clampNum(savedBox?.x, 4, 96, SUB_DEFAULTS.x),
    y: clampNum(
      savedBox?.y,
      4,
      96,
      Number.isFinite(legacyOffset) ? 100 - Math.min(78, Math.max(4, legacyOffset)) - 5 : SUB_DEFAULTS.y,
    ),
    scale: clampNum(
      savedBox?.scale,
      SUB_MIN_SCALE,
      SUB_MAX_SCALE,
      SUB_SIZE_SCALES[legacySize] || SUB_DEFAULTS.scale,
    ),
    maxW: clampNum(savedBox?.maxW, SUB_MIN_MAX_W, SUB_MAX_MAX_W, SUB_DEFAULTS.maxW),
    alpha: clampNum(
      savedBox?.alpha,
      SUB_MIN_ALPHA,
      SUB_MAX_ALPHA,
      store.get('sub_alpha', SUB_DEFAULTS.alpha),
    ),
  };

  function clampNum(val, min, max, fallback) {
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function sizeNameForScale(scale) {
    if (scale <= 0.91) return 'sm';
    if (scale >= 1.13) return 'lg';
    return 'md';
  }

  function showHud(text, duration = 600) {
    hudBadge.textContent = text;
    hudBadge.hidden = false;
    if (hudTimer) clearTimeout(hudTimer);
    if (duration > 0) {
      hudTimer = setTimeout(() => {
        hudBadge.hidden = true;
      }, duration);
    }
  }

  function syncVisualPosition(clampState = false) {
    const lw = layer.clientWidth;
    const lh = layer.clientHeight;
    let vx = state.x;
    let vy = state.y;
    if (lw > 0 && lh > 0 && !line.hidden) {
      const bw = line.offsetWidth;
      const bh = line.offsetHeight;
      const halfW = Math.min(48.5, (bw / lw) * 50);
      const halfH = Math.min(47.5, (bh / lh) * 50);
      vx = Math.min(98.5 - halfW, Math.max(1.5 + halfW, vx));
      vy = Math.min(97.5 - halfH, Math.max(2.5 + halfH, vy));
      if (clampState) {
        state.x = vx;
        state.y = vy;
      }
    }
    layer.style.setProperty('--sub-x', `${vx.toFixed(2)}%`);
    layer.style.setProperty('--sub-y', `${vy.toFixed(2)}%`);
    line.classList.toggle('is-near-top', vy < 18);
  }

  function applyBoxStyles(clampState = false) {
    line.style.setProperty('--sub-scale', state.scale.toFixed(3));
    line.style.setProperty('--sub-max-w', `${state.maxW.toFixed(1)}%`);
    line.style.setProperty('--sub-alpha', state.alpha.toFixed(2));
    line.dataset.size = sizeNameForScale(state.scale);
    line.classList.toggle('is-clear-bg', state.alpha < 0.12);
    syncVisualPosition(clampState);
    onChangeCallback?.({ ...state });
  }

  function persistBox() {
    store.set('sub_box', {
      x: Math.round(state.x * 10) / 10,
      y: Math.round(state.y * 10) / 10,
      scale: Math.round(state.scale * 100) / 100,
      maxW: Math.round(state.maxW * 10) / 10,
      alpha: Math.round(state.alpha * 100) / 100,
    });
    store.set('sub_size', sizeNameForScale(state.scale));
    store.set('sub_alpha', Math.round(state.alpha * 100) / 100);
  }

  applyBoxStyles();

  // ── 复位（双击字幕） ──
  function resetAll() {
    Object.assign(state, SUB_DEFAULTS);
    applyBoxStyles();
    persistBox();
    showHud('已复位默认外观', 750);
    toast('字幕位置、大小、宽度与透明度已复位');
  }

  // ── 统一指针交互：任意拖拽平移 (move) / 四角缩放字号 (scale) / 左右边缘调宽度 (width) ──
  let interaction = null;
  line.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;

    const handleEl = event.target.closest('.sub-handle');
    const handle = handleEl?.dataset.handle || '';
    const layerRect = layer.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const cx = lineRect.left + lineRect.width / 2;
    const cy = lineRect.top + lineRect.height / 2;

    if (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se') {
      interaction = {
        mode: 'scale',
        id: event.pointerId,
        cx,
        cy,
        startDist: Math.max(24, Math.hypot(event.clientX - cx, event.clientY - cy)),
        startScale: state.scale,
      };
      line.classList.add('is-interacting', 'is-scaling');
    } else if (handle === 'w' || handle === 'e') {
      interaction = {
        mode: 'width',
        id: event.pointerId,
        dir: handle === 'e' ? 1 : -1,
        startX: event.clientX,
        startMaxW: state.maxW,
        layerW: layerRect.width || 1,
      };
      line.classList.add('is-interacting', 'is-resizing-width');
    } else {
      interaction = {
        mode: 'move',
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPctX: state.x,
        startPctY: state.y,
        layerW: layerRect.width || 1,
        layerH: layerRect.height || 1,
      };
      line.classList.add('is-interacting', 'is-dragging');
    }
    line.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  line.addEventListener('pointermove', (event) => {
    if (!interaction || event.pointerId !== interaction.id) return;
    if (interaction.mode === 'move') {
      const dxPct = ((event.clientX - interaction.startX) / interaction.layerW) * 100;
      const dyPct = ((event.clientY - interaction.startY) / interaction.layerH) * 100;
      let nextX = clampNum(interaction.startPctX + dxPct, 2, 98, state.x);
      const nextY = clampNum(interaction.startPctY + dyPct, 3, 97, state.y);
      // 水平中轴磁吸（距离 50% 小于阈值时自动吸附并展示居中对齐线）
      const snapped = Math.abs(nextX - 50) <= SNAP_THRESHOLD_PCT;
      if (snapped) nextX = 50;
      guideV.hidden = !snapped;
      state.x = nextX;
      state.y = nextY;
      syncVisualPosition(true);
    } else if (interaction.mode === 'scale') {
      const curDist = Math.max(12, Math.hypot(event.clientX - interaction.cx, event.clientY - interaction.cy));
      const ratio = curDist / interaction.startDist;
      state.scale = clampNum(interaction.startScale * ratio, SUB_MIN_SCALE, SUB_MAX_SCALE, state.scale);
      applyBoxStyles(false);
      showHud(`字号 ${Math.round(state.scale * 100)}%`, 0);
    } else if (interaction.mode === 'width') {
      const deltaPx = (event.clientX - interaction.startX) * interaction.dir;
      const deltaPct = ((deltaPx * 2) / interaction.layerW) * 100;
      state.maxW = clampNum(interaction.startMaxW + deltaPct, SUB_MIN_MAX_W, SUB_MAX_MAX_W, state.maxW);
      applyBoxStyles(false);
      showHud(`折行宽度 ${Math.round(state.maxW)}%`, 0);
    }
  });

  const endInteraction = (event) => {
    if (!interaction || event.pointerId !== interaction.id) return;
    interaction = null;
    guideV.hidden = true;
    line.classList.remove('is-interacting', 'is-dragging', 'is-scaling', 'is-resizing-width');
    syncVisualPosition(false);
    persistBox();
    if (!hudBadge.hidden) {
      showHud(hudBadge.textContent, 380);
    }
  };
  line.addEventListener('pointerup', endInteraction);
  line.addEventListener('pointercancel', endInteraction);
  line.addEventListener('pointerleave', () => {
    if (!interaction && !hudBadge.hidden) {
      showHud(hudBadge.textContent, 160);
    }
  });

  // ── 滚轮微调：Alt/Shift + 滚轮调透明度，Ctrl + 滚轮调字号 ──
  line.addEventListener('wheel', (event) => {
    if (!event.altKey && !event.shiftKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    const dir = event.deltaY < 0 ? 1 : -1;
    if (event.ctrlKey) {
      state.scale = clampNum(state.scale + dir * 0.06, SUB_MIN_SCALE, SUB_MAX_SCALE, state.scale);
      applyBoxStyles();
      persistBox();
      showHud(`字号 ${Math.round(state.scale * 100)}%`, 550);
    } else {
      state.alpha = clampNum(state.alpha + dir * 0.05, SUB_MIN_ALPHA, SUB_MAX_ALPHA, state.alpha);
      applyBoxStyles();
      persistBox();
      showHud(`底色 ${Math.round(state.alpha * 100)}%`, 550);
    }
  }, { passive: false });

  line.addEventListener('dblclick', (event) => {
    if (event.target.closest('.sub-handle')) return;
    resetAll();
  });

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => syncVisualPosition(false));
    ro.observe(layer);
    layer._resizeObserver = ro;
  }

  function render(cue) {
    if (subMode === 'en') {
      const en = cue?.en || cue?.zh || '';
      zhLine.textContent = en;
      enLine.textContent = '';
      enLine.hidden = true;
      line.hidden = !en;
    } else {
      const zh = cue?.zh || '';
      const en = (subMode === 'both' || bilingual) ? (cue?.en || '') : '';
      zhLine.textContent = zh;
      enLine.textContent = en;
      enLine.hidden = !en;
      line.hidden = !zh && !en;
    }
    if (!line.hidden) syncVisualPosition(false);
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
      subMode = on ? 'both' : 'zh';
      if (enabled && index >= 0) render(cues[index]);
    },
    setMode(mode) {
      if (mode === 'off') {
        enabled = false;
        reset();
        return;
      }
      enabled = true;
      if (mode === 'zh' || mode === 'both' || mode === 'en') {
        subMode = mode;
        bilingual = mode === 'both';
      }
      if (index >= 0) render(cues[index]);
    },
    getMode() {
      return enabled ? subMode : 'off';
    },
    setSize(size) {
      if (!SUB_SIZES.includes(size)) return;
      state.scale = SUB_SIZE_SCALES[size] || 1;
      applyBoxStyles();
      persistBox();
    },
    getSize() {
      return sizeNameForScale(state.scale);
    },
    stepScale(delta) {
      state.scale = clampNum(state.scale + delta, SUB_MIN_SCALE, SUB_MAX_SCALE, state.scale);
      applyBoxStyles();
      persistBox();
      showHud(`字号 ${Math.round(state.scale * 100)}%`, 850);
      return state.scale;
    },
    getScale() {
      return state.scale;
    },
    setAlpha(alpha) {
      state.alpha = clampNum(alpha, SUB_MIN_ALPHA, SUB_MAX_ALPHA, state.alpha);
      applyBoxStyles();
      persistBox();
      showHud(`底色 ${Math.round(state.alpha * 100)}%`, 850);
      return state.alpha;
    },
    getAlpha() {
      return state.alpha;
    },
    cycleAlpha() {
      const steps = [0.68, 0.88, 0.42, 0];
      const cur = state.alpha;
      const idx = steps.findIndex((s) => Math.abs(s - cur) < 0.08);
      const next = steps[(idx + 1) % steps.length];
      return this.setAlpha(next);
    },
    resetLayout: resetAll,
    set onChange(fn) {
      onChangeCallback = fn;
    },
    update(time) {
      if (!enabled) return;
      const next = findCue(cues, time);
      if (next === index) return;
      index = next;
      render(next >= 0 ? cues[next] : null);
    },
    clear: reset,
    destroy() {
      if (layer._resizeObserver) {
        layer._resizeObserver.disconnect();
        layer._resizeObserver = null;
      }
      reset();
    },
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
  const { chapters = [], meta = {}, onNotesChange, onSearchHits } = opts;
  const vid = meta.vid || '';
  const savedStreamLang = store.get('stream_lang', null);
  let streamLang = (savedStreamLang === 'both' || savedStreamLang === 'zh' || savedStreamLang === 'en')
    ? savedStreamLang
    : (store.get('stream_en', true) !== false ? 'both' : 'zh');
  const list = el('div', {
    class: 'transcript-list'
      + (streamLang === 'zh' ? ' hide-en' : '')
      + (streamLang === 'en' ? ' hide-zh' : ''),
  });
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
    chapterNodes.push({ node, s: Number(chapter.s) || 0 });
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
    const noteBtn = el('button', {
      class: 'line-note-btn',
      type: 'button',
      title: '标记 / 取消书签',
      'aria-label': '标记或取消当前字幕书签',
    }, noteIcon());
    noteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleLineNote(cue);
    });
    const node = el('div', {
      class: 'transcript-line',
      role: 'button',
      tabindex: '0',
      on: {
        click: (e) => {
          if (e.target.closest('.line-note-btn')) return;
          userPausedUntil = 0;
          syncResumeBtn.hidden = true;
          setActive(idx, false);
          onSeek(cue.s);
        },
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (e.target.closest('.line-note-btn')) return;
            e.preventDefault();
            userPausedUntil = 0;
            syncResumeBtn.hidden = true;
            setActive(idx, false);
            onSeek(cue.s);
          }
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
    placeholder: '搜索字幕（Enter 下一个 / G 聚焦）…',
    autocomplete: 'off',
    'aria-label': '搜索字幕内容',
  });
  const matchCountEl = el('span', { class: 'transcript-match', hidden: true });
  const prevHitBtn = el('button', {
    class: 'transcript-search-nav',
    type: 'button',
    title: '上一个匹配句 (Shift+Enter)',
    'aria-label': '上一个匹配句',
    hidden: true,
  }, '‹');
  const nextHitBtn = el('button', {
    class: 'transcript-search-nav',
    type: 'button',
    title: '下一个匹配句 (Enter)',
    'aria-label': '下一个匹配句',
    hidden: true,
  }, '›');
  const clearBtn = el('button', {
    class: 'transcript-clear',
    type: 'button',
    'aria-label': '清除字幕搜索',
    hidden: true,
  }, '×');

  const STREAM_LANG_LABEL = { both: '中英', zh: '仅中', en: '仅英' };
  const biBtn = el('button', {
    class: 'transcript-follow',
    type: 'button',
    'aria-pressed': streamLang === 'both' ? 'true' : 'false',
    title: '切换字幕文稿语言：中英对照 / 仅中文 / 仅英文',
  }, STREAM_LANG_LABEL[streamLang] || '中英');

  biBtn.addEventListener('click', () => {
    const order = ['both', 'zh', 'en'];
    streamLang = order[(order.indexOf(streamLang) + 1) % order.length];
    store.set('stream_lang', streamLang);
    store.set('stream_en', streamLang !== 'zh');
    list.classList.toggle('hide-en', streamLang === 'zh');
    list.classList.toggle('hide-zh', streamLang === 'en');
    biBtn.textContent = STREAM_LANG_LABEL[streamLang];
    biBtn.setAttribute('aria-pressed', streamLang === 'both' ? 'true' : 'false');
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

  const copyAll = async () => {
    const visible = items.filter((item) => !item.node.hidden);
    if (!visible.length) {
      toast('没有可复制的字幕');
      return;
    }
    const text = visible.map(({ cue }) => {
      const ts = `[${stamp(cue.s)}]`;
      if (streamLang === 'en') return `${ts} ${cue.en || cue.zh}`;
      if (streamLang === 'zh') return `${ts} ${cue.zh}`;
      return cue.en ? `${ts} ${cue.zh}\n${cue.en}` : `${ts} ${cue.zh}`;
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(hasQuery ? `已复制 ${visible.length} 句匹配字幕` : '已复制全部字幕');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  };

  let matchedItems = [];
  let hitCursor = -1;

  function stepHit(delta) {
    if (!matchedItems.length) return;
    if (hitCursor >= 0 && matchedItems[hitCursor]) {
      matchedItems[hitCursor].node.classList.remove('is-search-focus');
    }
    hitCursor = (hitCursor + delta + matchedItems.length) % matchedItems.length;
    const targetItem = matchedItems[hitCursor];
    if (!targetItem) return;
    targetItem.node.classList.add('is-search-focus');
    matchCountEl.textContent = `${hitCursor + 1}/${matchedItems.length}`;
    userPausedUntil = Date.now() + 8000;
    onSeek(targetItem.cue.s);
    const top = targetItem.node.offsetTop - list.offsetTop - (list.clientHeight * 0.36) + (targetItem.node.offsetHeight / 2);
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    onSearchHits?.(searchInput.value.trim(), matchedItems.map((it) => it.cue.s), targetItem.cue.s);
  }

  function applyFilter() {
    const raw = searchInput.value.trim();
    const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    hasQuery = terms.length > 0;
    clearBtn.hidden = !hasQuery;
    matchCountEl.hidden = !hasQuery;

    for (const item of items) {
      item.node.classList.remove('is-search-focus');
    }
    matchedItems = [];
    hitCursor = -1;

    if (!hasQuery) {
      prevHitBtn.hidden = true;
      nextHitBtn.hidden = true;
      for (const item of items) {
        item.node.hidden = false;
        item.zhEl.textContent = item.cue.zh;
        if (item.enEl) item.enEl.textContent = item.cue.en;
      }
      for (const ch of chapterNodes) ch.node.hidden = false;
      emptyEl.hidden = true;
      onSearchHits?.('', [], null);
      if (autoFollow) scrollToActive(false);
      return;
    }

    const regex = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
    for (const item of items) {
      const matched = terms.every((t) => item.haystack.includes(t));
      item.node.hidden = !matched;
      if (matched) {
        matchedItems.push(item);
        renderHighlighted(item.zhEl, item.cue.zh, regex);
        if (item.enEl) renderHighlighted(item.enEl, item.cue.en, regex);
      }
    }
    // Searching is about the matching lines; chapter dividers only add noise.
    for (const ch of chapterNodes) ch.node.hidden = true;
    const matches = matchedItems.length;
    prevHitBtn.hidden = matches < 2;
    nextHitBtn.hidden = matches < 1;
    matchCountEl.textContent = `${matches} 句`;
    emptyEl.hidden = matches > 0;
    onSearchHits?.(raw, matchedItems.map((it) => it.cue.s), null);
  }

  prevHitBtn.addEventListener('click', () => stepHit(-1));
  nextHitBtn.addEventListener('click', () => stepHit(1));

  searchInput.addEventListener('input', applyFilter);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.stopPropagation();
      searchInput.value = '';
      applyFilter();
    } else if (event.key === 'Enter' && hasQuery && matchedItems.length) {
      event.preventDefault();
      stepHit(event.shiftKey ? -1 : 1);
    }
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    applyFilter();
    searchInput.focus();
  });

  // ── 📝 选区划词即随手记 / 复制精准引用 ──
  const selPop = el('div', { class: 'transcript-sel-pop', hidden: true });
  const noteSelBtn = el('button', {
    class: 'sel-pop-btn',
    type: 'button',
    title: '将选中文本添加到当前时间点随手记',
  }, '📌 记入随手记');
  const quoteSelBtn = el('button', {
    class: 'sel-pop-btn',
    type: 'button',
    title: '复制带时间戳的 Markdown 引用文本',
  }, '📋 复制引用');
  selPop.append(noteSelBtn, quoteSelBtn);
  document.body.append(selPop);

  let currentSelCue = null;
  let currentSelText = '';

  const checkSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      selPop.hidden = true;
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2) {
      selPop.hidden = true;
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      const commonNode = range.commonAncestorContainer;
      const lineEl = commonNode.nodeType === Node.ELEMENT_NODE
        ? commonNode.closest('.transcript-line')
        : commonNode.parentElement?.closest('.transcript-line');
      if (!lineEl || !list.contains(lineEl)) {
        selPop.hidden = true;
        return;
      }
      const idx = items.findIndex((it) => it.node === lineEl);
      if (idx < 0) {
        selPop.hidden = true;
        return;
      }
      currentSelCue = items[idx].cue;
      currentSelText = text;

      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        selPop.hidden = true;
        return;
      }
      selPop.style.top = `${Math.max(10, rect.top - 44)}px`;
      selPop.style.left = `${Math.max(10, rect.left + rect.width / 2)}px`;
      selPop.hidden = false;
    } catch {
      selPop.hidden = true;
    }
  };

  noteSelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentSelCue || !vid) return;
    store.addNote(vid, { t: currentSelCue.s, text: currentSelText, cueZh: currentSelCue.zh || '' });
    toast(`已记入随手记 · ${stamp(currentSelCue.s)}`);
    selPop.hidden = true;
    window.getSelection()?.removeAllRanges();
    refreshNoteMarks();
    onNotesChange?.();
  });

  quoteSelBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentSelCue) return;
    const url = `${location.origin}${location.pathname}#/video/${vid}?t=${Math.floor(currentSelCue.s)}`;
    const md = `> ${currentSelText}\n> — 《${meta.title || ''}》（${stamp(currentSelCue.s)}）${url}`;
    try {
      await navigator.clipboard.writeText(md);
      toast('已复制带时间戳的 Markdown 引用');
    } catch {
      window.prompt('复制引用', md);
    }
    selPop.hidden = true;
    window.getSelection()?.removeAllRanges();
  });

  list.addEventListener('mouseup', checkSelection);
  list.addEventListener('keyup', checkSelection);
  const onGlobalSelChange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) selPop.hidden = true;
  };
  document.addEventListener('selectionchange', onGlobalSelChange);

  const exportMenu = buildExportMenu(cues, meta, { onCopy: copyAll });
  const toolbar = el('div', { class: 'transcript-bar' },
    el('div', { class: 'transcript-search' }, searchInput, matchCountEl, prevHitBtn, nextHitBtn, clearBtn),
    biBtn,
    followBtn,
    exportMenu.node,
  );

  const panel = el('div', { class: 'stream-panel' },
    toolbar,
    list,
    syncResumeBtn,
  );

  let activeChapterIdx = -1;

  return {
    node: panel,
    update(time) {
      const idx = findActiveStreamCue(cues, time);
      setActive(idx, true);
      if (chapterNodes.length) {
        let nextCh = -1;
        for (let i = chapterNodes.length - 1; i >= 0; i--) {
          if (time + 0.1 >= chapterNodes[i].s) {
            nextCh = i;
            break;
          }
        }
        if (nextCh !== activeChapterIdx) {
          if (activeChapterIdx >= 0 && chapterNodes[activeChapterIdx]) {
            chapterNodes[activeChapterIdx].node.classList.remove('is-active');
          }
          activeChapterIdx = nextCh;
          if (activeChapterIdx >= 0 && chapterNodes[activeChapterIdx]) {
            chapterNodes[activeChapterIdx].node.classList.add('is-active');
          }
        }
      }
    },
    focusSearch() {
      searchInput.focus();
      searchInput.select();
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
      selPop.remove();
      document.removeEventListener('selectionchange', onGlobalSelChange);
    },
  };
}
