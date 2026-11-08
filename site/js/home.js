import {
  el, thumb, avatar, metaLine, typeLabel, levelLabel, toast, formatClock, thumbProgress,
} from './ui.js';
import { store } from './data.js';
import { replace } from './router.js';
import { renderHighlighted, escapeRegExp } from './subtitles.js';
import { searchSubtitles } from './subsearch.js';

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
let subChipsEl;
let channelHeroEl;
let levelEl;
let sortEl;
let headEl;
let titleEl;
let countEl;
let headActionEl;
let grid;
let sentinel;
let observer;
let subHitsEl;
let subHitsToken = 0;
let railsEl;

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
  return {
    setQuery,
    getShown: () => shown,
    getList: () => list,
    destroy,
    refresh,
  };
}

function renderShell() {
  chipsEl = el('div', { class: 'chips', role: 'group', 'aria-label': '按类型与讨论筛选' });
  levelEl = el('select', { class: 'sort', id: 'level-filter', name: 'level', 'aria-label': '按难度筛选' },
    el('option', { value: '' }, '全部难度'),
    el('option', { value: 'intro' }, '难度：入门'),
    el('option', { value: 'intermediate' }, '难度：进阶'),
    el('option', { value: 'advanced' }, '难度：深入'),
    el('option', { value: 'general' }, '难度：通识'),
  );
  levelEl.addEventListener('change', () => {
    setParam('level', levelEl.value);
  });

  sortEl = el('select', { class: 'sort', id: 'sort', name: 'sort', 'aria-label': '排序' },
    el('option', { value: 'score' }, '综合排序'),
    el('option', { value: 'recommenders' }, '推荐人数'),
    el('option', { value: 'last_year' }, '最近提及'),
  );
  sortEl.addEventListener('change', () => {
    setParam('sort', sortEl.value === 'score' ? '' : sortEl.value);
  });

  chipsBarEl = el('div', { class: 'chips-bar' }, chipsEl, levelEl, sortEl);
  subChipsEl = el('div', { class: 'sub-chips', role: 'group', 'aria-label': '二级细分主题', hidden: true });
  channelHeroEl = el('div', { class: 'channel-hero', hidden: true });
  titleEl = el('h1', {});
  countEl = el('p', { class: 'count' });
  headActionEl = el('div', { class: 'head-actions' });
  headEl = el('div', { class: 'feed-head' }, titleEl, countEl, headActionEl);
  subHitsEl = el('section', { class: 'sub-hits', hidden: true, 'aria-label': '字幕全文搜索结果' });
  railsEl = el('div', { class: 'home-rails', hidden: true });
  grid = el('div', { class: 'grid' });
  sentinel = el('div', { class: 'sentinel' });
  container.replaceChildren(
    el('section', { class: 'feed' },
      chipsBarEl,
      subChipsEl,
      channelHeroEl,
      headEl,
      railsEl,
      subHitsEl,
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
  buildSubChips();
  renderHomeRails();
  levelEl.value = params.get('level') || '';
  sortEl.value = params.get('sort') || 'score';
  list = buildList();
  shown = 0;
  renderBatch(true, initialCount);
  updateHead();
  scheduleSubHits();
  observer.disconnect();
  observer.observe(sentinel);
  ctx.syncNav?.(viewName, params);
}

/** Recompute the list after more rows arrive, keeping the current position. */
function refresh() {
  const keep = Math.max(shown, PAGE);
  buildSubChips();
  renderHomeRails();
  list = buildList();
  shown = 0;
  renderBatch(true, keep);
  updateHead();
  // renderBatch rebuilt the grid (and its empty state), so re-run the
  // subtitle search to restore its results and empty-state copy.
  scheduleSubHits();
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
  const cat = params.get('cat') || '';
  const hasFilter = Boolean(area || type || level || discussed || sub || channel || cat);

  const chips = [
    chipButton('全部', !hasFilter, () => {
      params.delete('area');
      params.delete('type');
      params.delete('level');
      params.delete('discussed');
      params.delete('sub');
      params.delete('channel');
      params.delete('cat');
      sync();
    }),
  ];

  if (area) {
    chips.push(chipButton(`${ctx.areaName(area) || area} ×`, true, () => {
      params.delete('area');
      params.delete('cat');
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

/** 领域（area）下的二级分类下钻栏：仅当 URL 带 area 时展开。 */
function buildSubChips() {
  const area = params.get('area') || '';
  const cat = params.get('cat') || '';
  if (viewName !== 'feed' || !area) {
    subChipsEl.hidden = true;
    subChipsEl.replaceChildren();
    return;
  }
  const areaMeta = (ctx.meta?.areas || []).find((entry) => entry.id === area);
  const categories = areaMeta?.categories || [];
  const includeAll = params.get('all') === '1';
  const counts = new Map();
  if (categories.length) {
    for (const video of ctx.feed) {
      if (video.area !== area) continue;
      if (!includeAll && ((video.recommenders || 0) <= 0 || video.shelf_life === 'news')) {
        continue;
      }
      for (const name of video.categories || []) {
        if (!categories.includes(name)) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  const rows = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!rows.length) {
    subChipsEl.hidden = true;
    subChipsEl.replaceChildren();
    return;
  }
  subChipsEl.replaceChildren(
    subChip('全部细分', !cat, () => {
      params.delete('cat');
      sync();
    }),
    ...rows.map(([name, n]) => subChip(`${name} ${n}`, cat === name, () => {
      if (cat === name) params.delete('cat');
      else params.set('cat', name);
      sync();
    })),
  );
  subChipsEl.hidden = false;
}

function subChip(label, pressed, onClick) {
  return el('button', {
    class: 'chip sub-chip',
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
  const cat = params.get('cat') || '';
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
  if (cat) rows = rows.filter((video) => (video.categories || []).includes(cat));
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

/** 首页个性化横排：继续观看 + 猜你想看（仅未筛选的默认 feed 显示）。 */
function renderHomeRails() {
  railsEl.hidden = true;
  railsEl.replaceChildren();
  const isDefaultFeed = viewName === 'feed'
    && ![...params.keys()].some((key) => key !== 'sort');
  if (!isDefaultFeed) return;
  const sections = [buildContinueRail(), buildForYouRail()].filter(Boolean);
  if (!sections.length) return;
  railsEl.replaceChildren(...sections);
  railsEl.hidden = false;
}

/** 没看完的视频，按最近观看排序。 */
function buildContinueRail() {
  const entries = store.list('visited')
    .map((vid) => {
      const progress = store.getProgress(vid);
      const video = ctx.feedIndex.get(vid);
      return video && progress?.t >= 60 && (!progress.d || progress.t < progress.d - 30)
        ? { video, updated: progress.u || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 8);
  if (!entries.length) return null;
  return homeRail('继续观看', entries.map(({ video }) => card(video)),
    { href: '#/history', label: '查看全部' });
}

/** 基于最近浏览的频道/领域/类型亲和度，给没看过的视频打分（全部本地计算）。 */
function buildForYouRail() {
  const visitedIds = store.list('visited');
  if (visitedIds.length < 3) return null;
  const recent = visitedIds.slice(-40);
  const step = 1 / Math.max(1, recent.length);
  const affinity = new Map();
  const bump = (key, weight) => {
    if (key) affinity.set(key, (affinity.get(key) || 0) + weight);
  };
  recent.forEach((vid, i) => {
    const video = ctx.feedIndex.get(vid);
    if (!video) return;
    const w = 1 + i * step; // 越近期权重越高
    bump(`c:${video.channel}`, 3 * w);
    bump(`a:${video.area}`, 2 * w);
    bump(`t:${video.content_type}`, 1 * w);
    bump(`l:${video.level}`, 1 * w);
  });
  const affinityOf = (video) => (affinity.get(`c:${video.channel}`) || 0)
    + (affinity.get(`a:${video.area}`) || 0)
    + (affinity.get(`t:${video.content_type}`) || 0)
    + (affinity.get(`l:${video.level}`) || 0);
  const picks = ctx.feed
    .filter((video) => (video.recommenders || 0) > 0
      && video.shelf_life !== 'news' && !visitedSet.has(video.vid))
    .map((video) => {
      const hit = affinityOf(video);
      return {
        video,
        hit,
        rank: hit + (video.has_sub ? 2 : 0) + Math.log10(1 + (video.score || 0)) * 0.5,
      };
    })
    .filter((row) => row.hit > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 12);
  if (picks.length < 4) return null;
  return homeRail('猜你想看', picks.map(({ video }) => card(video)),
    { note: '按浏览记录本地生成' });
}

/** 一条横向滚动的卡片栏。 */
function homeRail(title, cards, { href = '', label = '', note = '' } = {}) {
  return el('section', { class: 'home-rail', 'aria-label': title },
    el('div', { class: 'rail-head' },
      el('h2', { class: 'rail-title' }, title),
      note ? el('span', { class: 'rail-note' }, note) : null,
      href ? el('a', { class: 'rail-more', href }, label) : null,
    ),
    el('div', { class: 'rail-scroll' }, ...cards),
  );
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
  const thumbNode = thumb(video, { storyboard: true });
  const progress = store.getProgress(video.vid);
  const hasResume = progress?.t >= 5 && (!progress.d || progress.t < progress.d - 12);

  if (viewName === 'history' && hasResume) {
    thumbNode.append(el('span', { class: 'badge-visited' }, `看到 ${formatClock(progress.t)}`));
  } else if (visitedSet.has(video.vid) && viewName !== 'history') {
    thumbNode.append(el('span', { class: 'badge-visited' },
      hasResume ? `已看 ${formatClock(progress.t)}` : '已看'));
  }

  const badges = el('div', { class: 'thumb-badges' });
  const sInfo = ctx.seriesInfo?.(video.vid);
  if (sInfo) {
    badges.append(el('span', {
      class: 'badge badge-series',
      title: `所属合集：${sInfo.series.title}（第 ${sInfo.index + 1} / ${sInfo.total} 集）`,
    }, `合集 ${sInfo.index + 1}/${sInfo.total}`));
  }
  if (video.has_sub) {
    badges.append(el('span', { class: 'badge badge-sub', title: '站内提供中英双语字幕' }, '中字'));
  }
  if (video.comment_count > 0) {
    badges.append(el('span', { class: 'badge' }, `${video.comment_count} 条讨论`));
  }
  if (badges.childElementCount > 0) {
    thumbNode.append(badges);
  }

  const progBar = thumbProgress(progress);
  if (progBar) thumbNode.append(progBar);

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
      el('div', { class: 'card-text' },
        el('h3', { class: 'card-title' }, video.title_zh || video.title),
        el('p', { class: 'card-channel' },
          avatar(video.channel, 'xs'),
          el('span', { class: 'card-channel-name' }, video.channel || ''),
        ),
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

  const cardEl = el('article', { class: 'card' }, link, saveBtn);
  cardEl.addEventListener('pointermove', (e) => {
    const rect = cardEl.getBoundingClientRect();
    cardEl.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
    cardEl.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
  });
  return cardEl;
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

function emptyIllustration(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (kind === 'saved') {
    path.setAttribute('d', 'M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z');
  } else if (kind === 'history') {
    path.setAttribute('d', 'M12 7.5V12l3.2 2M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z');
  } else {
    path.setAttribute('d', 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1.5 4.5 4.5');
  }
  svg.append(path);
  return el('div', { class: 'empty-art', 'aria-hidden': 'true' }, svg);
}

function emptyState() {
  const copy = {
    saved: ['还没有收藏', '把鼠标移到视频卡片右上角，或进入观看页点「收藏」即可保存。'],
    history: ['还没有浏览记录', '点开过的视频会自动记录在这里。'],
    feed: ['没有匹配的内容', '换一个关键词，或清除当前的筛选条件。'],
  }[viewName] || ['没有内容', ''];
  const wrap = el('div', { class: 'empty' },
    emptyIllustration(viewName),
    el('h2', {}, copy[0]),
    el('p', {}, copy[1]));
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

function exportUserData() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    saved: store.list('saved'),
    visited: store.list('visited'),
    progress: store.get('progress', {}),
    notes: store.get('notes', {}),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', {
    href: url,
    download: `hackertube-zh-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('已导出个人数据备份');
}

function triggerImportUserData() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data.saved)) {
        const mergedSaved = [...new Set([...data.saved, ...store.list('saved')])];
        store.set('saved', mergedSaved.slice(0, 1000));
      }
      if (Array.isArray(data.visited)) {
        const mergedVisited = [...new Set([...data.visited, ...store.list('visited')])];
        store.set('visited', mergedVisited.slice(0, 500));
      }
      if (data.progress && typeof data.progress === 'object') {
        const currentProg = store.get('progress', {});
        store.set('progress', { ...data.progress, ...currentProg });
      }
      if (data.notes && typeof data.notes === 'object' && !Array.isArray(data.notes)) {
        const currentNotes = store.get('notes', {});
        const mergedNotes = { ...currentNotes };
        for (const [vid, rows] of Object.entries(data.notes)) {
          if (!Array.isArray(rows)) continue;
          const known = new Set((mergedNotes[vid] || []).map((note) => note.id));
          const additions = rows.filter((note) => note && note.id && !known.has(note.id));
          if (additions.length) mergedNotes[vid] = [...(mergedNotes[vid] || []), ...additions];
        }
        store.set('notes', mergedNotes);
      }
      toast('已恢复收藏、记录与随手记');
      apply(shown);
    } catch {
      toast('备份文件格式有误');
    }
  });
  document.body.append(input);
  input.click();
}

/** 频道聚合页头部卡片：聚合统计 + 领域徽章 + 快捷过滤。 */
function buildChannelHero() {
  const channel = viewName === 'feed' ? (params.get('channel') || '') : '';
  const includeAll = params.get('all') === '1';
  const channelVideos = channel
    ? ctx.feed.filter((video) => video.channel === channel
      && (includeAll || ((video.recommenders || 0) > 0 && video.shelf_life !== 'news')))
    : [];
  if (!channel || !channelVideos.length) {
    channelHeroEl.hidden = true;
    channelHeroEl.replaceChildren();
    return;
  }

  const totalRecs = channelVideos.reduce((sum, video) => sum + (video.recommenders || 0), 0);
  const subCount = channelVideos.filter((video) => video.has_sub).length;
  const firstYears = channelVideos.map((video) => video.first_year).filter(Boolean);
  const lastYears = channelVideos.map((video) => video.last_year).filter(Boolean);
  const yearSpan = firstYears.length
    ? `${Math.min(...firstYears)}–${Math.max(...(lastYears.length ? lastYears : firstYears))}`
    : '';
  const areaCounts = new Map();
  for (const video of channelVideos) {
    if (!video.area) continue;
    areaCounts.set(video.area, (areaCounts.get(video.area) || 0) + 1);
  }
  const topAreas = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const stat = (num, label) => el('div', { class: 'hero-stat' },
    el('span', { class: 'hero-stat-num' }, num),
    el('span', { class: 'hero-stat-label' }, label));

  const sub = params.get('sub') === '1';
  const subBtn = el('button', {
    class: 'chip hero-chip',
    type: 'button',
    'aria-pressed': sub ? 'true' : 'false',
    on: {
      click: () => {
        if (sub) params.delete('sub');
        else params.set('sub', '1');
        sync();
      },
    },
  }, sub ? '看全部视频' : `仅看有中字 (${subCount})`);
  const clearBtn = el('button', {
    class: 'chip hero-chip',
    type: 'button',
    on: {
      click: () => {
        params = new URLSearchParams();
        sync();
      },
    },
  }, '清除筛选');

  channelHeroEl.replaceChildren(
    avatar(channel, 'xl'),
    el('div', { class: 'hero-main' },
      el('h1', { class: 'hero-title' }, channel),
      el('div', { class: 'hero-stats' },
        stat(channelVideos.length.toLocaleString('zh-CN'), '收录视频'),
        stat(totalRecs.toLocaleString('zh-CN'), 'HN 推荐人次'),
        stat(`${subCount}/${channelVideos.length}`, '中文字幕覆盖'),
        yearSpan ? stat(yearSpan, '活跃年份') : null,
      ),
      topAreas.length ? el('div', { class: 'hero-areas' },
        ...topAreas.map(([id, n]) => el('a', {
          class: 'hero-area-badge',
          href: `#/feed?area=${encodeURIComponent(id)}`,
          title: `切换到「${ctx.areaName(id) || id}」领域`,
        }, `${ctx.areaName(id) || id} · ${n}`)),
      ) : null,
    ),
    el('div', { class: 'hero-actions' }, subBtn, clearBtn),
  );
  channelHeroEl.hidden = false;
}

function updateHead() {
  const area = params.get('area') || '';
  const type = params.get('type') || '';
  const level = params.get('level') || '';
  const channel = params.get('channel') || '';
  const cat = params.get('cat') || '';
  const query = (params.get('q') || '').trim();
  const discussed = params.get('discussed') === '1';
  const sub = params.get('sub') === '1';
  const all = params.get('all') === '1';
  const isFilteredFeed = viewName === 'feed'
    && (area || type || level || channel || cat || query || discussed || sub || all);

  buildChannelHero();

  if (viewName === 'feed' && !channelHeroEl.hidden) {
    // 频道聚合页：hero 卡片自带统计与清除按钮，替代常规头部。
    headEl.hidden = true;
    return;
  }

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
      cat,
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
  } else if (viewName === 'saved') {
    if (list.length > 0) {
      headActionEl.append(el('button', {
        class: 'head-reset',
        type: 'button',
        title: '导出收藏与观看记录（JSON）',
        on: { click: exportUserData },
      }, '导出备份'));
    }
    headActionEl.append(el('button', {
      class: 'head-reset',
      type: 'button',
      title: '从备份 JSON 文件恢复收藏与记录',
      on: { click: triggerImportUserData },
    }, '导入恢复'));
  } else if (viewName === 'history' && list.length > 0) {
    headActionEl.append(
      el('button', {
        class: 'head-reset',
        type: 'button',
        title: '导出收藏与观看记录（JSON）',
        on: { click: exportUserData },
      }, '导出备份'),
      el('button', {
        class: 'head-reset',
        type: 'button',
        on: {
          click: () => {
            store.clear('visited');
            store.clearProgress();
            toast('已清空浏览记录与播放进度');
            apply();
          },
        },
      }, '清空记录'),
    );
  }
}

/** Full-text subtitle search box under the feed head; stale async runs are fenced off. */
function scheduleSubHits() {
  const token = ++subHitsToken;
  const query = (params.get('q') || '').trim();
  if (viewName !== 'feed' || query.length < 2) {
    subHitsEl.hidden = true;
    subHitsEl.replaceChildren();
    return;
  }
  subHitsEl.hidden = false;
  subHitsEl.replaceChildren(el('p', { class: 'sub-hits-note muted' }, '正在检索字幕全文…'));
  searchSubtitles(query, ctx)
    .then((result) => {
      if (token !== subHitsToken) return;
      renderSubHits(query, result);
    })
    .catch(() => {
      if (token !== subHitsToken) return;
      subHitsEl.hidden = true;
    });
}

/** Keep the grid's empty state honest when only subtitles matched. */
function syncEmptyStateForSubHits(result) {
  const empty = grid.querySelector('.empty');
  if (!empty || !result.hits.length) return;
  empty.querySelector('h2').textContent = '标题与导读中没有匹配';
  empty.querySelector('p').textContent = '字幕里找到了相关内容，见上方「字幕命中」。';
  empty.querySelector('.btn')?.remove();
}

function renderSubHits(query, result) {
  const { hits, videoCount, loadedVideos, truncated, unsupported } = result;
  syncEmptyStateForSubHits(result);
  if (!hits.length) {
    subHitsEl.replaceChildren(el('p', { class: 'sub-hits-note muted' },
      unsupported
        ? '关键词太短或为符号，试试更长的英文单词或中文词组'
        : videoCount
          ? `已扫描评分前 ${loadedVideos} 个相关视频的字幕，没有整句同时包含「${query}」`
          : `字幕全文中没有找到「${query}」`));
    return;
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const regex = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  subHitsEl.replaceChildren(
    el('div', { class: 'sub-hits-head' },
      el('h2', { class: 'sub-hits-title' }, '字幕命中'),
      el('span', { class: 'sub-hits-meta muted' },
        `${videoCount} 个视频的字幕提到 · 点击直达时间点`),
      truncated
        ? el('span', { class: 'sub-hits-more muted' }, `按评分扫描前 ${loadedVideos} 个`)
        : null,
    ),
    el('div', { class: 'sub-hits-list' },
      ...hits.map((hit) => subHitRow(hit, regex, terms))),
  );
}

function subHitRow({ video, cue }, regex, terms) {
  // Show the language line that actually contains the query terms (an English
  // query hits the English cue even though the panel is Chinese-first).
  const zh = (cue.zh || '').trim();
  const en = (cue.en || '').trim();
  const hits = (text) => terms.filter((term) => text.toLowerCase().includes(term)).length;
  const zhScore = zh ? hits(zh) : 0;
  const enScore = en ? hits(en) : 0;
  const text = enScore > zhScore ? en : (zhScore > 0 ? zh : (zh || en));
  const line = el('p', { class: 'sub-hit-line' });
  renderHighlighted(line, text, regex);
  return el('a', {
    class: 'sub-hit',
    href: `#/video/${video.vid}?t=${Math.max(0, Math.floor(cue.s || 0))}`,
    title: `${video.title_zh || video.title} · ${formatClock(cue.s || 0)}`,
  },
    thumb(video, { className: 'sub-hit-thumb' }),
    el('div', { class: 'sub-hit-body' },
      el('p', { class: 'sub-hit-title' }, video.title_zh || video.title),
      el('p', { class: 'sub-hit-snippet' },
        el('span', { class: 'sub-hit-ts' }, formatClock(cue.s || 0)),
        line,
      ),
    ),
  );
}

export function destroy() {
  observer?.disconnect();
}
