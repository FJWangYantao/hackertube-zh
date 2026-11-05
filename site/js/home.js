import { el, thumb, avatar, metaLine, typeLabel, levelLabel, toast } from './ui.js';
import { store } from './data.js';
import { replace } from './router.js';

const PAGE = 48;

const TYPE_CHIPS = [
  ['talk', '演讲'],
  ['lecture', '课程'],
  ['explainer', '讲解'],
  ['documentary', '纪录片'],
  ['interview', '访谈'],
  ['demo', '演示'],
];

let ctx;
let container;
let viewName;
let params;
let list = [];
let shown = 0;
let savedSet = new Set();
let visitedSet = new Set();
let chipsBarEl;
let chipsEl;
let sortEl;
let headEl;
let titleEl;
let countEl;
let headActionEl;
let grid;
let sentinel;
let observer;

export function show(viewEl, route, context, restored = null) {
  ctx = context;
  container = viewEl;
  viewName = route.view;
  params = new URLSearchParams(route.params);
  renderShell();
  observer = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting && shown < list.length) renderBatch();
  }, { rootMargin: '600px' });
  apply(restored?.shown || PAGE);
  return { setQuery, getShown: () => shown, destroy, refresh };
}

function renderShell() {
  chipsEl = el('div', { class: 'chips', role: 'group', 'aria-label': '按类型与讨论筛选' });
  sortEl = el('select', { class: 'sort', id: 'sort', name: 'sort', 'aria-label': '排序' },
    el('option', { value: 'score' }, '综合排序'),
    el('option', { value: 'recommenders' }, '推荐人数'),
    el('option', { value: 'last_year' }, '最近提及'),
  );
  sortEl.addEventListener('change', () => {
    setParam('sort', sortEl.value === 'score' ? '' : sortEl.value);
  });
  chipsBarEl = el('div', { class: 'chips-bar' }, chipsEl, sortEl);
  titleEl = el('h1', {});
  countEl = el('p', { class: 'count' });
  headActionEl = el('div', { class: 'head-actions' });
  headEl = el('div', { class: 'feed-head' }, titleEl, countEl, headActionEl);
  grid = el('div', { class: 'grid' });
  sentinel = el('div', { class: 'sentinel' });
  container.replaceChildren(
    el('section', { class: 'feed' },
      chipsBarEl,
      headEl,
      grid,
      sentinel,
    ),
  );
}

function apply(initialCount = PAGE) {
  savedSet = new Set(store.list('saved'));
  visitedSet = new Set(store.list('visited'));
  chipsBarEl.hidden = viewName !== 'feed';
  buildChips();
  sortEl.value = params.get('sort') || 'score';
  list = buildList();
  shown = 0;
  renderBatch(true, initialCount);
  updateHead();
  observer.disconnect();
  observer.observe(sentinel);
  ctx.syncNav?.(viewName, params);
}

/** Recompute the list after more rows arrive, keeping the current position. */
function refresh() {
  const keep = Math.max(shown, PAGE);
  list = buildList();
  shown = 0;
  renderBatch(true, keep);
  updateHead();
  observer.disconnect();
  observer.observe(sentinel);
}

function buildChips() {
  const area = params.get('area') || '';
  const type = params.get('type') || '';
  const level = params.get('level') || '';
  const discussed = params.get('discussed') === '1';
  const sub = params.get('sub') === '1';
  const channel = params.get('channel') || '';
  const hasFilter = Boolean(area || type || level || discussed || sub || channel);

  const chips = [
    chipButton('全部', !hasFilter, () => {
      params.delete('area');
      params.delete('type');
      params.delete('level');
      params.delete('discussed');
      params.delete('sub');
      params.delete('channel');
      sync();
    }),
  ];

  if (area) {
    chips.push(chipButton(`${ctx.areaName(area) || area} ×`, true, () => {
      params.delete('area');
      sync();
    }));
  }

  if (channel) {
    chips.push(chipButton(`频道：${channel} ×`, true, () => {
      params.delete('channel');
      sync();
    }));
  }

  if (level) {
    chips.push(chipButton(`难度：${levelLabel(level, { includeGeneral: true }) || level} ×`, true, () => {
      params.delete('level');
      sync();
    }));
  }

  chips.push(
    chipButton('有中文字幕', sub, () => {
      if (sub) params.delete('sub');
      else params.set('sub', '1');
      sync();
    }),
    chipButton('有中文讨论', discussed, () => {
      if (discussed) params.delete('discussed');
      else params.set('discussed', '1');
      sync();
    }),
  );

  for (const [key, label] of TYPE_CHIPS) {
    chips.push(chipButton(label, type === key, () => {
      if (type === key) params.delete('type');
      else params.set('type', key);
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
  const orderedIds = viewName === 'saved' || viewName === 'history'
    ? store.list(viewName === 'history' ? 'visited' : 'saved')
    : null;
  const area = params.get('area') || '';
  const type = params.get('type') || '';
  const level = params.get('level') || '';
  const channel = params.get('channel') || '';
  const discussed = params.get('discussed') === '1';
  const sub = params.get('sub') === '1';
  const terms = (params.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  let rows;
  if (orderedIds) {
    rows = orderedIds.map((id) => ctx.feedIndex.get(id)).filter(Boolean);
  } else {
    rows = ctx.feed;
    if (params.get('all') !== '1') {
      rows = rows.filter(
        (video) => (video.recommenders || 0) > 0 && video.shelf_life !== 'news',
      );
    }
  }
  if (area) rows = rows.filter((video) => video.area === area);
  if (type) rows = rows.filter((video) => video.content_type === type);
  if (level) rows = rows.filter((video) => video.level === level);
  if (channel) rows = rows.filter((video) => video.channel === channel);
  if (discussed) rows = rows.filter((video) => (video.comment_count || 0) > 0);
  if (sub) rows = rows.filter((video) => Boolean(video.has_sub));
  if (terms.length) {
    rows = rows.filter((video) => {
      const text = haystack(video);
      return terms.every((term) => text.includes(term));
    });
  }

  if (orderedIds && !params.get('sort')) return rows;
  return [...rows].sort(comparator(params.get('sort') || 'score'));
}

function haystack(video) {
  return [
    video.title,
    video.title_zh,
    video.summary_zh,
    video.why_zh,
    video.channel,
    video.topic,
    ctx.areaName(video.area),
    typeLabel(video.content_type),
    levelLabel(video.level, { includeGeneral: true }),
    ...(video.categories || []),
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

function renderBatch(reset = false, batchSize = PAGE) {
  if (reset) grid.replaceChildren();
  const slice = list.slice(shown, shown + batchSize);
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
  if (visitedSet.has(video.vid) && viewName !== 'history') {
    thumbNode.append(el('span', { class: 'badge-visited' }, '已看'));
  }
  if (video.has_sub || video.comment_count > 0) {
    const badges = el('div', { class: 'thumb-badges' });
    if (video.has_sub) {
      badges.append(el('span', { class: 'badge badge-sub', title: '站内提供中英双语字幕' }, '中字'));
    }
    if (video.comment_count > 0) {
      badges.append(el('span', { class: 'badge' }, `${video.comment_count} 条讨论`));
    }
    thumbNode.append(badges);
  }

  const typeText = typeLabel(video.content_type);
  const levelText = levelLabel(video.level);
  const metaRow = el('p', { class: 'card-meta' });
  if (typeText) {
    metaRow.append(el('span', { class: 'meta-tag' }, typeText));
  }
  if (levelText) {
    metaRow.append(el('span', { class: `meta-tag is-level is-${video.level}` }, levelText));
  }
  metaRow.append(el('span', {}, metaLine(video)));

  link.append(
    thumbNode,
    el('div', { class: 'card-body' },
      avatar(video.channel),
      el('div', { class: 'card-text' },
        el('h3', { class: 'card-title' }, video.title_zh || video.title),
        el('p', { class: 'card-channel' }, video.channel || ''),
        metaRow,
        video.why_zh ? el('p', { class: 'card-why' }, video.why_zh) : null,
      ),
    ),
  );

  const isSaved = savedSet.has(video.vid);
  const saveBtn = el('button', {
    class: 'card-save' + (isSaved ? ' is-on' : ''),
    type: 'button',
    title: isSaved ? '取消收藏' : '收藏',
    'aria-label': isSaved ? '取消收藏' : '收藏',
    'aria-pressed': isSaved ? 'true' : 'false',
    on: {
      click: (event) => {
        event.stopPropagation();
        const on = store.toggle('saved', video.vid);
        if (on) savedSet.add(video.vid);
        else savedSet.delete(video.vid);
        saveBtn.classList.toggle('is-on', on);
        saveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        saveBtn.setAttribute('aria-label', on ? '取消收藏' : '收藏');
        saveBtn.title = on ? '取消收藏' : '收藏';
        toast(on ? '已加入收藏' : '已取消收藏');
        if (viewName === 'saved' && !on) apply(shown);
      },
    },
  }, bookmarkIcon());

  return el('article', { class: 'card' }, link, saveBtn);
}

function bookmarkIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function emptyState() {
  const copy = {
    saved: ['还没有收藏', '把鼠标移到视频卡片右上角，或进入观看页点「收藏」即可保存。'],
    history: ['还没有浏览记录', '点开过的视频会自动记录在这里。'],
    feed: ['没有匹配的内容', '换一个关键词，或清除当前的筛选条件。'],
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
  const area = params.get('area') || '';
  const type = params.get('type') || '';
  const level = params.get('level') || '';
  const channel = params.get('channel') || '';
  const query = (params.get('q') || '').trim();
  const discussed = params.get('discussed') === '1';
  const sub = params.get('sub') === '1';
  const all = params.get('all') === '1';
  const isFilteredFeed = viewName === 'feed'
    && (area || type || level || channel || query || discussed || sub || all);

  if (viewName === 'feed' && !isFilteredFeed) {
    headEl.hidden = true;
    return;
  }

  headEl.hidden = false;
  const counts = list.length.toLocaleString('zh-CN');

  let label = '发现';
  if (viewName === 'saved') label = '收藏';
  else if (viewName === 'history') label = '已浏览';
  else {
    const parts = [
      area ? ctx.areaName(area) : '',
      channel,
      type ? typeLabel(type) : '',
      level ? levelLabel(level, { includeGeneral: true }) : '',
      sub ? '有中文字幕' : '',
      discussed ? '有中文讨论' : '',
      query ? `“${query}”` : '',
      !area && !type && !level && !channel && !discussed && !sub && !query && all ? '全部内容' : '',
    ].filter(Boolean);
    label = parts.join(' · ') || '发现';
  }

  titleEl.textContent = label;
  countEl.textContent = `${counts} 个视频`;
  headActionEl.replaceChildren();

  if (viewName === 'feed' && isFilteredFeed) {
    headActionEl.append(el('button', {
      class: 'head-reset',
      type: 'button',
      on: {
        click: () => {
          params = new URLSearchParams();
          sync();
        },
      },
    }, '清除筛选'));
  } else if (viewName === 'history' && list.length > 0) {
    headActionEl.append(el('button', {
      class: 'head-reset',
      type: 'button',
      on: {
        click: () => {
          store.clear('visited');
          toast('已清空浏览记录');
          apply();
        },
      },
    }, '清空记录'));
  }
}

export function destroy() {
  observer?.disconnect();
}
