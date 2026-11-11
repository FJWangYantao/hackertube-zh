import {
  el, avatar, thumb, typeLabel, levelLabel, metaLine, toast, formatClock, thumbProgress,
} from './ui.js';
import { comments as loadComments, load, store, subs as loadSubs, chapters as loadChapters } from './data.js';
import { renderComments } from './comments.js';
import { createOverlay, loadYouTubeApi, renderTranscript, findActiveStreamCue } from './subtitles.js';
import { go } from './router.js';
import { loadSeriesFor, buildSeriesPanel, nextEpisode } from './series.js';
import { createHeatmapBar } from './heatmap.js';
import {
  emitBlockerState, emitSettingsChanged, SETTINGS_EVENT,
} from './settings.js';

const RELATED_LIMIT = 12;
const RELATED_MIN = 8;
const NEXT_COUNTDOWN_SECONDS = 5;
const RATE_STEPS = [0.75, 1, 1.25, 1.35, 1.5, 1.75, 2];
const YT_MESSAGE_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
]);

function normalizeRate(value) {
  return RATE_STEPS.includes(Number(value)) ? Number(value) : 1;
}

function rememberPlayback() {
  return store.get('remember_playback', true) !== false;
}

function formatRate(rate) {
  return `${rate}x`;
}

/* ── HUD 图标：单行图形化控制栏用 Material 风格 24x24 path ── */
const HUD_ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  volHigh: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05'
    + 'c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71'
    + 's-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volLow: 'M5 9v6h4l5 5V4L9 9H5zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05'
    + 'c1.48-.73 2.5-2.25 2.5-4.02z',
  volMute: 'M4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25'
    + 'c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73'
    + 'l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4zm4.5 8c0-1.77-1.02-3.29-2.5-4.03'
    + 'v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51'
    + 'A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71z',
  cc: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2z'
    + 'm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4'
    + 'c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1'
    + 'c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z',
  theater: 'M19 7H5c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 8H5V9h14v6z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  fastFwd: 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z',
  pencil: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41'
    + 'l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
};

function hudIcon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('class', 'hud-ic');
  node.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', HUD_ICONS[name]);
  node.append(path);
  return node;
}

function setHudIcon(button, name) {
  button.querySelector('.hud-ic path')?.setAttribute('d', HUD_ICONS[name]);
}

/**
 * Video id of an in-flight auto-advance: set right before navigating to the
 * next video so the incoming watch view mounts the player without waiting
 * for a click. Consumed (reset to null) by the first show() that reads it.
 */
let autoAdvanceVid = null;

function parseTimeParam(raw) {
  if (!raw) return 0;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const colonMatch = text.match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/);
  if (colonMatch) {
    return Number(colonMatch[1] || 0) * 3600 + Number(colonMatch[2]) * 60 + Number(colonMatch[3]);
  }
  const hmsMatch = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    return Number(hmsMatch[1] || 0) * 3600
      + Number(hmsMatch[2] || 0) * 60
      + Number(hmsMatch[3] || 0);
  }
  return 0;
}

export function show(container, route, ctx) {
  const video = ctx.feedIndex.get(route.vid);
  if (!video) {
    if (!ctx.feedComplete) {
      container.replaceChildren(el('div', { class: 'loading' }, '正在加载视频信息…'));
      let deferred = null;
      return {
        refresh() {
          deferred?.destroy?.();
          deferred = show(container, route, ctx);
        },
        destroy() {
          deferred?.destroy?.();
        },
      };
    }
    showError(container, '找不到这个视频', '链接可能已经失效。');
    return null;
  }

  let destroyed = false;
  let transcript = null;
  let cues = [];
  let toggleRailTab = null;
  let cachedRelatedMap = {};
  ctx.setTitle(`${video.title_zh || video.title} · HackerTube 中文`);
  markVisited(video.vid);

  const urlTime = parseTimeParam(route.params?.get('t'));
  const savedProgress = store.getProgress(video.vid);
  const canResumeSaved = !urlTime
    && savedProgress?.t >= 5
    && (!savedProgress.d || savedProgress.t < savedProgress.d - 12);
  const initialStart = urlTime || (canResumeSaved ? savedProgress.t : 0);
  const autoMount = autoAdvanceVid === video.vid;
  if (autoMount) autoAdvanceVid = null;

  const player = buildPlayer(video, initialStart, canResumeSaved, autoMount);
  const playbackControls = buildPlaybackControls(player);
  const chaptersPromise = loadChapters(video.vid).catch(() => null);

  const seekAndScroll = (seconds) => {
    player.seek(seconds);
    const rect = player.node.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      player.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const heatmap = createHeatmapBar({
    video,
    onSeek: (seconds) => seekAndScroll(seconds),
    visible: store.get('heatmap_enabled', true) !== false,
  });

  // ── 🪟 Mini 悬浮小窗包装器与伴读气泡 ──
  const playerWrap = el('div', { class: 'player-wrap' }, player.node);
  const miniBar = el('div', { class: 'mini-player-bar' },
    el('button', {
      class: 'mini-player-btn mini-player-restore',
      type: 'button',
      title: '回到正常画面 (滚动至顶部)',
      on: {
        click: (e) => {
          e.stopPropagation();
          playerWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
      },
    }, '⇡ 回到顶部'),
    el('button', {
      class: 'mini-player-btn mini-player-close',
      type: 'button',
      title: '关闭悬浮小窗',
      'aria-label': '关闭悬浮小窗',
      on: {
        click: (e) => {
          e.stopPropagation();
          dismissMini = true;
          player.node.classList.remove('is-mini');
        },
      },
    }, '✕'),
  );
  player.node.append(miniBar);

  let dismissMini = false;
  let main = null;

  const syncMiniState = () => {
    if (destroyed || !playerWrap || !player?.node) return;
    const rect = playerWrap.getBoundingClientRect();
    const isTheater = watchRoot?.classList.contains('is-theater');
    const isFullscreen = Boolean(document.fullscreenElement);
    // When the bottom of the original player wrapper is scrolled above the 56px app header
    const isOutOfView = rect.bottom < 56;
    if (isOutOfView && !dismissMini && !isTheater && !isFullscreen) {
      player.node.classList.add('is-mini');
      main?.classList.add('has-mini');
    } else {
      player.node.classList.remove('is-mini');
      main?.classList.remove('has-mini');
      if (rect.bottom >= 56) {
        dismissMini = false;
      }
    }
  };

  const miniObserver = new IntersectionObserver(() => {
    syncMiniState();
  }, { rootMargin: '-56px 0px 0px 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
  miniObserver.observe(playerWrap);
  window.addEventListener('scroll', syncMiniState, { passive: true });

  // ── 💬 播放时 HN 社区伴读微气泡 ──
  let whisperSpots = [];
  let lastWhisperSpot = null;
  let whisperTimer = null;
  const whisperEl = el('aside', {
    class: 'hn-whisper',
    hidden: true,
    'aria-live': 'polite',
  });
  playerWrap.append(whisperEl);

  const showWhisper = (spot) => {
    if (lastWhisperSpot === spot) return;
    lastWhisperSpot = spot;
    whisperEl.replaceChildren(
      el('div', { class: 'hn-whisper-head' },
        el('span', { class: 'hn-whisper-tag' }, '🔥 HN 伴读'),
        el('span', { class: 'hn-whisper-ts' }, formatClock(spot.t)),
        el('button', {
          class: 'hn-whisper-close',
          type: 'button',
          title: '关闭',
          'aria-label': '关闭气泡',
          on: {
            click: (e) => {
              e.stopPropagation();
              whisperEl.hidden = true;
            },
          },
        }, '×'),
      ),
      el('div', {
        class: 'hn-whisper-body',
        title: '点击跳转到底部查看 HN 评论讨论',
        on: {
          click: () => {
            commentsBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
            toast(`已定位至 HN 讨论 (@${spot.author})`);
          },
        },
      },
        el('span', { class: 'hn-whisper-author' }, `@${spot.author}：`),
        el('span', { class: 'hn-whisper-snippet' }, spot.snippet || '提及此时间点'),
        el('span', { class: 'hn-whisper-more' }, '查看原评 ↘'),
      ),
    );
    whisperEl.hidden = false;
    if (whisperTimer) clearTimeout(whisperTimer);
    whisperTimer = setTimeout(() => {
      whisperEl.hidden = true;
    }, 8500);
  };

  let outlineView = null;
  let selectRailTab = null;

  player.onTimeUpdate = (time, duration, force = false) => {
    playbackControls.update(time, duration);
    transcript?.update(time);
    outlineView?.update(time);
    heatmap.setProgress(time, duration);
    store.setProgress(video.vid, time, duration, force);

    if (whisperSpots.length && Math.abs((lastWhisperSpot?.t || -999) - time) > 6) {
      const hit = whisperSpots.find((sp) => Math.abs(sp.t - time) <= 3);
      if (hit) showWhisper(hit);
    }
  };

  const title = el('h1', { class: 'watch-title' }, video.title_zh || video.title);
  const english = video.title && video.title_zh && video.title !== video.title_zh
    ? el('p', { class: 'watch-sub' }, video.title)
    : null;
  const commentCount = video.comment_count || 0;
  const subtitleBtn = buildSubtitleButton(player);
  const rateBtn = buildRateButton(player);
  const skipSilenceBtn = buildSkipSilenceButton(player);
  const theaterBtn = buildTheaterButton();
  const autoplayBtn = buildAutoplayButton();
  const fullscreenBtn = buildFullscreenButton(player);
  const notesBadge = el('span', { class: 'hud-badge', hidden: true }, '0');
  const notesBtn = el('button', {
    class: 'hud-btn hud-icon-btn hud-notes-btn',
    type: 'button',
    title: '打开伴读随手记工作台 / 添加书签（快捷键 B）',
  }, hudIcon('pencil'), notesBadge);
  const helpBtn = el('button', {
    class: 'hud-btn hud-text-btn hud-btn-kbd',
    type: 'button',
    title: '键盘快捷键速查（快捷键 ?）',
    'aria-label': '键盘快捷键速查',
  }, '?');
  let watchRoot = null;
  const setTheater = (on, announce = false) => {
    watchRoot?.classList.toggle('is-theater', on);
    theaterBtn.classList.toggle('is-on', on);
    theaterBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    store.set('theater', on);
    if (announce) toast(on ? '已切换到宽屏' : '已恢复标准布局');
  };
  theaterBtn.addEventListener('click', () => {
    setTheater(!(watchRoot?.classList.contains('is-theater')), true);
  });
  let canSync = true;
  player.onFallback = () => {
    canSync = false;
    player.node.classList.add('is-fallback');
    subtitleBtn.hidden = true;
    skipSilenceBtn.hidden = true;
  };
  player.onRateChange = (value) => {
    rateBtn.textContent = formatRate(value);
  };

  // ── 随手记 / 时间戳书签与分栏伴读工作台 ──
  const cueTextAt = (seconds) => {
    if (!cues.length) return '';
    const idx = findActiveStreamCue(cues, seconds);
    return idx >= 0 ? (cues[idx].zh || '') : '';
  };
  const notesCard = buildNotesCard({
    video,
    onSeek: (t) => seekAndScroll(t),
    onChanged: () => syncNotesUi(),
  });
  const railNotesCountEl = el('span', { class: 'rail-tab-count' }, '0');
  const railNotesPanel = buildRailNotesPanel({
    video,
    getTime: () => player.getCurrentTime(),
    getCueText: cueTextAt,
    onSeek: (t) => seekAndScroll(t),
    onChanged: () => syncNotesUi(),
  });
  const syncNotesUi = () => {
    const count = store.getNotes(video.vid).length;
    notesBadge.textContent = String(count);
    notesBadge.hidden = count === 0;
    railNotesCountEl.textContent = String(count);
    notesCard.render();
    railNotesPanel.render();
    transcript?.refreshNotes?.();
    heatmap.refresh();
  };
  const noteEditor = buildNoteEditor({
    getTime: () => player.getCurrentTime(),
    getCueText: cueTextAt,
    onSave: (t, text, cueText) => {
      store.addNote(video.vid, { t, text, cueZh: cueText });
      toast(`已保存随手记 · ${formatClock(t)}`);
      syncNotesUi();
    },
  });
  const openNoteAction = () => {
    const isDesktop = window.matchMedia('(min-width: 1101px)').matches;
    const isFullscreen = Boolean(document.fullscreenElement);
    const isTheater = watchRoot?.classList.contains('is-theater');
    if (isDesktop && !isFullscreen && !isTheater && selectRailTab) {
      selectRailTab('notes');
      railNotesPanel.focusComposer(true);
    } else {
      noteEditor.open();
    }
  };
  notesBtn.addEventListener('click', openNoteAction);
  const kbdHelp = buildKbdHelp();
  helpBtn.addEventListener('click', () => kbdHelp.toggle(helpBtn));

  // ── 统一底部控制栏：单行图形化布局，参照传统视频网站 ──
  const playerHud = buildPlayerHud(player.node, playbackControls, [
    subtitleBtn,
    rateBtn,
    skipSilenceBtn,
    autoplayBtn,
    notesBtn,
    helpBtn,
    theaterBtn,
    fullscreenBtn,
  ]);
  player.node.append(playerHud.node, kbdHelp.node, noteEditor.node);

  const onSettingsChange = (event) => {
    const { key, value, origin } = event.detail || {};
    if (origin !== 'settings') return;
    if (key === 'subs_mode') subtitleBtn.setMode?.(value);
    else if (key === 'speed') player.setPlaybackRate(Number(value));
    else if (key === 'autoplay') autoplayBtn.setOn?.(value === true);
    else if (key === 'skip_silence') skipSilenceBtn.setOn?.(value === true);
    else if (key === 'sub_size') player.setSubSize(value);
    else if (key === 'sub_alpha') player.setSubAlpha(Number(value));
    else if (key === 'hud_hide_ms') playerHud.setHideDelay(Number(value));
    else if (key === 'heatmap_enabled') heatmap.setVisible(value === true);
  };
  window.addEventListener(SETTINGS_EVENT, onSettingsChange);

  const { row: channel, toggleSave } = buildChannel(video, commentCount, player);
  const description = buildDescription(video, ctx);
  const commentsBox = el('section', { class: 'comments' });

  if (commentCount > 0) {
    commentsBox.append(el('p', { class: 'muted' }, '正在加载讨论…'));
    loadComments(video.vid).then((payload) => {
      if (!destroyed) {
        const commentList = Array.isArray(payload) ? payload : (payload?.comments || []);
        if (commentList.length) {
          heatmap.setComments(commentList);
          whisperSpots = heatmap.getHotspots?.() || [];
        }
        renderComments(commentsBox, payload, seekAndScroll);
      }
    });
  } else {
    renderComments(commentsBox, null, seekAndScroll);
  }

  // 首屏层级对齐成熟视频站：播放器 → 标题 → 频道/操作行 → 热力图 → 简介。
  main = el('div', { class: 'watch-main' }, playerWrap, title);
  // Poster bleed for the CSS ambient glow around the player.
  main.style.setProperty(
    '--ambient-img',
    `url("https://i.ytimg.com/vi/${video.vid}/hqdefault.jpg")`,
  );
  if (english) main.append(english);
  main.append(channel, heatmap.node, description);
  // 我的笔记与书签：折叠卡片放在简介上方，无笔记时自动隐藏。
  main.insertBefore(notesCard.node, description);
  syncNotesUi();

  // AI outline: TL;DR card above the description.
  chaptersPromise.then((data) => {
    if (destroyed) return;
    const chapters = data?.chapters || [];
    if (!chapters.length) return;
    heatmap.setChapters(chapters);
    outlineView = buildOutline(data, seekAndScroll);
    if (initialStart > 0) outlineView.update(initialStart);
    main.insertBefore(outlineView.node, description);
  });

  const initialRelated = pickRelated(video, {}, ctx);
  const relatedCountEl = el('span', { class: 'rail-tab-count' }, String(initialRelated.length));
  const railList = el('div', { class: 'related-list' },
    ...initialRelated.map(relatedItem),
  );
  const rail = el('aside', { class: 'related' },
    el('h2', { class: 'rail-heading' }, '接下来'),
    railList,
  );

  function updateRelatedList() {
    const items = pickRelated(video, cachedRelatedMap, ctx);
    relatedCountEl.textContent = String(items.length);
    railList.replaceChildren(...items.map(relatedItem));
  }

  load.related().catch(() => ({})).then((relatedMap) => {
    cachedRelatedMap = relatedMap || {};
    if (destroyed || !cachedRelatedMap[video.vid]) return;
    updateRelatedList();
  });

  // 合集：当前视频属于某个系列时，在简介上方插入集数导航，连播优先按合集顺序。
  let seriesInfo = null;
  loadSeriesFor(video.vid).then((info) => {
    if (destroyed || !info) return;
    seriesInfo = info;
    main.insertBefore(buildSeriesPanel(info, ctx), description);
  });

  // Autoplay: when the video ends and 连播 is on, offer the top related pick
  // with a short countdown, then navigate. Playing again dismisses the panel.
  let nextPanel = null;
  let nextTimer = null;
  const clearNextPanel = () => {
    if (nextTimer) {
      clearInterval(nextTimer);
      nextTimer = null;
    }
    nextPanel?.remove();
    nextPanel = null;
  };
  /** 连播下一集：在合集中则按集数顺序，否则取相关推荐首位。 */
  const pickNext = () => {
    const seriesVid = seriesInfo ? nextEpisode(seriesInfo) : null;
    return (seriesVid && ctx.feedIndex.get(seriesVid))
      || pickRelated(video, cachedRelatedMap, ctx)[0];
  };
  const advanceToNext = () => {
    clearNextPanel();
    const next = pickNext();
    if (!next) {
      toast('没有可连播的推荐视频');
      return;
    }
    autoAdvanceVid = next.vid;
    go(`/video/${next.vid}`);
  };
  player.onEnded = () => {
    if (autoplayBtn.getOn?.() !== true || destroyed || nextPanel) return;
    const next = pickNext();
    if (!next) {
      toast('没有可连播的推荐视频');
      return;
    }
    const nextLabel = seriesInfo && nextEpisode(seriesInfo) === next.vid
      ? '下一集' : '接下来';
    let secondsLeft = NEXT_COUNTDOWN_SECONDS;
    const countdown = el(
      'span',
      { class: 'next-count' },
      `${secondsLeft} 秒后自动播放`,
    );
    const cancelBtn = el('button', {
      class: 'next-cancel',
      type: 'button',
      on: { click: clearNextPanel },
    }, '取消');
    const playNowBtn = el('button', {
      class: 'next-play',
      type: 'button',
      on: { click: advanceToNext },
    }, '立即播放');
    nextPanel = el('div', { class: 'player-next', role: 'status' },
      el('div', { class: 'next-info' },
        el('p', { class: 'next-label' }, nextLabel),
        el('p', { class: 'next-title' }, next.title_zh || next.title),
        countdown,
      ),
      el('div', { class: 'next-actions' }, playNowBtn, cancelBtn),
    );
    player.node.append(nextPanel);
    nextTimer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft > 0) {
        countdown.textContent = `${secondsLeft} 秒后自动播放`;
        return;
      }
      advanceToNext();
    }, 1000);
  };
  player.onPlaying = () => clearNextPanel();

  watchRoot = el('div', { class: 'watch' }, main, rail, commentsBox);
  container.replaceChildren(watchRoot);
  setTheater(store.get('theater', false) === true);

  loadSubs(video.vid).then(async (payload) => {
    if (destroyed) return;
    cues = (payload?.cues || []).filter((cue) => cue.zh);
    if (!cues.length) return;
    heatmap.setCues(cues);
    player.setCues(cues);
    subtitleBtn.hidden = !canSync;
    skipSilenceBtn.hidden = !canSync;
    const chapterData = await chaptersPromise;
    if (destroyed) return;
    transcript = renderTranscript(cues, seekAndScroll, {
      chapters: chapterData?.chapters || [],
      meta: { vid: video.vid, title: video.title_zh || video.title },
      onNotesChange: syncNotesUi,
      onSearchHits: (query, times, activeTime) => {
        heatmap.setSearchHits(query, times, activeTime);
      },
    });
    if (initialStart > 0) transcript.update(initialStart);

    let activeTab = 'stream';
    const streamTabBtn = el('button', {
      class: 'rail-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': 'true',
      title: '切换右侧面板（快捷键 T）',
    },
      el('span', { class: 'rail-live-dot', 'aria-hidden': 'true' }),
      el('span', {}, '实时字幕流'),
      el('span', { class: 'rail-tab-count' }, String(cues.length)),
    );

    const notesTabBtn = el('button', {
      class: 'rail-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': 'false',
      title: '伴读随手记与书签工作台（快捷键 B）',
    },
      el('span', {}, '随手记'),
      railNotesCountEl,
    );

    const relatedTabBtn = el('button', {
      class: 'rail-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': 'false',
      title: '切换右侧面板（快捷键 T）',
    },
      el('span', {}, '接下来'),
      relatedCountEl,
    );

    const setTab = (tab) => {
      activeTab = tab;
      const isStream = tab === 'stream';
      const isNotes = tab === 'notes';
      const isRelated = tab === 'related';
      streamTabBtn.setAttribute('aria-selected', isStream ? 'true' : 'false');
      notesTabBtn.setAttribute('aria-selected', isNotes ? 'true' : 'false');
      relatedTabBtn.setAttribute('aria-selected', isRelated ? 'true' : 'false');
      transcript.node.hidden = !isStream;
      railNotesPanel.node.hidden = !isNotes;
      railList.hidden = !isRelated;
      rail.classList.toggle('is-stream-active', isStream || isNotes);
      if (isStream) transcript.scrollToCurrent();
      if (isNotes) railNotesPanel.render();
    };
    selectRailTab = setTab;

    streamTabBtn.addEventListener('click', () => setTab('stream'));
    notesTabBtn.addEventListener('click', () => setTab('notes'));
    relatedTabBtn.addEventListener('click', () => setTab('related'));
    const tabCycle = ['stream', 'notes', 'related'];
    toggleRailTab = () => {
      const next = tabCycle[(tabCycle.indexOf(activeTab) + 1) % tabCycle.length];
      setTab(next);
    };

    const tabsBar = el('div', { class: 'rail-tabs', role: 'tablist', 'aria-label': '右侧边栏切换' },
      streamTabBtn,
      notesTabBtn,
      relatedTabBtn,
    );

    railNotesPanel.node.hidden = true;
    railList.hidden = true;
    rail.classList.add('has-stream', 'is-stream-active');
    rail.replaceChildren(tabsBar, transcript.node, railNotesPanel.node, railList);
    if (initialStart > 0) transcript.scrollToCurrent();
  });

  const onFullscreen = () => {
    const active = Boolean(document.fullscreenElement);
    setHudIcon(fullscreenBtn, active ? 'fullscreenExit' : 'fullscreen');
    fullscreenBtn.title = active ? '退出全屏（快捷键 F）' : '全屏播放（快捷键 F）';
  };
  document.addEventListener('fullscreenchange', onFullscreen);

  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!noteEditor.node.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        noteEditor.close();
      }
      return;
    }
    if (!kbdHelp.node.hidden) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        event.stopPropagation();
        kbdHelp.close();
      }
      return;
    }
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((event.code === 'Space' || event.key === 'k' || event.key === 'K')
      && tag !== 'BUTTON' && tag !== 'A') {
      event.preventDefault();
      player.togglePlayback();
    } else if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      player.toggleMute();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      player.seekBy(event.key === 'ArrowLeft' ? -5 : 5);
    } else if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      toggleSave();
    } else if ((event.key === 'c' || event.key === 'C') && !subtitleBtn.hidden) {
      event.preventDefault();
      subtitleBtn.click();
    } else if ((event.key === 'x' || event.key === 'X') && !skipSilenceBtn.hidden) {
      event.preventDefault();
      skipSilenceBtn.click();
    } else if ((event.key === 'g' || event.key === 'G') && transcript) {
      event.preventDefault();
      selectRailTab?.('stream');
      transcript.focusSearch();
    } else if ((event.key === 't' || event.key === 'T') && toggleRailTab) {
      event.preventDefault();
      toggleRailTab();
    } else if ((event.key === 'f' || event.key === 'F') && !fullscreenBtn.hidden) {
      event.preventDefault();
      fullscreenBtn.click();
    } else if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      autoplayBtn.click();
    } else if ((event.key === 'w' || event.key === 'W')
      && window.matchMedia('(min-width: 1101px)').matches) {
      event.preventDefault();
      theaterBtn.click();
    } else if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      player.seekBy(-10);
      toast(`⏪ 快退 10 秒 · ${formatClock(player.getCurrentTime())}`);
    } else if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      player.seekBy(10);
      toast(`⏩ 快进 10 秒 · ${formatClock(player.getCurrentTime())}`);
    } else if (event.key === '[') {
      event.preventDefault();
      const value = player.cyclePlaybackRate(-1);
      emitSettingsChanged('speed', value, 'hud');
      toast(`播放速度：${formatRate(value)}`);
    } else if (event.key === ']') {
      event.preventDefault();
      const value = player.cyclePlaybackRate(1);
      emitSettingsChanged('speed', value, 'hud');
      toast(`播放速度：${formatRate(value)}`);
    } else if (event.key === 'b' || event.key === 'B') {
      event.preventDefault();
      openNoteAction();
    } else if (event.key === '?') {
      event.preventDefault();
      kbdHelp.toggle();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  return {
    refresh() {
      if (destroyed) return;
      updateRelatedList();
    },
    destroy() {
      destroyed = true;
      clearNextPanel();
      miniObserver.disconnect();
      window.removeEventListener('scroll', syncMiniState);
      if (whisperTimer) clearTimeout(whisperTimer);
      heatmap?.destroy();
      playerHud.destroy();
      transcript?.destroy?.();
      window.removeEventListener(SETTINGS_EVENT, onSettingsChange);
      player.destroy();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreen);
    },
  };
}

/** TL;DR card with clickable chapter chips and live active chapter highlight. */
function buildOutline(data, onSeek) {
  const chapters = data.chapters || [];
  const chipEntries = chapters.map((chapter) => {
    const btn = el('button', {
      class: 'outline-chip',
      type: 'button',
      title: `跳到 ${formatClock(chapter.s)}`,
      on: { click: () => onSeek(chapter.s) },
    },
      el('span', { class: 'outline-chip-ts' }, formatClock(chapter.s)),
      el('span', {}, chapter.t),
    );
    return { node: btn, s: Number(chapter.s) || 0 };
  });

  const node = el('section', { class: 'watch-outline', 'aria-label': 'AI 内容大纲' },
    el('div', { class: 'outline-head' },
      el('h2', { class: 'outline-title' }, '内容大纲'),
      el('span', { class: 'outline-badge', title: '由 AI 根据字幕生成，仅供参考' }, 'AI 生成'),
    ),
    el('p', { class: 'outline-tldr' }, data.tldr || ''),
    el('div', { class: 'outline-chapters' },
      ...chipEntries.map((entry) => entry.node),
    ),
  );

  let activeIdx = -1;
  return {
    node,
    update(time) {
      if (!chipEntries.length) return;
      let nextIdx = -1;
      for (let i = chipEntries.length - 1; i >= 0; i--) {
        if (time + 0.2 >= chipEntries[i].s) {
          nextIdx = i;
          break;
        }
      }
      if (nextIdx !== activeIdx) {
        if (activeIdx >= 0 && chipEntries[activeIdx]) {
          chipEntries[activeIdx].node.classList.remove('is-active');
        }
        activeIdx = nextIdx;
        if (activeIdx >= 0 && chipEntries[activeIdx]) {
          chipEntries[activeIdx].node.classList.add('is-active');
        }
      }
    },
  };
}

function showError(container, heading, message) {
  container.replaceChildren(el('div', { class: 'empty' },
    el('h2', {}, heading),
    el('p', {}, message),
    el('a', { class: 'btn', href: '#/' }, '返回发现'),
  ));
}

function buildPlayer(video, initialStart = 0, isSavedResume = false, autoMount = false) {
  const player = el('div', { class: 'player' });
  const poster = el('img', {
    src: `https://i.ytimg.com/vi/${video.vid}/maxresdefault.jpg`,
    alt: '',
    width: 1280,
    height: 720,
  });
  let posterFallback = 0;
  poster.addEventListener('error', () => {
    posterFallback += 1;
    if (posterFallback === 1) poster.src = `https://i.ytimg.com/vi/${video.vid}/hqdefault.jpg`;
    else poster.remove();
  });

  const overlay = createOverlay();
  const host = el('div', { class: 'player-host' });
  const veil = el('div', { class: 'player-veil', 'aria-hidden': 'true' });
  const play = el('button', {
    class: 'play-btn',
    type: 'button',
    'aria-label': initialStart > 0
      ? `从 ${formatClock(initialStart)} 播放视频`
      : '播放视频',
  }, el('span'));
  const hitbox = el('button', {
    class: 'player-hitbox',
    type: 'button',
    hidden: true,
    'aria-label': '播放或暂停视频',
    on: { click: () => togglePlayback() },
  });

  let startAt = initialStart;
  let resumePill = null;
  if (startAt >= 5) {
    const resumeText = el('span', { class: 'resume-text' },
      isSavedResume ? `上次看到 ${formatClock(startAt)}` : `定点播放 ${formatClock(startAt)}`,
    );
    const restartBtn = el('button', {
      class: 'resume-restart',
      type: 'button',
      title: '从 0:00 重新开始播放',
      on: {
        click: (event) => {
          event.stopPropagation();
          startAt = 0;
          store.clearProgress(video.vid);
          resumePill?.remove();
          mount(0);
        },
      },
    }, '从头播放');
    resumePill = el('div', { class: 'player-resume' }, resumeText, restartBtn);
  }

  let yt = null;
  let timer = null;
  let mounting = null;
  let destroyed = false;
  let fallbackFrame = null;
  let onFallback = null;
  let onTimeUpdate = null;
  let onEnded = null;
  let onPlaying = null;
  let onPlaybackStateChange = null;
  let onVolumeChange = null;
  let playbackState = -1;
  let hudMode = ['auto', 'veil', 'off'].includes(store.get('hud_mode', 'auto'))
    ? store.get('hud_mode', 'auto')
    : 'auto';
  let hudVeilEnabled = store.get('hud_veil', true) === true;
  let hudBlockerEnabled = store.get('hud_blocker_enabled', true) === true;
  let hudBlocked = false;
  let unveilTimer = 0;
  const veilNum = (key, fallback) => {
    const value = Number(store.get(key, fallback));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const unveilHoldMs = veilNum('veilHold', 4200);
  const unveilFadeMs = veilNum('veilFade', 1000);
  const useHudBlocker = () => hudMode === 'auto' && hudBlockerEnabled;
  const useHudVeil = () => hudMode === 'veil' || (hudMode === 'auto' && hudVeilEnabled);
  player.classList.toggle('veil-disabled', !useHudVeil());
  const setVeiled = (on) => {
    clearTimeout(unveilTimer);
    veil.style.transitionDuration = '';
    player.classList.toggle('is-veiled', Boolean(on));
  };
  const unveilSoon = () => {
    if (hudBlocked) {
      setVeiled(false);
      return;
    }
    clearTimeout(unveilTimer);
    unveilTimer = setTimeout(() => {
      veil.style.transitionDuration = `${unveilFadeMs}ms`;
      player.classList.remove('is-veiled');
    }, unveilHoldMs);
  };
  const postToHudBlocker = (payload) => {
    const frame = yt?.getIframe?.();
    if (!frame?.contentWindow) return false;
    try {
      const targetOrigin = new URL(frame.src, location.href).origin;
      if (!YT_MESSAGE_ORIGINS.has(targetOrigin)) return false;
      frame.contentWindow.postMessage(payload, targetOrigin);
      return true;
    } catch {
      return false;
    }
  };
  const syncHudBlocker = () => postToHudBlocker({
    source: 'ht-hud-blocker-control',
    type: 'set-enabled',
    enabled: useHudBlocker(),
  });
  const syncHudPreferences = () => {
    player.classList.toggle('veil-disabled', !useHudVeil());
    if (!useHudBlocker()) {
      hudBlocked = false;
      player.classList.remove('hud-blocked');
    }
    syncHudBlocker();
    setVeiled(playbackState !== 1);
  };
  const onHudBlockerMessage = (event) => {
    const data = event.data;
    if (!data || data.source !== 'ht-hud-blocker') return;
    if (!YT_MESSAGE_ORIGINS.has(event.origin) || !yt) return;
    const frame = yt.getIframe?.();
    if (!frame || event.source !== frame.contentWindow) return;
    hudBlocked = data.active === true && useHudBlocker();
    player.classList.toggle('hud-blocked', hudBlocked);
    setVeiled(playbackState !== 1);
    emitBlockerState({
      active: hudBlocked,
      installed: true,
      version: data.version,
    });
  };
  const onPlayerSettingsChange = (event) => {
    const { key, value, origin } = event.detail || {};
    if (origin !== 'settings') return;
    if (key === 'hud_veil') hudVeilEnabled = value === true;
    else if (key === 'hud_blocker_enabled') hudBlockerEnabled = value === true;
    else if (key === 'hud_mode' && ['auto', 'veil', 'off'].includes(value)) hudMode = value;
    else return;
    syncHudPreferences();
  };
  window.addEventListener('message', onHudBlockerMessage);
  window.addEventListener(SETTINGS_EVENT, onPlayerSettingsChange);
  const savedVolume = Number(store.get('volume', 80));
  let volume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(100, savedVolume)) : 80;
  let muted = store.get('muted', false) === true;
  let lastKnownTime = startAt || 0;
  let lastKnownDuration = 0;
  let rate = normalizeRate(store.get('speed', 1));
  let onRateChange = null;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function doMount(customStart = startAt) {
    const beginSec = Math.max(0, Math.floor(customStart || 0));
    poster.remove();
    resumePill?.remove();
    player.prepend(host);
    player.append(hitbox);
    hitbox.hidden = false;
    player.classList.add('is-mounted');
    setVeiled(true);
    play.tabIndex = -1;
    try {
      const YT = await loadYouTubeApi();
      if (destroyed) return null;
      const playerVars = {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
        iv_load_policy: 3,
      };
      if (beginSec > 0) playerVars.start = beginSec;
      yt = new YT.Player(host, {
        videoId: video.vid,
        host: 'https://www.youtube-nocookie.com',
        playerVars,
        events: {
          onReady: () => {
            readyResolve();
            if (destroyed) {
              yt?.destroy?.();
              yt = null;
              return;
            }
            if (yt.getIframe?.()) yt.getIframe().tabIndex = -1;
            syncHudBlocker();
            yt.unloadModule?.('captions');
            yt.unloadModule?.('cc');
            yt.setVolume?.(volume);
            if (muted) yt.mute?.();
            else yt.unMute?.();
            onVolumeChange?.(volume, muted);
            if (beginSec > 0) yt.seekTo?.(beginSec, true);
            yt.setPlaybackRate?.(rate);
            yt.playVideo?.();
          },
          onStateChange: (event) => {
            playbackState = event.data;
            if (event.data === 1) {
              yt?.unloadModule?.('captions');
              yt?.unloadModule?.('cc');
              unveilSoon();
            } else setVeiled(true);
            onPlaybackStateChange?.(playbackState);
            if (event.data === 0) {
              overlay.clear();
              if (lastKnownDuration > 0) {
                onTimeUpdate?.(lastKnownDuration, lastKnownDuration, true);
              }
              onEnded?.();
            } else if (event.data === 1) {
              onPlaying?.();
            } else if (event.data === 2) {
              tick(true);
            }
          },
        },
      });
      timer = setInterval(() => tick(false), 250);
    } catch {
      if (destroyed) return null;
      emitBlockerState({ active: false, installed: false, version: null });
      const startParam = beginSec > 0 ? `&start=${beginSec}` : '';
      fallbackFrame = el('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${video.vid}?autoplay=1&controls=1&rel=0${startParam}`,
        title: video.title_zh || video.title,
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share',
        allowFullscreen: true,
      });
      host.remove();
      hitbox.remove();
      overlay.layer.remove();
      player.classList.add('is-fallback');
      setVeiled(false);
      player.prepend(fallbackFrame);
      readyResolve();
      onFallback?.();
      return null;
    }
    return yt;
  }

  function mount(customStart = startAt) {
    if (yt) return Promise.resolve(yt);
    if (!mounting) mounting = doMount(customStart);
    return mounting;
  }

  function togglePlayback() {
    if (!yt) {
      if (!fallbackFrame) mount(startAt);
      return;
    }
    const state = yt.getPlayerState?.() ?? playbackState;
    if (state === 1) yt.pauseVideo?.();
    else yt.playVideo?.();
  }

  function setVolume(next) {
    const value = Number(next);
    if (!Number.isFinite(value)) return;
    volume = Math.max(0, Math.min(100, value));
    muted = volume === 0;
    store.set('volume', volume);
    store.set('muted', muted);
    yt?.setVolume?.(volume);
    if (muted) yt?.mute?.();
    else yt?.unMute?.();
    onVolumeChange?.(volume, muted);
  }

  function toggleMute() {
    if (muted) {
      setVolume(volume || 80);
      return;
    }
    muted = true;
    store.set('muted', true);
    yt?.mute?.();
    onVolumeChange?.(volume, true);
  }

  function currentTime() {
    if (yt && typeof yt.getCurrentTime === 'function') {
      const t = yt.getCurrentTime();
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    }
    return Math.floor(lastKnownTime || 0);
  }

  function doSeek(seconds) {
    startAt = seconds;
    lastKnownTime = seconds;
    onTimeUpdate?.(seconds, lastKnownDuration, true);
    mount(seconds).then(() => ready).then(() => {
      if (yt) {
        yt.seekTo(seconds, true);
        yt.playVideo?.();
      } else if (fallbackFrame) {
        fallbackFrame.src = `https://www.youtube-nocookie.com/embed/${video.vid}`
          + `?autoplay=1&controls=1&rel=0&start=${Math.floor(seconds)}`;
      }
    });
  }

  let playerCues = [];
  let skipSilence = store.get('skip_silence', false) === true;
  let lastSilenceJumpAt = 0;

  function checkAndSkipSilence(curSec) {
    if (!skipSilence || playerCues.length < 5) return false;
    const now = Date.now();
    if (now - lastSilenceJumpAt < 1800) return false;

    // Check if curSec is inside a long silent gap (>= 4.5s) between cues
    let nextCueStart = -1;
    let gapLen = 0;
    if (curSec >= 1.5 && curSec < playerCues[0].s - 1.2 && playerCues[0].s >= 5) {
      nextCueStart = playerCues[0].s;
      gapLen = playerCues[0].s;
    } else {
      let lo = 0;
      let hi = playerCues.length - 1;
      let afterIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (playerCues[mid].s <= curSec) {
          afterIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (afterIdx >= 0 && afterIdx + 1 < playerCues.length) {
        const curCueEnd = playerCues[afterIdx].e || (playerCues[afterIdx].s + 2.5);
        const nextCue = playerCues[afterIdx + 1];
        if (curSec >= curCueEnd + 0.35 && nextCue.s - curCueEnd >= 4.5 && nextCue.s - curSec >= 2.2) {
          nextCueStart = nextCue.s;
          gapLen = nextCue.s - curSec;
        }
      }
    }

    if (nextCueStart > 0 && gapLen >= 2.2) {
      const targetSec = Math.max(curSec + 1, nextCueStart - 0.3);
      lastSilenceJumpAt = now;
      yt?.seekTo?.(targetSec, true);
      lastKnownTime = targetSec;
      toast(`⚡ 已跳过 ${Math.round(targetSec - curSec)} 秒空白片段`);
      return true;
    }
    return false;
  }

  function applyRate(next) {
    rate = next;
    if (rememberPlayback()) store.set('speed', next);
    yt?.setPlaybackRate?.(next);
    onRateChange?.(rate);
  }

  function tick(force = false) {
    if (!yt || typeof yt.getCurrentTime !== 'function') return;
    const state = yt.getPlayerState?.();
    if (!force && state !== 1 && state !== 2) return;
    const currentTime = yt.getCurrentTime();
    const duration = typeof yt.getDuration === 'function' ? yt.getDuration() : 0;
    if (Number.isFinite(currentTime) && currentTime > 0) lastKnownTime = currentTime;
    if (Number.isFinite(duration) && duration > 0) lastKnownDuration = duration;
    if (!force && state === 1 && checkAndSkipSilence(currentTime)) return;
    overlay.update(currentTime);
    onTimeUpdate?.(currentTime, lastKnownDuration, force);
  }

  play.addEventListener('click', () => {
    if (!yt && !mounting) mount(startAt);
    else togglePlayback();
  });
  player.addEventListener('click', (event) => {
    if (event.target === player) togglePlayback();
  });
  player.append(poster, veil, play, resumePill, overlay.layer);
  if (autoMount) mount(startAt);

  return {
    node: player,
    setCues: (nextCues) => {
      playerCues = Array.isArray(nextCues) ? nextCues : [];
      overlay.setCues(playerCues);
    },
    setEnabled: (on) => overlay.setEnabled(on),
    setBilingual: (on) => overlay.setBilingual(on),
    setSubMode: (mode) => overlay.setMode(mode),
    getSubMode: () => overlay.getMode(),
    setSkipSilence(on) {
      skipSilence = Boolean(on);
      if (rememberPlayback()) store.set('skip_silence', skipSilence);
    },
    getSkipSilence: () => skipSilence,
    set onFallback(fn) { onFallback = fn; },
    set onTimeUpdate(fn) { onTimeUpdate = fn; },
    set onEnded(fn) { onEnded = fn; },
    set onPlaying(fn) { onPlaying = fn; },
    set onPlaybackStateChange(fn) { onPlaybackStateChange = fn; },
    set onVolumeChange(fn) { onVolumeChange = fn; },
    set onRateChange(fn) { onRateChange = fn; },
    togglePlayback,
    setVolume,
    toggleMute,
    getVolume: () => volume,
    isMuted: () => muted,
    getCurrentTime() {
      return currentTime();
    },
    seekBy(delta) {
      doSeek(Math.max(0, currentTime() + delta));
    },
    seek(seconds) {
      doSeek(seconds);
    },
    getPlaybackRate() {
      return rate;
    },
    setPlaybackRate(value) {
      const next = normalizeRate(value);
      if (next !== rate) applyRate(next);
      return rate;
    },
    isMounted: () => Boolean(yt || mounting),
    cyclePlaybackRate(dir) {
      const idx = RATE_STEPS.indexOf(rate);
      const next = RATE_STEPS[
        (idx + (dir > 0 ? 1 : -1) + RATE_STEPS.length) % RATE_STEPS.length
      ];
      applyRate(next);
      return rate;
    },
    setSubSize: (size) => overlay.setSize(size),
    getSubSize: () => overlay.getSize(),
    stepSubScale: (delta) => overlay.stepScale(delta),
    getSubScale: () => overlay.getScale(),
    cycleSubAlpha: () => overlay.cycleAlpha(),
    setSubAlpha: (value) => overlay.setAlpha(value),
    getSubAlpha: () => overlay.getAlpha(),
    set onSubBoxChange(fn) { overlay.onChange = fn; },
    destroy() {
      tick(true);
      destroyed = true;
      clearInterval(timer);
      emitBlockerState({ active: false, installed: false, version: null });
      window.removeEventListener('message', onHudBlockerMessage);
      window.removeEventListener(SETTINGS_EVENT, onPlayerSettingsChange);
      overlay.destroy();
      yt?.destroy?.();
      yt = null;
    },
  };
}

const SUBTITLE_MODES = ['off', 'zh', 'both', 'en'];
const SUBTITLE_LABELS = { off: '关闭', zh: '中文', both: '中英双语', en: '英文' };

function buildSubtitleButton(player) {
  let mode = store.get('subs_mode', null);
  if (!SUBTITLE_MODES.includes(mode)) {
    mode = store.get('subs', true) ? 'zh' : 'off';
  }
  const button = el('button', {
    class: 'hud-btn hud-icon-btn' + (mode !== 'off' ? ' is-on' : ''),
    type: 'button',
    hidden: true,
    'aria-label': '字幕',
    'aria-pressed': mode === 'off' ? 'false' : 'true',
  }, hudIcon('cc'));

  const apply = () => {
    player.setSubMode(mode);
    button.classList.toggle('is-on', mode !== 'off');
    button.setAttribute('aria-pressed', mode === 'off' ? 'false' : 'true');
    button.title = `切换字幕模式（当前：${SUBTITLE_LABELS[mode]}，快捷键 C）`;
  };
  const setMode = (nextMode) => {
    if (!SUBTITLE_MODES.includes(nextMode) || nextMode === mode) return false;
    mode = nextMode;
    if (rememberPlayback()) store.set('subs_mode', mode);
    apply();
    return true;
  };
  apply();

  button.addEventListener('click', () => {
    const nextMode = SUBTITLE_MODES[(SUBTITLE_MODES.indexOf(mode) + 1) % SUBTITLE_MODES.length];
    if (setMode(nextMode)) emitSettingsChanged('subs_mode', nextMode, 'hud');
    toast(`字幕：${SUBTITLE_LABELS[mode]}`);
  });
  return Object.assign(button, { setMode });
}

function buildSkipSilenceButton(player) {
  let on = player.getSkipSilence();
  const button = el('button', {
    class: 'hud-btn hud-icon-btn' + (on ? ' is-on' : ''),
    type: 'button',
    hidden: true,
    title: '自动跳过 ≥4.5 秒无台词空白段（快捷键 X）',
    'aria-label': '跳过空白',
    'aria-pressed': on ? 'true' : 'false',
  }, hudIcon('fastFwd'));
  const setOn = (next) => {
    const enabled = Boolean(next);
    if (enabled === on) return false;
    on = enabled;
    player.setSkipSilence(on);
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    return true;
  };
  button.addEventListener('click', () => {
    if (setOn(!on)) emitSettingsChanged('skip_silence', on, 'hud');
    toast(on ? '⚡ 智能跳过空白已开启：自动略过长停顿片段' : '智能跳过空白已关闭');
  });
  return Object.assign(button, { setOn });
}

function buildTheaterButton() {
  return el('button', {
    class: 'hud-btn hud-icon-btn theater-btn',
    type: 'button',
    title: '切换宽屏（快捷键 W）',
    'aria-label': '宽屏',
    'aria-pressed': 'false',
  }, hudIcon('theater'));
}

function buildAutoplayButton() {
  let on = store.get('autoplay', false) === true;
  const button = el('button', {
    class: 'hud-btn hud-icon-btn autoplay-btn' + (on ? ' is-on' : ''),
    type: 'button',
    title: '连播：播放完自动播放下一个推荐视频（快捷键 A）',
    'aria-label': '连播',
    'aria-pressed': on ? 'true' : 'false',
  }, hudIcon('loop'));
  const setOn = (next) => {
    const enabled = Boolean(next);
    if (enabled === on) return false;
    on = enabled;
    if (rememberPlayback()) store.set('autoplay', on);
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    return true;
  };
  button.addEventListener('click', () => {
    if (setOn(!on)) emitSettingsChanged('autoplay', on, 'hud');
    toast(on ? '连播已开：播完自动播放下一个推荐' : '连播已关');
  });
  return Object.assign(button, { setOn, getOn: () => on });
}

function buildFullscreenButton(player) {
  const button = el('button', {
    class: 'hud-btn hud-icon-btn',
    type: 'button',
    title: '全屏播放（快捷键 F）',
    'aria-label': '全屏',
  }, hudIcon('fullscreen'));
  if (!document.fullscreenEnabled) button.hidden = true;
  button.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else player.node.requestFullscreen?.();
  });
  return button;
}

function buildRateButton(player) {
  const button = el('button', {
    class: 'hud-btn hud-text-btn rate-btn',
    type: 'button',
    title: '切换播放倍速（快捷键 [ / ]）',
  }, formatRate(player.getPlaybackRate()));
  button.addEventListener('click', () => {
    const value = player.cyclePlaybackRate(1);
    emitSettingsChanged('speed', value, 'hud');
    toast(`播放速度：${formatRate(value)}`);
  });
  return button;
}

function buildPlaybackControls(player) {
  let scrubbing = false;
  const playBtn = el('button', {
    class: 'hud-btn hud-icon-btn hud-play-btn',
    type: 'button',
    title: '播放 / 暂停（空格或 K）',
    'aria-label': '播放',
  }, hudIcon('play'));
  const muteBtn = el('button', {
    class: 'hud-btn hud-icon-btn hud-mute-btn',
    type: 'button',
    title: '静音 / 恢复声音（M）',
    'aria-label': '静音',
  }, hudIcon('volHigh'));
  const volumeInput = el('input', {
    class: 'volume-slider',
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: String(player.getVolume()),
    'aria-label': '音量',
  });
  const volumeGroup = el('div', { class: 'hud-volume' }, muteBtn, volumeInput);
  const currentEl = el('span', { class: 'player-time-current' }, '0:00');
  const durationEl = el('span', { class: 'player-time-duration' }, '0:00');
  const timeEl = el('span', { class: 'player-time' }, currentEl, ' / ', durationEl);
  const progress = el('input', {
    class: 'player-progress',
    type: 'range',
    min: '0',
    max: '1',
    step: '1',
    value: '0',
    disabled: true,
    'aria-label': '播放进度',
  });
  const mainRow = el('div', { class: 'player-hud-main' },
    el('div', { class: 'hud-group playback-group' }, playBtn, volumeGroup, timeEl),
  );
  const node = el('div', { class: 'player-playback' }, progress, mainRow);

  playBtn.addEventListener('click', () => player.togglePlayback());
  muteBtn.addEventListener('click', () => player.toggleMute());
  volumeInput.addEventListener('input', () => player.setVolume(volumeInput.value));
  progress.addEventListener('pointerdown', () => { scrubbing = true; });
  progress.addEventListener('input', () => {
    scrubbing = true;
    currentEl.textContent = formatClock(progress.value);
  });
  progress.addEventListener('change', () => {
    player.seek(Number(progress.value));
    scrubbing = false;
  });

  player.onPlaybackStateChange = (state) => {
    const playing = state === 1 || state === 3;
    setHudIcon(playBtn, playing ? 'pause' : 'play');
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    playBtn.title = playing ? '暂停（空格或 K）' : '播放（空格或 K）';
  };
  const syncVolume = (value, muted) => {
    volumeInput.value = String(value);
    volumeInput.setAttribute('aria-valuetext', `${Math.round(value)}%`);
    setHudIcon(muteBtn, muted || value === 0 ? 'volMute' : value < 50 ? 'volLow' : 'volHigh');
    muteBtn.setAttribute('aria-pressed', muted || value === 0 ? 'true' : 'false');
  };
  player.onVolumeChange = syncVolume;
  syncVolume(player.getVolume(), player.isMuted());

  return {
    node,
    mainRow,
    update(time, duration) {
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
      progress.disabled = safeDuration <= 0;
      progress.max = String(Math.max(1, Math.floor(safeDuration)));
      if (!scrubbing) {
        progress.value = String(Math.min(safeTime, safeDuration));
        currentEl.textContent = formatClock(safeTime);
      }
      durationEl.textContent = formatClock(safeDuration);
      const percent = safeDuration ? Math.min(100, (Number(progress.value) / safeDuration) * 100) : 0;
      progress.style.setProperty('--progress', `${percent}%`);
      progress.setAttribute('aria-valuetext', `${formatClock(progress.value)} / ${formatClock(safeDuration)}`);
    },
  };
}

/** 底部统一控制栏（单行图形化）；透明交互层让指针事件不再被 YouTube iframe 吞掉。 */
function buildPlayerHud(playerNode, playbackControls, featureBtns = []) {
  playbackControls.mainRow.append(
    el('div', { class: 'hud-group hud-group-right' }, ...featureBtns),
  );
  const bar = el('div', {
    class: 'player-hud',
    role: 'toolbar',
    'aria-label': '播放器控制栏',
  },
    playbackControls.node,
  );
  const wrap = el('div', { class: 'player-hud-wrap' }, bar);

  let wakeTimer = null;
  let hideDelay = Number(store.get('hud_hide_ms', 3000));
  if (![1800, 3000, 5000].includes(hideDelay)) hideDelay = 3000;
  // 字幕胶囊现在位于 HUD 之上（z-index）；指针在字幕上或字幕正被拖动时，
  // 控制栏立即收起，避免挡住字幕的抓取/拖拽。
  const overSubtitle = (target) => Boolean(target?.closest?.('.sub-line'));
  const subtitleBusy = () => Boolean(
    playerNode.querySelector('.sub-line.is-interacting, .sub-line.is-dragging'),
  );
  const hideNow = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    playerNode.classList.remove('is-hud-awake');
  };
  const scheduleHide = (delayMs) => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      if (!bar.matches(':hover')) {
        playerNode.classList.remove('is-hud-awake');
      }
    }, delayMs);
  };
  const wake = (delayMs = hideDelay) => {
    if (subtitleBusy()) return;
    playerNode.classList.add('is-hud-awake');
    scheduleHide(delayMs);
  };

  playerNode.addEventListener('pointerenter', (event) => {
    if (overSubtitle(event.target)) hideNow();
    else wake();
  });
  playerNode.addEventListener('pointermove', (event) => {
    if (overSubtitle(event.target) || subtitleBusy()) {
      hideNow();
      return;
    }
    wake();
  });
  playerNode.addEventListener('pointerdown', (event) => {
    if (overSubtitle(event.target) || subtitleBusy()) return;
    wake();
  });
  playerNode.addEventListener('pointerleave', () => scheduleHide(240));
  playerNode.addEventListener('touchstart', (event) => {
    if (overSubtitle(event.target) || subtitleBusy()) return;
    wake();
  }, { passive: true });
  bar.addEventListener('pointerenter', () => {
    playerNode.classList.add('is-hud-awake');
    if (wakeTimer) clearTimeout(wakeTimer);
  });
  bar.addEventListener('pointerdown', () => {
    if (wakeTimer) clearTimeout(wakeTimer);
  });
  bar.addEventListener('pointerleave', () => scheduleHide(300));
  wake(1800);

  return {
    node: wrap,
    wake,
    setHideDelay(value) {
      if ([1800, 3000, 5000].includes(value)) hideDelay = value;
    },
    destroy() {
      if (wakeTimer) clearTimeout(wakeTimer);
    },
  };
}

/** ? 键快捷键速查浮层。 */
function buildKbdHelp() {
  const rows = [
    ['/', '聚焦全局搜索框'],
    ['G', '聚焦视频内字幕搜索（Enter 下一个 / Shift+Enter 上一个）'],
    ['S', '收藏当前视频'],
    ['C', '切换字幕模式（关 / 中 / 中英 / 英）'],
    ['X', '开启 / 关闭智能跳过空白片段'],
    ['T', '切换右侧面板（字幕流 / 随手记 / 接下来）'],
    ['B', '打开伴读随手记工作台 / 添加时间点书签'],
    ['F', '全屏播放'],
    ['W', '宽屏模式'],
    ['A', '连播开关'],
    ['空格 / K', '播放 / 暂停'],
    ['M', '静音 / 恢复声音'],
    ['← / →', '快退 / 快进 5 秒'],
    ['J / L', '快退 / 快进 10 秒'],
    ['[ / ]', '降低 / 提高播放速度（含 1.35x 黄金倍速）'],
    ['?', '打开或关闭本速查面板'],
    ['Esc', '关闭面板 / 清空搜索'],
  ];
  const panel = el('div', {
    class: 'kbd-panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '键盘快捷键',
  },
    el('h2', { class: 'kbd-title' }, '键盘快捷键'),
    el('dl', { class: 'kbd-list' },
      ...rows.map(([keys, desc]) => el('div', { class: 'kbd-row' },
        el('dt', {}, el('kbd', { class: 'kbd-key' }, keys)),
        el('dd', {}, desc),
      ))),
    el('p', { class: 'kbd-hint' }, '按 Esc 或点击空白处关闭'),
  );
  const overlay = el('div', { class: 'kbd-overlay', hidden: true }, panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      overlay.hidden = true;
    }
  });
  return {
    node: overlay,
    toggle(triggerEl = null) {
      overlay.hidden = !overlay.hidden;
      if (!overlay.hidden) {
        panel.focus?.() || panel.querySelector('button, [tabindex="0"]')?.focus();
      } else if (triggerEl) {
        triggerEl.focus?.();
      }
    },
    close(triggerEl = null) {
      overlay.hidden = true;
      if (triggerEl) triggerEl.focus?.();
    },
  };
}

/** 随手记编辑浮层：预填当前时间点与对应字幕句。 */
function buildNoteEditor({ getTime, getCueText, onSave }) {
  const tsEl = el('span', { class: 'note-editor-ts' }, '');
  const cueEl = el('p', { class: 'note-editor-cue' }, '');
  const input = el('input', {
    class: 'note-input',
    type: 'text',
    placeholder: '记一句备注（可留空，仅书签也可以）',
    maxlength: 200,
    'aria-label': '笔记内容',
  });
  const saveBtn = el('button', { class: 'btn', type: 'button' }, '保存');
  const cancelBtn = el('button', { class: 'btn', type: 'button' }, '取消');
  const panel = el('div', {
    class: 'kbd-panel note-editor-panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '随手记',
  },
    el('h2', { class: 'kbd-title' }, '随手记'),
    el('p', { class: 'note-editor-row' }, '时间点：', tsEl),
    cueEl,
    input,
    el('div', { class: 'note-editor-actions' }, saveBtn, cancelBtn),
  );
  const overlay = el('div', { class: 'kbd-overlay', hidden: true }, panel);
  let pending = null;

  function close() {
    overlay.hidden = true;
    pending = null;
    notesBtn.focus?.();
  }

  function save() {
    if (!pending) return;
    onSave(pending.t, input.value, getCueText(pending.t));
    close();
  }

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });

  return {
    node: overlay,
    open() {
      const t = Math.max(0, Math.floor(getTime() || 0));
      pending = { t };
      tsEl.textContent = formatClock(t);
      const cueText = getCueText(t);
      cueEl.textContent = cueText ? `“${cueText}”` : '（当前位置没有对应字幕句）';
      input.value = '';
      overlay.hidden = false;
      setTimeout(() => input.focus(), 0);
    },
    close,
  };
}

/** 「我的笔记与书签」折叠卡片：时间戳跳转、编辑、删除、复制 Markdown。 */
function buildNotesCard({ video, onSeek, onChanged }) {
  const countEl = el('span', { class: 'notes-count' }, '');
  const copyBtn = el('button', {
    class: 'desc-toggle notes-copy',
    type: 'button',
    title: '复制为 Markdown 笔记',
  }, '复制 Markdown');
  const head = el('div', {
    class: 'notes-head',
    role: 'button',
    tabindex: '0',
    'aria-expanded': 'false',
    title: '展开 / 收起笔记列表',
  },
    el('span', { class: 'notes-caret', 'aria-hidden': 'true' }, '▸'),
    el('h2', { class: 'notes-title' }, '我的笔记与书签'),
    countEl,
    copyBtn,
  );
  const listEl = el('div', { class: 'notes-list' });
  const node = el('section', { class: 'notes-card', hidden: true }, head, listEl);

  let open = false;
  const setOpen = (next) => {
    open = next;
    node.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    setOpen(!open);
  });
  head.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(!open);
    }
  });
  copyBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    copyMarkdown();
  });

  function noteRow(note) {
    const tsBtn = el('button', {
      class: 'note-ts-btn',
      type: 'button',
      title: '跳到该时间点',
    }, formatClock(note.t));
    tsBtn.addEventListener('click', () => onSeek(note.t));

    const body = el('div', { class: 'note-body' },
      el('p', { class: 'note-text' }, note.text || note.cue || '（未填写内容）'),
      note.text && note.cue ? el('p', { class: 'note-cue-line' }, note.cue) : null,
    );

    const delBtn = el('button', { class: 'note-act', type: 'button' }, '删除');
    const editBtn = el('button', { class: 'note-act', type: 'button' }, '编辑');
    delBtn.addEventListener('click', () => {
      store.removeNote(video.vid, note.id);
      toast('已删除随手记');
      onChanged?.();
    });
    editBtn.addEventListener('click', () => {
      const input = el('input', {
        class: 'note-input note-inline-input',
        type: 'text',
        value: note.text || '',
        maxlength: 200,
        'aria-label': '编辑笔记内容',
      });
      body.replaceChildren(input);
      input.focus();
      input.select();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        store.updateNote(video.vid, note.id, input.value);
        onChanged?.();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          done = true;
          onChanged?.();
        }
      });
      input.addEventListener('blur', commit);
    });

    return el('div', { class: 'note-item' }, tsBtn, body, el('div', { class: 'note-item-actions' }, editBtn, delBtn));
  }

  async function copyMarkdown() {
    const notes = store.getNotes(video.vid);
    if (!notes.length) return;
    const base = `${location.origin}${location.pathname}#/video/${video.vid}`;
    const lines = notes.map((note) => {
      const text = (note.text || note.cue || '').trim();
      return `- [\`${formatClock(note.t)}\`](${base}?t=${note.t}) ${text}`;
    });
    const md = `# ${video.title_zh || video.title}\n\n${lines.join('\n')}\n`;
    try {
      await navigator.clipboard.writeText(md);
      toast(`已复制 ${notes.length} 条笔记为 Markdown`);
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  }

  function render() {
    const notes = store.getNotes(video.vid);
    if (!notes.length) {
      node.hidden = true;
      listEl.replaceChildren();
      return;
    }
    node.hidden = false;
    countEl.textContent = `${notes.length} 条`;
    listEl.replaceChildren(...notes.map(noteRow));
  }

  setOpen(false);
  render();

  return { node, render };
}

/** 右侧分栏「伴读随手记工作台」：边看边记、不遮挡视频画面、支持 Alt+T 时间戳与一键摘录当前台词。 */
function buildRailNotesPanel({ video, getTime, getCueText, onSeek, onChanged }) {
  let capturedSec = null;
  const tsBadge = el('span', { class: 'rail-notes-ts-badge' }, '0:00');
  const cuePreview = el('p', { class: 'rail-notes-cue-preview muted', hidden: true }, '');
  const textarea = el('textarea', {
    class: 'rail-notes-textarea',
    rows: '3',
    maxlength: '400',
    placeholder: '边看边记…（按 Enter 保存，Shift+Enter 换行，Alt+T 插入当前时间戳）',
    'aria-label': '伴读随手记输入框',
  });

  const refreshCapture = (forceNow = false) => {
    if (forceNow || capturedSec === null) {
      capturedSec = Math.max(0, Math.floor(getTime() || 0));
    }
    tsBadge.textContent = `⏱ ${formatClock(capturedSec)}`;
    const cue = getCueText(capturedSec);
    if (cue) {
      cuePreview.textContent = `❝ ${cue}`;
      cuePreview.hidden = false;
    } else {
      cuePreview.textContent = '';
      cuePreview.hidden = true;
    }
  };

  textarea.addEventListener('focus', () => {
    refreshCapture(true);
  });

  const insertTsBtn = el('button', {
    class: 'rail-notes-tool-btn',
    type: 'button',
    title: '在光标处插入当前播放时间戳 (Alt+T)',
    on: {
      click: () => {
        const t = Math.max(0, Math.floor(getTime() || 0));
        capturedSec = t;
        refreshCapture(false);
        const stampStr = `[${formatClock(t)}] `;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + stampStr + textarea.value.slice(end);
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + stampStr.length;
      },
    },
  }, '⏱ 插入时间点');

  const quoteCueBtn = el('button', {
    class: 'rail-notes-tool-btn',
    type: 'button',
    title: '将当前正在播放的字幕台词摘录到输入框',
    on: {
      click: () => {
        const t = Math.max(0, Math.floor(getTime() || 0));
        capturedSec = t;
        refreshCapture(false);
        const cue = getCueText(t);
        if (!cue) {
          toast('当前时间点暂无字幕台词');
          return;
        }
        const quote = `“${cue}” `;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + quote + textarea.value.slice(end);
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + quote.length;
      },
    },
  }, '❝ 摘录当前台词');

  const submitNote = () => {
    const t = capturedSec !== null ? capturedSec : Math.max(0, Math.floor(getTime() || 0));
    const text = textarea.value.trim();
    const cue = getCueText(t);
    store.addNote(video.vid, { t, text, cueZh: cue });
    textarea.value = '';
    capturedSec = null;
    refreshCapture(true);
    toast(`已记入随手记 · ${formatClock(t)}`);
    onChanged?.();
  };

  const saveBtn = el('button', {
    class: 'rail-notes-save-btn',
    type: 'button',
    title: '保存随手记（可留空仅存为时间点书签）',
    on: { click: submitNote },
  }, '记入笔记');

  textarea.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      insertTsBtn.click();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitNote();
    }
  });

  const composer = el('div', { class: 'rail-notes-composer' },
    el('div', { class: 'rail-notes-composer-head' },
      tsBadge,
      el('div', { class: 'rail-notes-tools' }, insertTsBtn, quoteCueBtn),
    ),
    cuePreview,
    textarea,
    el('div', { class: 'rail-notes-composer-foot' },
      el('span', { class: 'muted', style: { fontSize: '11.5px' } }, 'Enter 保存 · Alt+T 插入时间点'),
      saveBtn,
    ),
  );

  const listEl = el('div', { class: 'rail-notes-list' });

  const buildMarkdown = () => {
    const notes = store.getNotes(video.vid);
    if (!notes.length) return '';
    const base = `${location.origin}${location.pathname}#/video/${video.vid}`;
    const lines = notes.map((note) => {
      const mainText = (note.text || note.cue || '').trim();
      const subQuote = note.text && note.cue ? `\n  > ${note.cue}` : '';
      return `- [\`${formatClock(note.t)}\`](${base}?t=${note.t}) ${mainText}${subQuote}`;
    });
    return `# ${video.title_zh || video.title}\n\n${lines.join('\n')}\n`;
  };

  const copyMdBtn = el('button', {
    class: 'transcript-copy',
    type: 'button',
    title: '复制全部随手记为 Markdown 格式',
    on: {
      click: async () => {
        const md = buildMarkdown();
        if (!md) {
          toast('还没有可导出的随手记');
          return;
        }
        try {
          await navigator.clipboard.writeText(md);
          toast('已复制 Markdown 随手记');
        } catch {
          toast('复制失败，请检查浏览器权限');
        }
      },
    },
  }, '复制 MD');

  const downloadMdBtn = el('button', {
    class: 'transcript-copy',
    type: 'button',
    title: '下载 .md 笔记文件（可直接导入 Obsidian / Notion）',
    on: {
      click: () => {
        const md = buildMarkdown();
        if (!md) {
          toast('还没有可导出的随手记');
          return;
        }
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeTitle = (video.title_zh || video.title || video.vid || 'notes')
          .replace(/[\\/:*?"<>|]+/g, '_')
          .slice(0, 48);
        a.download = `${safeTitle}-笔记.md`;
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast('已下载 .md 笔记文件');
      },
    },
  }, '下载 .md');

  const footerBar = el('div', { class: 'rail-notes-ExportBar', hidden: true },
    el('span', { class: 'muted', style: { fontSize: '12px' } }, '导出到 Obsidian / Notion：'),
    el('div', { class: 'rail-notes-export-btns' }, copyMdBtn, downloadMdBtn),
  );

  const panel = el('div', { class: 'stream-panel rail-notes-panel' },
    composer,
    listEl,
    footerBar,
  );

  function render() {
    const notes = store.getNotes(video.vid);
    footerBar.hidden = notes.length === 0;
    if (!notes.length) {
      listEl.replaceChildren(
        el('div', { class: 'rail-notes-empty muted' },
          el('p', {}, '📌 还没有随手记'),
          el('p', { style: { fontSize: '12px', marginTop: '4px' } }, '你可以在上方直接输入并按 Enter，或在「实时字幕流」中划词 / 点击书签图标快速摘录。'),
        ),
      );
      return;
    }

    listEl.replaceChildren(...notes.map((note) => {
      const tsBtn = el('button', {
        class: 'note-ts-btn',
        type: 'button',
        title: '跳转到该时间点播放',
        on: { click: () => onSeek(note.t) },
      }, formatClock(note.t));

      const body = el('div', { class: 'note-body' },
        el('p', { class: 'note-text' }, note.text || note.cue || '（书签）'),
        note.text && note.cue ? el('p', { class: 'note-cue-line' }, `❝ ${note.cue}`) : null,
      );

      const editBtn = el('button', { class: 'note-act', type: 'button' }, '编辑');
      const delBtn = el('button', { class: 'note-act', type: 'button' }, '删除');

      delBtn.addEventListener('click', () => {
        store.removeNote(video.vid, note.id);
        toast('已删除随手记');
        onChanged?.();
      });

      editBtn.addEventListener('click', () => {
        const input = el('input', {
          class: 'note-input note-inline-input',
          type: 'text',
          value: note.text || '',
          maxlength: 300,
          'aria-label': '编辑随手记',
        });
        body.replaceChildren(input);
        input.focus();
        input.select();
        let done = false;
        const commit = () => {
          if (done) return;
          done = true;
          store.updateNote(video.vid, note.id, input.value);
          onChanged?.();
        };
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commit();
          } else if (ev.key === 'Escape') {
            ev.stopPropagation();
            done = true;
            onChanged?.();
          }
        });
        input.addEventListener('blur', commit);
      });

      return el('div', { class: 'note-item rail-note-item' },
        tsBtn,
        body,
        el('div', { class: 'note-item-actions' }, editBtn, delBtn),
      );
    }));
  }

  render();

  return {
    node: panel,
    render,
    focusComposer(captureNow = true) {
      refreshCapture(captureNow);
      setTimeout(() => textarea.focus(), 0);
    },
  };
}

function buildChannel(video, commentCount, player, extra = []) {
  const saved = store.has('saved', video.vid);
  const saveBtn = el('button', {
    class: 'btn' + (saved ? ' is-on' : ''),
    type: 'button',
    title: '快捷键 S',
    'aria-pressed': saved ? 'true' : 'false',
  }, saved ? '已收藏' : '收藏');

  const toggleSave = () => {
    const on = store.toggle('saved', video.vid);
    saveBtn.classList.toggle('is-on', on);
    saveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    saveBtn.textContent = on ? '已收藏' : '收藏';
    toast(on ? '已收藏' : '已取消收藏');
  };
  saveBtn.addEventListener('click', toggleSave);

  const shareBtn = el('button', {
    class: 'btn',
    type: 'button',
    title: '复制视频链接（播放时自动附带当前时间点）',
  }, '分享');
  shareBtn.addEventListener('click', async () => {
    const currentSec = player.getCurrentTime();
    const baseUrl = `${location.origin}${location.pathname}#/video/${video.vid}`;
    const shareUrl = currentSec >= 5 ? `${baseUrl}?t=${currentSec}` : baseUrl;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast(currentSec >= 5 ? `已复制链接（含时间点 ${formatClock(currentSec)}）` : '链接已复制');
    } catch {
      window.prompt('复制这个链接', shareUrl);
    }
  });

  const watchUrl = `https://www.youtube.com/watch?v=${video.vid}`;
  const meta = [metaLine(video), commentCount ? `${commentCount} 条讨论` : '']
    .filter(Boolean).join(' · ');

  const channelNode = video.channel
    ? el('a', {
      class: 'channel-name channel-link',
      href: `#/feed?channel=${encodeURIComponent(video.channel)}`,
      title: `查看「${video.channel}」的全部视频`,
    }, video.channel)
    : el('p', { class: 'channel-name' }, '未知频道');

  const row = el('div', { class: 'channel-row' },
    avatar(video.channel, 'lg'),
    el('div', {},
      channelNode,
      el('p', { class: 'channel-meta' }, meta),
    ),
    el('div', { class: 'actions' },
      saveBtn,
      shareBtn,
      ...extra,
      el('a', {
        class: 'channel-ext',
        href: watchUrl,
        target: '_blank',
        rel: 'noopener',
        title: '在 YouTube 上打开原视频',
      }, 'YouTube ↗'),
    ),
  );
  return { row, toggleSave };
}

function buildDescription(video, ctx) {
  const summary = video.summary_zh || video.summary || '';
  const why = video.why_zh || video.why_hn || '';
  // feed.json only carries the English originals when they differ from what
  // the Chinese body already shows, so these are the toggle-worthy lines.
  const enSummary = video.summary && video.summary !== summary ? video.summary : '';
  const enWhy = video.why_hn && video.why_hn !== why ? video.why_hn : '';

  const body = el('div', { class: 'desc-body' });
  if (why) {
    body.append(el('p', { class: 'desc-why' },
      el('strong', {}, '为什么 HN 推荐：'), why));
  }
  if (summary) {
    body.append(el('p', {}, summary));
  }

  const enBody = (enWhy || enSummary)
    ? el('div', { class: 'desc-body desc-en', hidden: true },
      enWhy ? el('p', { class: 'desc-why' },
        el('strong', {}, 'Why HN recommends: '), enWhy) : null,
      enSummary ? el('p', {}, enSummary) : null)
    : null;

  const tagNodes = [];
  if (video.has_sub) {
    tagNodes.push(el('a', {
      class: 'mini-chip is-sub',
      href: '#/feed?sub=1',
      title: '查看所有带中文字幕的视频',
    }, '中英字幕'));
  }
  if (video.area && ctx.areaName(video.area)) {
    tagNodes.push(el('a', {
      class: 'mini-chip',
      href: `#/feed?area=${encodeURIComponent(video.area)}`,
    }, ctx.areaName(video.area)));
  }
  if (video.content_type && typeLabel(video.content_type)) {
    tagNodes.push(el('a', {
      class: 'mini-chip',
      href: `#/feed?type=${encodeURIComponent(video.content_type)}`,
    }, typeLabel(video.content_type)));
  }
  const lvlText = levelLabel(video.level, { includeGeneral: true });
  if (video.level && lvlText) {
    tagNodes.push(el('a', {
      class: `mini-chip is-level is-${video.level}`,
      href: `#/feed?level=${encodeURIComponent(video.level)}`,
      title: `按「${lvlText}」难度筛选`,
    }, `难度：${lvlText}`));
  }
  if (video.topic) {
    tagNodes.push(el('a', {
      class: 'mini-chip',
      href: `#/feed?q=${encodeURIComponent(video.topic)}`,
    }, video.topic));
  }
  const seenLower = new Set([String(video.topic || '').toLowerCase()]);
  for (const cat of (video.categories || []).slice(0, 3)) {
    if (!cat || seenLower.has(cat.toLowerCase())) continue;
    seenLower.add(cat.toLowerCase());
    // 带领域跳转到二级分类下钻，比全文搜索更精准。
    const href = video.area
      ? `#/feed?area=${encodeURIComponent(video.area)}&cat=${encodeURIComponent(cat)}`
      : `#/feed?q=${encodeURIComponent(cat)}`;
    tagNodes.push(el('a', {
      class: 'mini-chip',
      href,
    }, cat));
  }

  // 标签减负：默认只显示前 2 个（中英字幕 + 主分类），其余收进「+N」展开。
  let chips = null;
  if (tagNodes.length) {
    const extras = tagNodes.slice(2);
    chips = el('div', { class: 'desc-chips' }, ...tagNodes.slice(0, 2));
    if (extras.length) {
      const more = el('button', {
        class: 'mini-chip mini-chip-more',
        type: 'button',
        'aria-expanded': 'false',
      }, `+${extras.length}`);
      for (const node of extras) node.hidden = true;
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        const expanded = more.getAttribute('aria-expanded') !== 'true';
        more.setAttribute('aria-expanded', String(expanded));
        more.textContent = expanded ? '收起标签' : `+${extras.length}`;
        for (const node of extras) node.hidden = !expanded;
      });
      chips.append(...extras, more);
    }
  }
  const isLong = (why.length + summary.length) > 130 && Boolean(why && summary);

  if (!enBody && !isLong) {
    return el('div', { class: 'description' }, body, chips);
  }

  const actions = el('div', { class: 'desc-actions' });

  if (enBody) {
    const enToggle = el('button', {
      class: 'desc-toggle',
      type: 'button',
      'aria-expanded': 'false',
    }, '查看英文导读');
    enToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      enBody.hidden = !enBody.hidden;
      enToggle.setAttribute('aria-expanded', enBody.hidden ? 'false' : 'true');
      enToggle.textContent = enBody.hidden ? '查看英文导读' : '收起英文导读';
    });
    actions.append(enToggle);
  }

  let description;
  if (isLong) {
    const toggle = el('button', {
      class: 'desc-toggle',
      type: 'button',
      'aria-expanded': 'false',
    }, '展开简介');
    description = el('div', { class: 'description is-collapsed' },
      body, enBody, actions, chips);
    actions.prepend(toggle);

    const setExpanded = (expanded) => {
      description.classList.toggle('is-collapsed', !expanded);
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.textContent = expanded ? '收起' : '展开简介';
    };

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setExpanded(description.classList.contains('is-collapsed'));
    });

    description.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      if (description.classList.contains('is-collapsed')) {
        setExpanded(true);
      }
    });
  } else {
    description = el('div', { class: 'description' }, body, enBody, actions, chips);
  }

  return description;
}

function pickRelated(video, relatedMap, ctx) {
  const seen = new Set([video.vid]);
  const picks = [];

  for (const id of relatedMap[video.vid] || []) {
    if (picks.length >= RELATED_LIMIT) break;
    const item = ctx.feedIndex.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    picks.push(item);
  }

  if (picks.length < RELATED_MIN) {
    const fallback = ctx.feed
      .filter((item) => item.area === video.area && !seen.has(item.vid))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const item of fallback) {
      if (picks.length >= RELATED_LIMIT) break;
      seen.add(item.vid);
      picks.push(item);
    }
  }
  return picks;
}

function relatedItem(video) {
  const thumbNode = thumb(video, { className: 'related-thumb' });
  if (video.has_sub || video.comment_count > 0) {
    const badges = el('div', { class: 'thumb-badges' });
    if (video.has_sub) {
      badges.append(el('span', { class: 'badge badge-sub' }, '中字'));
    }
    if (video.comment_count > 0) {
      badges.append(el('span', { class: 'badge' }, `${video.comment_count} 条讨论`));
    }
    thumbNode.append(badges);
  }
  const prog = thumbProgress(store.getProgress(video.vid));
  if (prog) thumbNode.append(prog);

  const typeText = typeLabel(video.content_type);
  const metaParts = [video.channel, typeText, metaLine(video)].filter(Boolean);
  return el('a', { class: 'related-item', href: `#/video/${video.vid}` },
    thumbNode,
    el('div', {},
      el('p', { class: 'related-title' }, video.title_zh || video.title),
      el('p', { class: 'related-meta' }, metaParts.join(' · ')),
    ),
  );
}

function markVisited(vid) {
  const visited = store.list('visited').filter((id) => id !== vid);
  visited.unshift(vid);
  store.set('visited', visited.slice(0, 500));
}
