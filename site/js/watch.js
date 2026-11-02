import { el, avatar, thumb, typeLabel, metaLine, toast } from './ui.js';
import { comments as loadComments, load, videoIndex, store } from './data.js';
import { renderComments } from './comments.js';

const RELATED_LIMIT = 12;
const RELATED_MIN = 8;

export async function show(container, route, ctx) {
  container.replaceChildren(el('p', { class: 'loading' }, '加载中…'));

  let index;
  let payload;
  let relatedMap;
  try {
    [index, payload, relatedMap] = await Promise.all([
      videoIndex(),
      loadComments(route.vid),
      load.related().catch(() => ({})),
    ]);
  } catch {
    showError(container, '视频加载失败', '请通过本地服务器打开站点，并确认 data/videos.json 已生成。');
    return;
  }

  const video = index.get(route.vid);
  if (!video) {
    showError(container, '找不到这个视频', '链接可能已经失效。');
    return;
  }

  ctx.setTitle(`${video.title_zh || video.title} · HackerTube 中文`);
  markVisited(video.vid);

  const player = buildPlayer(video);
  const title = el('h1', { class: 'watch-title' }, video.title_zh || video.title);
  const english = video.title && video.title_zh && video.title !== video.title_zh
    ? el('p', { class: 'watch-sub' }, video.title)
    : null;
  const commentCount = payload?.comments?.length || 0;
  const channel = buildChannel(video, commentCount);
  const description = buildDescription(video);
  const commentsBox = el('section', { class: 'comments' });
  renderComments(commentsBox, payload);

  const main = el('div', { class: 'watch-main' }, player, title);
  if (english) main.append(english);
  main.append(channel, description, commentsBox);

  const relatedVideos = pickRelated(video, relatedMap, ctx);
  const rail = el('aside', { class: 'related' },
    el('h2', {}, '接下来'),
    el('div', { class: 'related-list' }, ...relatedVideos.map(relatedItem)),
  );

  container.replaceChildren(el('div', { class: 'watch' }, main, rail));
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
    'aria-pressed': saved ? 'true' : 'false',
  }, saved ? '已收藏' : '收藏');
  saveBtn.addEventListener('click', () => {
    const on = store.toggle('saved', video.vid);
    saveBtn.classList.toggle('is-on', on);
    saveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    saveBtn.textContent = on ? '已收藏' : '收藏';
    toast(on ? '已收藏' : '已取消收藏');
  });

  const shareBtn = el('button', { class: 'btn', type: 'button' }, '分享');
  shareBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('链接已复制');
    } catch {
      window.prompt('复制这个链接', location.href);
    }
  });

  const watchUrl = video.url || `https://www.youtube.com/watch?v=${video.vid}`;
  const meta = [metaLine(video), commentCount ? `${commentCount} 条讨论` : '']
    .filter(Boolean).join(' · ');

  return el('div', { class: 'channel-row' },
    avatar(video.channel, 'lg'),
    el('div', {},
      el('p', { class: 'channel-name' }, video.channel || '未知频道'),
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
      }, '在 YouTube 观看'),
    ),
  );
}

function buildDescription(video) {
  const summary = video.summary_zh || video.summary || '';
  const why = video.why_zh || video.why_hn || '';

  const body = el('div', { class: 'desc-body' }, el('p', {}, summary));
  if (why) {
    body.append(el('p', { class: 'desc-why' },
      el('strong', {}, '为什么 HN 推荐：'), why));
  }

  const chips = el('div', { class: 'desc-chips', hidden: true },
    ...[
      video.channel,
      typeLabel(video.content_type),
      metaLine(video),
      ...(video.categories || []).slice(0, 3),
    ].filter(Boolean).map((text) => el('span', { class: 'mini-chip' }, text)),
  );

  const toggle = el('button', { class: 'desc-toggle', type: 'button' }, '展开');
  const description = el('div', { class: 'description is-collapsed' }, body, toggle, chips);
  toggle.addEventListener('click', () => {
    const collapsed = description.classList.toggle('is-collapsed');
    chips.hidden = collapsed;
    toggle.textContent = collapsed ? '展开' : '收起';
  });

  description.append(el('p', { class: 'mt-note' },
    '中文内容由机器翻译，仅供快速浏览。视频与评论版权属于原作者。'));
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
