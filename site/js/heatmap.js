import { el, formatClock } from './ui.js';
import { store } from './data.js';
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

export function createHeatmapBar({ video, onSeek }) {
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

  const subStatEl = el('span', { class: 'muted', style: { fontSize: '11.5px' } }, '');
  const head = el('div', { class: 'heatmap-head' },
    el('span', { class: 'heatmap-label' },
      el('span', { class: 'heatmap-pulse' }),
      el('span', {}, '高能声波与空降点'),
    ),
    subStatEl,
    el('div', { class: 'heatmap-legend' },
      el('span', { class: 'heatmap-leg-item' },
        el('span', { class: 'heatmap-leg-swatch', style: { background: '#ff6600' } }),
        '已播/语速密度',
      ),
      el('span', { class: 'heatmap-leg-item' },
        el('span', { class: 'heatmap-leg-swatch', style: { background: '#facc15' } }),
        'HN 评论提及 🔥',
      ),
      el('span', { class: 'heatmap-leg-item' },
        el('span', { class: 'heatmap-leg-swatch', style: { background: '#38bdf8' } }),
        '我的书签 📌',
      ),
    ),
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
  const hotspotsBar = el('div', { class: 'heatmap-hotspots', hidden: true });
  const wrap = el('div', { class: 'heatmap-wrap', hidden: true }, head, stage, hotspotsBar);

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

    renderHotspotChips();
    draw();
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
    hotspotsBar.replaceChildren(
      el('span', { class: 'heatmap-hot-label' }, '🔥 网友热议空降：'),
      ...unique.map((spot) => el('button', {
        class: 'heatmap-hot-chip',
        type: 'button',
        title: `@${spot.author}: ${spot.snippet}`,
        on: { click: () => onSeek(spot.t) },
      },
        el('span', { class: 'heatmap-hot-ts' }, formatClock(spot.t)),
        el('span', {}, `@${spot.author}`),
      )),
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
      comments = Array.isArray(nextComments) ? nextComments : [];
      recomputeBins();
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
    destroy() {
      ro.disconnect();
    },
  };
}
