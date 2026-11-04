import { el, avatar, thumb, typeLabel, metaLine, toast } from './ui.js';
import { comments as loadComments, load, store, subs as loadSubs } from './data.js';
import { renderComments } from './comments.js';
import { createOverlay, loadYouTubeApi, renderTranscript } from './subtitles.js';

const RELATED_LIMIT = 12;
const RELATED_MIN = 8;

export function show(container, route, ctx) {
  const video = ctx.feedIndex.get(route.vid);
  if (!video) {
    showError(container, '找不到这个视频', '链接可能已经失效。');
    return null;
  }

  let destroyed = false;
  ctx.setTitle(`${video.title_zh || video.title} · HackerTube 中文`);
  markVisited(video.vid);

  const player = buildPlayer(video);
  const title = el('h1', { class: 'watch-title' }, video.title_zh || video.title);
  const english = video.title && video.title_zh && video.title !== video.title_zh
    ? el('p', { class: 'watch-sub' }, video.title)
    : null;
  const commentCount = video.comment_count || 0;
  const subtitleBtn = buildSubtitleButton(player);
  const fullscreenBtn = buildFullscreenButton(player);
  let canSync = true;
  player.onFallback = () => {
    canSync = false;
    subtitleBtn.hidden = true;
  };
  const { row: channel, toggleSave } = buildChannel(
    video, commentCount, [subtitleBtn, fullscreenBtn],
  );
  const description = buildDescription(video, ctx);
  const transcriptBox = el('div', { class: 'transcript-box' });
  const commentsBox = el('section', { class: 'comments' });

  if (commentCount > 0) {
    commentsBox.append(el('p', { class: 'muted' }, '正在加载讨论…'));
    loadComments(video.vid).then((payload) => {
      if (!destroyed) renderComments(commentsBox, payload);
    });
  } else {
    renderComments(commentsBox, null);
  }

  const main = el('div', { class: 'watch-main' }, player.node, title);
  if (english) main.append(english);
  main.append(channel, description, transcriptBox, commentsBox);

  const railList = el('div', { class: 'related-list' },
    ...pickRelated(video, {}, ctx).map(relatedItem),
  );
  const rail = el('aside', { class: 'related' },
    el('h2', {}, '接下来'),
    railList,
  );

  load.related().catch(() => ({})).then((relatedMap) => {
    if (destroyed || !relatedMap[video.vid]) return;
    railList.replaceChildren(...pickRelated(video, relatedMap, ctx).map(relatedItem));
  });

  container.replaceChildren(el('div', { class: 'watch' }, main, rail));

  loadSubs(video.vid).then((payload) => {
    if (destroyed) return;
    const cues = (payload?.cues || []).filter((cue) => cue.zh);
    if (!cues.length) return;
    player.setCues(cues);
    subtitleBtn.hidden = !canSync;
    transcriptBox.append(renderTranscript(cues, (seconds) => player.seek(seconds)));
  });

  const onFullscreen = () => {
    fullscreenBtn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
  };
  document.addEventListener('fullscreenchange', onFullscreen);

  const onKeyDown = (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((event.key === 's' || event.key === 'S') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      toggleSave();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  return {
    destroy() {
      destroyed = true;
      player.destroy();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreen);
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

function buildPlayer(video) {
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
    'aria-label': '播放视频',
  }, el('span'));

  let yt = null;
  let timer = null;
  let mounting = null;
  let destroyed = false;
  let fallbackFrame = null;
  let onFallback = null;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function doMount() {
    player.replaceChildren(host, overlay.layer);
    try {
      const YT = await loadYouTubeApi();
      if (destroyed) return null;
      yt = new YT.Player(host, {
        videoId: video.vid,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1,
          rel: 0,
          fs: 0,
          playsinline: 1,
          modestbranding: 1,
        },
        events: {
          onReady: () => {
            readyResolve();
            if (!destroyed) yt.playVideo();
          },
          onStateChange: (event) => {
            if (event.data === 0) overlay.clear();
          },
        },
      });
      timer = setInterval(tick, 250);
    } catch {
      if (destroyed) return null;
      fallbackFrame = el('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${video.vid}?autoplay=1&rel=0`,
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

  function mount() {
    if (yt) return Promise.resolve(yt);
    if (!mounting) mounting = doMount();
    return mounting;
  }

  function tick() {
    if (!yt || typeof yt.getCurrentTime !== 'function') return;
    const state = yt.getPlayerState?.();
    if (state !== 1 && state !== 2) return;
    overlay.update(yt.getCurrentTime());
  }

  play.addEventListener('click', () => { mount(); });
  player.append(poster, play, overlay.layer);

  return {
    node: player,
    setCues: (cues) => overlay.setCues(cues),
    setEnabled: (on) => overlay.setEnabled(on),
    setBilingual: (on) => overlay.setBilingual(on),
    set onFallback(fn) { onFallback = fn; },
    seek(seconds) {
      mount().then(() => ready).then(() => {
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

function buildFullscreenButton(player) {
  const button = el('button', { class: 'btn', type: 'button' }, '全屏');
  if (!document.fullscreenEnabled) button.hidden = true;
  button.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else player.node.requestFullscreen?.();
  });
  return button;
}

function buildChannel(video, commentCount, extra = []) {
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

  const shareBtn = el('button', { class: 'btn', type: 'button' }, '分享');
  shareBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('链接已复制');
    } catch {
      window.prompt('复制这个链接', location.href);
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
  for (const cat of (video.categories || []).slice(0, 3)) {
    if (!cat) continue;
    tagNodes.push(el('a', {
      class: 'mini-chip',
      href: `#/feed?q=${encodeURIComponent(cat)}`,
    }, cat));
  }

  const chips = el('div', { class: 'desc-chips', hidden: true }, ...tagNodes);
  const toggle = el('button', {
    class: 'desc-toggle',
    type: 'button',
    'aria-expanded': 'false',
  }, '展开简介');
  const description = el('div', { class: 'description is-collapsed' }, body, chips, toggle);

  const setExpanded = (expanded) => {
    description.classList.toggle('is-collapsed', !expanded);
    chips.hidden = !expanded;
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
  return el('a', { class: 'related-item', href: `#/video/${video.vid}` },
    thumb(video, { className: 'related-thumb' }),
    el('div', {},
      el('p', { class: 'related-title' }, video.title_zh || video.title),
      el('p', { class: 'related-meta' }, `${video.channel} · ${metaLine(video)}`),
    ),
  );
}

function markVisited(vid) {
  const visited = store.list('visited').filter((id) => id !== vid);
  visited.unshift(vid);
  store.set('visited', visited.slice(0, 500));
}
