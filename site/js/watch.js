import {
  el, avatar, thumb, typeLabel, levelLabel, metaLine, toast, formatClock, thumbProgress,
} from './ui.js';
import { comments as loadComments, load, store, subs as loadSubs, chapters as loadChapters } from './data.js';
import { renderComments } from './comments.js';
import { createOverlay, loadYouTubeApi, renderTranscript, findActiveStreamCue } from './subtitles.js';
import { go } from './router.js';
import { loadSeriesFor, buildSeriesPanel, nextEpisode } from './series.js';
import { createHeatmapBar } from './heatmap.js';

const RELATED_LIMIT = 12;
const RELATED_MIN = 8;
const NEXT_COUNTDOWN_SECONDS = 5;
const RATE_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function normalizeRate(value) {
  return RATE_STEPS.includes(Number(value)) ? Number(value) : 1;
}

function formatRate(rate) {
  return `${rate}x`;
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

  player.onTimeUpdate = (time, duration, force = false) => {
    transcript?.update(time);
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
  const theaterBtn = buildTheaterButton();
  const autoplayBtn = buildAutoplayButton();
  const fullscreenBtn = buildFullscreenButton(player);
  const notesBtn = el('button', {
    class: 'hud-btn',
    type: 'button',
    title: '在当前时间点添加随手记 / 书签（快捷键 B）',
  }, '＋随手记');
  const helpBtn = el('button', {
    class: 'hud-btn hud-btn-kbd',
    type: 'button',
    title: '键盘快捷键速查（快捷键 ?）',
    'aria-label': '键盘快捷键速查',
  }, '?');
  let watchRoot = null;
  const setTheater = (on, announce = false) => {
    watchRoot?.classList.toggle('is-theater', on);
    theaterBtn.classList.toggle('is-on', on);
    theaterBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    theaterBtn.textContent = on ? '标准屏' : '宽屏';
    store.set('theater', on);
    if (announce) toast(on ? '已切换到宽屏' : '已恢复标准布局');
  };
  theaterBtn.addEventListener('click', () => {
    setTheater(!(watchRoot?.classList.contains('is-theater')), true);
  });
  let canSync = true;
  player.onFallback = () => {
    canSync = false;
    subtitleBtn.hidden = true;
  };
  player.onRateChange = (value) => {
    rateBtn.textContent = formatRate(value);
  };

  // ── 随手记 / 时间戳书签 ──
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
  const syncNotesUi = () => {
    const count = store.getNotes(video.vid).length;
    notesBtn.textContent = count ? `＋随手记 (${count})` : '＋随手记';
    notesCard.render();
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
  notesBtn.addEventListener('click', () => noteEditor.open());
  const kbdHelp = buildKbdHelp();
  helpBtn.addEventListener('click', () => kbdHelp.toggle());

  // ── 播放器顶部悬浮 HUD 栏（全屏与普通模式均可见，外层频道栏仅留页面级按钮） ──
  const playerHud = buildPlayerHud(player.node, [
    subtitleBtn,
    rateBtn,
    autoplayBtn,
  ], [
    notesBtn,
    helpBtn,
    theaterBtn,
    fullscreenBtn,
  ]);
  player.node.append(playerHud.node, kbdHelp.node, noteEditor.node);

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

  main = el('div', { class: 'watch-main' }, playerWrap, heatmap.node, title);
  // Poster bleed for the CSS ambient glow around the player.
  main.style.setProperty(
    '--ambient-img',
    `url("https://i.ytimg.com/vi/${video.vid}/hqdefault.jpg")`,
  );
  if (english) main.append(english);
  main.append(channel, description);
  // 我的笔记与书签：折叠卡片放在简介上方，无笔记时自动隐藏。
  main.insertBefore(notesCard.node, description);
  syncNotesUi();

  // AI outline: TL;DR card above the description.
  chaptersPromise.then((data) => {
    if (destroyed) return;
    const chapters = data?.chapters || [];
    if (!chapters.length) return;
    heatmap.setChapters(chapters);
    main.insertBefore(buildOutline(data, seekAndScroll), description);
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
    if (store.get('autoplay', false) !== true || destroyed || nextPanel) return;
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
    const chapterData = await chaptersPromise;
    if (destroyed) return;
    transcript = renderTranscript(cues, seekAndScroll, {
      chapters: chapterData?.chapters || [],
      meta: { vid: video.vid, title: video.title_zh || video.title },
      onNotesChange: syncNotesUi,
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
      streamTabBtn.setAttribute('aria-selected', isStream ? 'true' : 'false');
      relatedTabBtn.setAttribute('aria-selected', isStream ? 'false' : 'true');
      transcript.node.hidden = !isStream;
      railList.hidden = isStream;
      rail.classList.toggle('is-stream-active', isStream);
      if (isStream) transcript.scrollToCurrent();
    };

    streamTabBtn.addEventListener('click', () => setTab('stream'));
    relatedTabBtn.addEventListener('click', () => setTab('related'));
    toggleRailTab = () => setTab(activeTab === 'stream' ? 'related' : 'stream');

    const tabsBar = el('div', { class: 'rail-tabs', role: 'tablist', 'aria-label': '右侧边栏切换' },
      streamTabBtn,
      relatedTabBtn,
    );

    railList.hidden = true;
    rail.classList.add('has-stream', 'is-stream-active');
    rail.replaceChildren(tabsBar, transcript.node, railList);
    if (initialStart > 0) transcript.scrollToCurrent();
  });

  const onFullscreen = () => {
    fullscreenBtn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
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
    if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      toggleSave();
    } else if ((event.key === 'c' || event.key === 'C') && !subtitleBtn.hidden) {
      event.preventDefault();
      subtitleBtn.click();
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
      toast(`播放速度：${formatRate(player.cyclePlaybackRate(-1))}`);
    } else if (event.key === ']') {
      event.preventDefault();
      toast(`播放速度：${formatRate(player.cyclePlaybackRate(1))}`);
    } else if (event.key === 'b' || event.key === 'B') {
      event.preventDefault();
      noteEditor.open();
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
      player.destroy();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreen);
    },
  };
}

/** TL;DR card with clickable chapter chips, placed above the description. */
function buildOutline(data, onSeek) {
  return el('section', { class: 'watch-outline', 'aria-label': 'AI 内容大纲' },
    el('div', { class: 'outline-head' },
      el('h2', { class: 'outline-title' }, '内容大纲'),
      el('span', { class: 'outline-badge', title: '由 AI 根据字幕生成，仅供参考' }, 'AI 生成'),
    ),
    el('p', { class: 'outline-tldr' }, data.tldr || ''),
    el('div', { class: 'outline-chapters' },
      ...(data.chapters || []).map((chapter) => el('button', {
        class: 'outline-chip',
        type: 'button',
        title: `跳到 ${formatClock(chapter.s)}`,
        on: { click: () => onSeek(chapter.s) },
      },
        el('span', { class: 'outline-chip-ts' }, formatClock(chapter.s)),
        el('span', {}, chapter.t),
      )),
    ),
  );
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
  const play = el('button', {
    class: 'play-btn',
    type: 'button',
    'aria-label': initialStart > 0
      ? `从 ${formatClock(initialStart)} 播放视频`
      : '播放视频',
  }, el('span'));

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
  let lastKnownTime = startAt || 0;
  let lastKnownDuration = 0;
  let rate = normalizeRate(store.get('speed', 1));
  let onRateChange = null;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function doMount(customStart = startAt) {
    const beginSec = Math.max(0, Math.floor(customStart || 0));
    poster.remove();
    play.remove();
    resumePill?.remove();
    player.prepend(host);
    try {
      const YT = await loadYouTubeApi();
      if (destroyed) return null;
      const playerVars = {
        autoplay: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
        modestbranding: 1,
      };
      if (beginSec > 0) playerVars.start = beginSec;
      yt = new YT.Player(host, {
        videoId: video.vid,
        host: 'https://www.youtube-nocookie.com',
        playerVars,
        events: {
          onReady: () => {
            readyResolve();
            if (!destroyed) {
              if (beginSec > 0) yt.seekTo?.(beginSec, true);
              yt.playVideo?.();
              // 恢复用户偏好的播放倍速
              yt.setPlaybackRate?.(rate);
            }
          },
          onStateChange: (event) => {
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
      const startParam = beginSec > 0 ? `&start=${beginSec}` : '';
      fallbackFrame = el('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${video.vid}?autoplay=1&rel=0${startParam}`,
        title: video.title_zh || video.title,
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share',
        allowFullscreen: true,
      });
      host.remove();
      overlay.layer.remove();
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
          + `?autoplay=1&rel=0&start=${Math.floor(seconds)}`;
      }
    });
  }

  function applyRate(next) {
    rate = next;
    store.set('speed', next);
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
    overlay.update(currentTime);
    onTimeUpdate?.(currentTime, lastKnownDuration, force);
  }

  play.addEventListener('click', () => { mount(startAt); });
  player.append(poster, play, resumePill, overlay.layer);
  if (autoMount) mount(startAt);

  return {
    node: player,
    setCues: (cues) => overlay.setCues(cues),
    setEnabled: (on) => overlay.setEnabled(on),
    setBilingual: (on) => overlay.setBilingual(on),
    set onFallback(fn) { onFallback = fn; },
    set onTimeUpdate(fn) { onTimeUpdate = fn; },
    set onEnded(fn) { onEnded = fn; },
    set onPlaying(fn) { onPlaying = fn; },
    set onRateChange(fn) { onRateChange = fn; },
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
    getSubAlpha: () => overlay.getAlpha(),
    set onSubBoxChange(fn) { overlay.onChange = fn; },
    destroy() {
      tick(true);
      destroyed = true;
      clearInterval(timer);
      overlay.clear();
      yt?.destroy?.();
      yt = null;
    },
  };
}

const SUBTITLE_MODES = ['off', 'zh', 'both'];
const SUBTITLE_LABELS = { off: '字幕 关', zh: '字幕 中', both: '字幕 中英' };

function buildSubtitleButton(player) {
  let mode = store.get('subs_mode', null);
  if (!SUBTITLE_MODES.includes(mode)) {
    mode = store.get('subs', true) ? 'zh' : 'off';
  }
  const button = el('button', {
    class: 'hud-btn',
    type: 'button',
    hidden: true,
    title: '切换字幕模式（快捷键 C）',
    'aria-pressed': mode === 'off' ? 'false' : 'true',
  }, SUBTITLE_LABELS[mode]);

  const apply = () => {
    player.setEnabled(mode !== 'off');
    player.setBilingual(mode === 'both');
    button.textContent = SUBTITLE_LABELS[mode];
    button.classList.toggle('is-on', mode !== 'off');
    button.setAttribute('aria-pressed', mode === 'off' ? 'false' : 'true');
  };
  apply();

  button.addEventListener('click', () => {
    mode = SUBTITLE_MODES[(SUBTITLE_MODES.indexOf(mode) + 1) % SUBTITLE_MODES.length];
    store.set('subs_mode', mode);
    apply();
  });
  return button;
}

function buildTheaterButton() {
  return el('button', {
    class: 'hud-btn theater-btn',
    type: 'button',
    title: '切换宽屏（快捷键 W）',
    'aria-pressed': 'false',
  }, '宽屏');
}

function buildAutoplayButton() {
  let on = store.get('autoplay', false) === true;
  const button = el('button', {
    class: 'hud-btn autoplay-btn' + (on ? ' is-on' : ''),
    type: 'button',
    title: '播放完自动播放下一个推荐视频（快捷键 A）',
    'aria-pressed': on ? 'true' : 'false',
  }, on ? '连播 开' : '连播 关');
  button.addEventListener('click', () => {
    on = !on;
    store.set('autoplay', on);
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.textContent = on ? '连播 开' : '连播 关';
    toast(on ? '连播已开：播完自动播放下一个推荐' : '连播已关');
  });
  return button;
}

function buildFullscreenButton(player) {
  const button = el('button', {
    class: 'hud-btn',
    type: 'button',
    title: '全屏播放（快捷键 F）',
  }, '全屏');
  if (!document.fullscreenEnabled) button.hidden = true;
  button.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else player.node.requestFullscreen?.();
  });
  return button;
}

function buildRateButton(player) {
  const button = el('button', {
    class: 'hud-btn rate-btn',
    type: 'button',
    title: '切换播放倍速（快捷键 [ / ]）',
  }, formatRate(player.getPlaybackRate()));
  button.addEventListener('click', () => {
    const value = player.cyclePlaybackRate(1);
    toast(`播放速度：${formatRate(value)}`);
  });
  return button;
}

/**
 * 播放器顶部悬浮 HUD 栏：
 * - 鼠标移入播放器、移动或触摸时自动唤醒 1.2 秒，鼠标移出播放器后 180ms 迅速收起；
 * - 顶部保留 16px 隐形感应热区（.player-hud-wake），即使 YouTube iframe 吞掉内部移动事件，
 *   鼠标滑向播放器上沿也能立即唤出 HUD。
 */
function buildPlayerHud(playerNode, leftBtns = [], rightBtns = []) {
  const wakeZone = el('div', { class: 'player-hud-wake', 'aria-hidden': 'true' });
  const bar = el('div', {
    class: 'player-hud',
    role: 'toolbar',
    'aria-label': '播放器控制栏',
  },
    el('div', { class: 'hud-group' }, ...leftBtns),
    el('div', { class: 'hud-group hud-group-right' }, ...rightBtns),
  );
  const wrap = el('div', { class: 'player-hud-wrap' }, wakeZone, bar);

  let wakeTimer = null;
  const scheduleHide = (delayMs) => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      if (!bar.matches(':hover')) {
        playerNode.classList.remove('is-hud-awake');
      }
    }, delayMs);
  };
  const wake = (delayMs = 1200) => {
    playerNode.classList.add('is-hud-awake');
    scheduleHide(delayMs);
  };

  playerNode.addEventListener('pointerenter', () => wake(1200));
  playerNode.addEventListener('pointermove', () => wake(1200));
  playerNode.addEventListener('pointerleave', () => scheduleHide(180));
  playerNode.addEventListener('touchstart', () => wake(1800), { passive: true });
  wakeZone.addEventListener('pointerenter', () => wake(1200));
  bar.addEventListener('pointerenter', () => {
    playerNode.classList.add('is-hud-awake');
    if (wakeTimer) clearTimeout(wakeTimer);
  });
  bar.addEventListener('pointerleave', () => scheduleHide(220));
  wake(1400);

  return {
    node: wrap,
    wake,
    destroy() {
      if (wakeTimer) clearTimeout(wakeTimer);
    },
  };
}

/** ? 键快捷键速查浮层。 */
function buildKbdHelp() {
  const rows = [
    ['/', '聚焦搜索框'],
    ['S', '收藏当前视频'],
    ['C', '切换字幕模式（关 / 中 / 中英）'],
    ['T', '切换字幕流 / 推荐面板'],
    ['F', '全屏播放'],
    ['W', '宽屏模式'],
    ['A', '连播开关'],
    ['J / L', '快退 / 快进 10 秒'],
    ['[ / ]', '降低 / 提高播放速度'],
    ['B', '随手记：在当前时间点添加书签'],
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
    if (event.target === overlay) overlay.hidden = true;
  });
  return {
    node: overlay,
    toggle() {
      overlay.hidden = !overlay.hidden;
    },
    close() {
      overlay.hidden = true;
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
        class: 'btn',
        href: watchUrl,
        target: '_blank',
        rel: 'noopener',
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

  const chips = tagNodes.length ? el('div', { class: 'desc-chips' }, ...tagNodes) : null;
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
