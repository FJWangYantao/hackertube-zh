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
  const line = el('span', { class: 'sub-line', hidden: true });
  const layer = el('div', { class: 'sub-layer', 'aria-hidden': 'true' }, line);
  let cues = [];
  let enabled = true;
  let index = -1;

  return {
    layer,
    setCues(next) {
      cues = Array.isArray(next) ? next : [];
      index = -1;
      line.hidden = true;
      line.textContent = '';
    },
    setEnabled(on) {
      enabled = on;
      index = -1;
      if (!on) {
        line.hidden = true;
        line.textContent = '';
      }
    },
    update(time) {
      if (!enabled) return;
      const next = findCue(cues, time);
      if (next === index) return;
      index = next;
      const text = next >= 0 ? cues[next].zh : '';
      line.textContent = text;
      line.hidden = !text;
    },
    clear() {
      index = -1;
      line.hidden = true;
      line.textContent = '';
    },
  };
}

export function groupTranscript(cues, maxChars = TRANSCRIPT_CHARS) {
  const blocks = [];
  let current = null;
  for (const cue of cues) {
    if (!cue?.zh) continue;
    if (!current) {
      current = { s: cue.s, e: cue.e, text: cue.zh };
      continue;
    }
    const gap = cue.s - current.e;
    if (gap > TRANSCRIPT_GAP || current.text.length + cue.zh.length > maxChars) {
      blocks.push(current);
      current = { s: cue.s, e: cue.e, text: cue.zh };
    } else {
      const joiner = /[A-Za-z0-9]$/.test(current.text) ? ' ' : '';
      current = { ...current, e: cue.e, text: current.text + joiner + cue.zh };
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

export function renderTranscript(cues, onSeek) {
  const list = el('div', { class: 'transcript-list' });
  for (const block of groupTranscript(cues)) {
    list.append(el('button', {
      class: 'transcript-line',
      type: 'button',
      on: { click: () => onSeek(block.s) },
    },
      el('span', { class: 'transcript-ts' }, stamp(block.s)),
      el('span', {}, block.text),
    ));
  }
  return el('details', { class: 'transcript' },
    el('summary', {}, `字幕文稿 · ${cues.length} 句`),
    list,
  );
}
