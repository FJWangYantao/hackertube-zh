import { el, thumb, avatar, metaLine, typeLabel } from './ui.js';
import { store } from './data.js';
import { replace } from './router.js';

const PAGE = 48;

let ctx;
let container;
let viewName;
let params;
let list = [];
let shown = 0;
let grid;
let sentinel;
let chipsEl;
let sortEl;
let countEl;
let observer;

export function show(viewEl, route, context) {
  ctx = context;
  container = viewEl;
  viewName = route.view;
  params = new URLSearchParams(route.params);
  renderShell();
  observer = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting && shown < list.length) renderBatch();
  }, { rootMargin: '600px' });
  apply();
  return { setQuery, destroy };
}

function renderShell() {
  chipsEl = el('div', { class: 'chips', role: 'group', 'aria-label': '按主题筛选' });
  sortEl = el('select', { class: 'sort', id: 'sort', name: 'sort', 'aria-label': '排序' },
    el('option', { value: 'score' }, '综合排序'),
    el('option', { value: 'recommenders' }, '推荐人数'),
    el('option', { value: 'last_year' }, '最近提及'),
  );
  sortEl.addEventListener('change', () => {
    setParam('sort', sortEl.value === 'score' ? '' : sortEl.value);
  });
  countEl = el('p', { class: 'count' });
  const head = el('div', { class: 'feed-head' }, el('h1', {}, '发现'), countEl);
  grid = el('div', { class: 'grid' });
  sentinel = el('div', { class: 'sentinel' });
  container.replaceChildren(
    el('section', { class: 'feed' },
      el('div', { class: 'chips-bar' }, chipsEl, sortEl),
      head,
      grid,
      sentinel,
    ),
  );
}

function apply() {
  buildChips();
  sortEl.value = params.get('sort') || 'score';
  list = buildList();
  shown = 0;
  renderBatch(true);
  updateHead();
  observer.disconnect();
  observer.observe(sentinel);
  ctx.syncNav?.(viewName, params);
}

function buildChips() {
  const area = params.get('area') || '';
  const discussed = params.get('discussed') === '1';
  const chips = [
    chipButton('全部', !area && !discussed, () => {
      params.delete('area');
      params.delete('discussed');
      sync();
    }),
    chipButton('有中文讨论', discussed, () => {
      if (discussed) params.delete('discussed');
      else params.set('discussed', '1');
      sync();
    }),
  ];
  for (const item of ctx.meta.areas) {
    chips.push(chipButton(item.name_zh, area === item.id, () => {
      if (area === item.id) params.delete('area');
      else params.set('area', item.id);
      sync();
    }));
  }
  chipsEl.replaceChildren(...chips);
}

function chipButton(label, pressed, onClick) {
  return el('button', {
    class: 'chip',
    type: 'button',
    'aria-pressed': pressed ? 'true' : 'false',
    on: { click: onClick },
  }, label);
}

function setParam(key, value) {
  if (value) params.set(key, value);
  else params.delete(key);
  sync();
}

function sync() {
  const query = params.toString();
  replace(`/${viewName}${query ? '?' + query : ''}`);
  apply();
}

function setQuery(value) {
  const query = value.trim();
  if (query) params.set('q', query);
  else params.delete('q');
  sync();
}

function buildList() {
  const ids = viewName === 'saved' || viewName === 'history'
    ? new Set(store.list(viewName === 'history' ? 'visited' : 'saved'))
    : null;
  const area = params.get('area') || '';
  const discussed = params.get('discussed') === '1';
  const query = (params.get('q') || '').trim().toLowerCase();

  let rows = ctx.feed;
  if (ids) {
    rows = rows.filter((video) => ids.has(video.vid));
  } else if (params.get('all') !== '1') {
    rows = rows.filter(
      (video) => (video.recommenders || 0) > 0 && video.shelf_life !== 'news',
    );
  }
  if (area) rows = rows.filter((video) => video.area === area);
  if (discussed) rows = rows.filter((video) => (video.comment_count || 0) > 0);
  if (query) rows = rows.filter((video) => haystack(video).includes(query));

  return [...rows].sort(comparator(params.get('sort') || 'score'));
}

function haystack(video) {
  return [
    video.title,
    video.title_zh,
    video.summary_zh,
    video.channel,
    ctx.areaName(video.area),
    typeLabel(video.content_type),
  ].filter(Boolean).join(' ').toLowerCase();
}

function comparator(sort) {
  if (sort === 'recommenders') {
    return (a, b) => (b.recommenders || 0) - (a.recommenders || 0)
      || (b.score || 0) - (a.score || 0);
  }
  if (sort === 'last_year') {
    return (a, b) => (b.last_year || 0) - (a.last_year || 0)
      || (b.score || 0) - (a.score || 0);
  }
  return (a, b) => (b.score || 0) - (a.score || 0);
}

function renderBatch(reset = false) {
  if (reset) grid.replaceChildren();
  const slice = list.slice(shown, shown + PAGE);
  const fragment = document.createDocumentFragment();
  for (const video of slice) fragment.append(card(video));
  grid.append(fragment);
  shown += slice.length;
  if (!list.length) grid.append(emptyState());
  if (shown >= list.length) observer.disconnect();
}

function card(video) {
  const link = el('a', { class: 'card-link', href: `#/video/${video.vid}` });
  const thumbNode = thumb(video);
  if (video.comment_count > 0) {
    thumbNode.append(el('span', { class: 'badge' }, `${video.comment_count} 条讨论`));
  }
  link.append(
    thumbNode,
    el('div', { class: 'card-body' },
      avatar(video.channel),
      el('div', { class: 'card-text' },
        el('h3', { class: 'card-title' }, video.title_zh || video.title),
        el('p', { class: 'card-channel' }, video.channel || ''),
        el('p', { class: 'card-meta' }, metaLine(video)),
      ),
    ),
  );
  return el('article', { class: 'card' }, link);
}

function emptyState() {
  const copy = {
    saved: ['还没有收藏', '打开一个视频，点「收藏」就会出现在这里。'],
    history: ['还没有浏览记录', '看过的视频会自动记录在这里。'],
    feed: ['没有匹配的内容', '换一个关键词，或清除主题和讨论筛选。'],
  }[viewName] || ['没有内容', ''];
  const wrap = el('div', { class: 'empty' }, el('h2', {}, copy[0]), el('p', {}, copy[1]));
  if (viewName === 'feed') {
    wrap.append(el('button', {
      class: 'btn',
      type: 'button',
      on: {
        click: () => {
          params = new URLSearchParams();
          sync();
        },
      },
    }, '清除筛选'));
  }
  return wrap;
}

function updateHead() {
  const counts = list.length.toLocaleString('zh-CN');
  const label = viewName === 'saved' ? '收藏' : viewName === 'history' ? '已浏览' : '发现';
  const scope = viewName === 'feed'
    ? (params.get('all') === '1' ? `${counts} 个视频` : `${counts} 个被推荐的内容`)
    : `${counts} 个视频`;
  container.querySelector('.feed-head h1').textContent = label;
  countEl.textContent = scope;
}

export function destroy() {
  observer?.disconnect();
}
