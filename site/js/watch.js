import { el, avatar, thumb, typeLabel, metaLine, toast } from './ui.js';
import { comments as loadComments, load, store } from './data.js';
import { renderComments } from './comments.js';

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
  const { row: channel, toggleSave } = buildChannel(video, commentCount);
  const description = buildDescription(video, ctx);
  const commentsBox = el('section', { class: 'comments' });

  if (commentCount > 0) {
    commentsBox.append(el('p', { class: 'muted' }, '正在加载讨论…'));
    loadComments(video.vid).then((payload) => {
      if (!destroyed) renderComments(commentsBox, payload);
    });
  } else {
    renderComments(commentsBox, null);
  }

  const main = el('div', { class: 'watch-main' }, player, title);
  if (english) main.append(english);
  main.append(channel, description, commentsBox);

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
      document.removeEventListener('keydown', onKeyDown);
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

  const play = el('button', {
    class: 'play-btn',
    type: 'button',
    'aria-label': '播放视频',
  }, el('span'));
  play.addEventListener('click', () => {
    const frame = el('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${video.vid}?autoplay=1&rel=0`,
      title: video.title_zh || video.title,
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share',
      allowFullscreen: true,
    });
    player.replaceChildren(frame);
  });

  player.append(poster, play);
  return player;
}

function buildChannel(video, commentCount) {
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
