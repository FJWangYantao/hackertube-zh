import {
  el, avatar, thumb, typeLabel, levelLabel, metaLine, toast, formatClock, thumbProgress,
} from './ui.js';
import { comments as loadComments, load, store, subs as loadSubs, chapters as loadChapters } from './data.js';
import { renderComments } from './comments.js';
import { createOverlay, loadYouTubeApi, renderTranscript } from './subtitles.js';

const RELATED_LIMIT = 12;
const RELATED_MIN = 8;

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
  let toggleRailTab = null;
  let chapterBar = null;
  let cachedRelatedMap = {};
  ctx.setTitle(`${video.title_zh || video.title} · HackerTube 中文`);
  markVisited(video.vid);

  const urlTime = parseTimeParam(route.params?.get('t'));
  const savedProgress = store.getProgress(video.vid);
  const canResumeSaved = !urlTime
    && savedProgress?.t >= 5
    && (!savedProgress.d || savedProgress.t < savedProgress.d - 12);
  const initialStart = urlTime || (canResumeSaved ? savedProgress.t : 0);

  const player = buildPlayer(video, initialStart, canResumeSaved);
  const chaptersPromise = loadChapters(video.vid).catch(() => null);
  player.onTimeUpdate = (time, duration, force = false) => {
    transcript?.update(time);
    chapterBar?.update(time);
    store.setProgress(video.vid, time, duration, force);
  };

  const seekAndScroll = (seconds) => {
    player.seek(seconds);
    const rect = player.node.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      player.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const title = el('h1', { class: 'watch-title' }, video.title_zh || video.title);
  const english = video.title && video.title_zh && video.title !== video.title_zh
    ? el('p', { class: 'watch-sub' }, video.title)
    : null;
  const commentCount = video.comment_count || 0;
  const subtitleBtn = buildSubtitleButton(player);
  const theaterBtn = buildTheaterButton();
  const fullscreenBtn = buildFullscreenButton(player);
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
  const { row: channel, toggleSave } = buildChannel(
    video, commentCount, player, [subtitleBtn, theaterBtn, fullscreenBtn],
  );
  const description = buildDescription(video, ctx);
  const commentsBox = el('section', { class: 'comments' });

  if (commentCount > 0) {
    commentsBox.append(el('p', { class: 'muted' }, '正在加载讨论…'));
    loadComments(video.vid).then((payload) => {
      if (!destroyed) renderComments(commentsBox, payload, seekAndScroll);
    });
  } else {
    renderComments(commentsBox, null, seekAndScroll);
  }

  const main = el('div', { class: 'watch-main' }, player.node, title);
  // Poster bleed for the CSS ambient glow around the player.
  main.style.setProperty(
    '--ambient-img',
    `url("https://i.ytimg.com/vi/${video.vid}/hqdefault.jpg")`,
  );
  if (english) main.append(english);
  main.append(channel, description);

  // AI outline: chapter strip under the player + TL;DR card above the description.
  chaptersPromise.then((data) => {
    if (destroyed) return;
    const chapters = data?.chapters || [];
    if (!chapters.length) return;
    chapterBar = buildChapterBar(chapters, data.dur || 0, seekAndScroll);
    main.insertBefore(chapterBar.node, title);
    main.insertBefore(buildOutline(data, seekAndScroll), description);
    chapterBar.update(initialStart);
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

  watchRoot = el('div', { class: 'watch' }, main, rail, commentsBox);
  container.replaceChildren(watchRoot);
  setTheater(store.get('theater', false) === true);

  loadSubs(video.vid).then(async (payload) => {
    if (destroyed) return;
    const cues = (payload?.cues || []).filter((cue) => cue.zh);
    if (!cues.length) return;
    player.setCues(cues);
    subtitleBtn.hidden = !canSync;
    const chapterData = await chaptersPromise;
    if (destroyed) return;
    transcript = renderTranscript(cues, seekAndScroll, {
      chapters: chapterData?.chapters || [],
      meta: { vid: video.vid, title: video.title_zh || video.title },
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
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
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
    } else if ((event.key === 'w' || event.key === 'W')
      && window.matchMedia('(min-width: 1101px)').matches) {
      event.preventDefault();
      theaterBtn.click();
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
      transcript?.destroy?.();
      player.destroy();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreen);
    },
  };
}

/** Chapter strip right under the player; segments sized by chapter length. */
function buildChapterBar(chapters, duration, onSeek) {
  const last = chapters[chapters.length - 1];
  const total = Math.max(1, duration || (last ? last.s + 60 : 1));
  const segments = chapters.map((chapter, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].s : total;
    const span = Math.max(2, end - chapter.s);
    const node = el('button', {
      class: 'chapter-seg',
      type: 'button',
      style: { flexGrow: String(span) },
      title: `${formatClock(chapter.s)} · ${chapter.t}`,
      on: { click: () => onSeek(chapter.s) },
    },
      el('span', { class: 'chapter-seg-time' }, formatClock(chapter.s)),
      el('span', { class: 'chapter-seg-title' }, chapter.t),
    );
    return { chapter, node };
  });

  const bar = el('div', { class: 'chapter-bar', role: 'navigation', 'aria-label': '章节导航' },
    ...segments.map((segment) => segment.node));

  let active = -1;
  return {
    node: bar,
    update(time) {
      let next = -1;
      for (let i = 0; i < segments.length; i++) {
        if (time + 0.01 >= segments[i].chapter.s) next = i;
      }
      if (next === active) return;
      if (active >= 0) segments[active].node.classList.remove('is-active');
      active = next;
      if (next >= 0) segments[next].node.classList.add('is-active');
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

function buildPlayer(video, initialStart = 0, isSavedResume = false) {
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
  let lastKnownTime = startAt || 0;
  let lastKnownDuration = 0;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function doMount(customStart = startAt) {
    const beginSec = Math.max(0, Math.floor(customStart || 0));
    player.replaceChildren(host, overlay.layer);
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
            }
          },
          onStateChange: (event) => {
            if (event.data === 0) {
              overlay.clear();
              if (lastKnownDuration > 0) {
                onTimeUpdate?.(lastKnownDuration, lastKnownDuration, true);
              }
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
      player.replaceChildren(fallbackFrame);
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

  return {
    node: player,
    setCues: (cues) => overlay.setCues(cues),
    setEnabled: (on) => overlay.setEnabled(on),
    setBilingual: (on) => overlay.setBilingual(on),
    set onFallback(fn) { onFallback = fn; },
    set onTimeUpdate(fn) { onTimeUpdate = fn; },
    getCurrentTime() {
      if (yt && typeof yt.getCurrentTime === 'function') {
        const t = yt.getCurrentTime();
        if (Number.isFinite(t) && t > 0) return Math.floor(t);
      }
      return Math.floor(lastKnownTime || 0);
    },
    seek(seconds) {
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
    },
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
    class: 'btn',
    type: 'button',
    hidden: true,
    title: '切换字幕模式（快捷键 C）',
    'aria-pressed': mode === 'off' ? 'false' : 'true',
  }, SUBTITLE_LABELS[mode]);

  const apply = () => {
    player.setEnabled(mode !== 'off');
    player.setBilingual(mode === 'both');
    button.textContent = SUBTITLE_LABELS[mode];
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
    class: 'btn theater-btn',
    type: 'button',
    title: '切换宽屏（快捷键 W）',
    'aria-pressed': 'false',
  }, '宽屏');
}

function buildFullscreenButton(player) {
  const button = el('button', {
    class: 'btn',
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

  const body = el('div', { class: 'desc-body' });
  if (why) {
    body.append(el('p', { class: 'desc-why' },
      el('strong', {}, '为什么 HN 推荐：'), why));
  }
  if (summary) {
    body.append(el('p', {}, summary));
  }

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
    tagNodes.push(el('a', {
      class: 'mini-chip',
      href: `#/feed?q=${encodeURIComponent(cat)}`,
    }, cat));
  }

  const chips = tagNodes.length ? el('div', { class: 'desc-chips' }, ...tagNodes) : null;
  const isLong = (why.length + summary.length) > 130 && Boolean(why && summary);
  if (!isLong) {
    return el('div', { class: 'description' }, body, chips);
  }

  const toggle = el('button', {
    class: 'desc-toggle',
    type: 'button',
    'aria-expanded': 'false',
  }, '展开简介');
  const description = el('div', { class: 'description is-collapsed' }, body, toggle, chips);

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
