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
  titleEl = el('h1', {});
  countEl = el('p', { class: 'count' });
  headActionEl = el('div', { class: 'head-actions' });
  headEl = el('div', { class: 'feed-head' }, titleEl, countEl, headActionEl);
  subHitsEl = el('section', { class: 'sub-hits', hidden: true, 'aria-label': '字幕全文搜索结果' });
  grid = el('div', { class: 'grid' });
  sentinel = el('div', { class: 'sentinel' });
  container.replaceChildren(
    el('section', { class: 'feed' },
      chipsBarEl,
      headEl,
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
  const progress = store.getProgress(video.vid);
  const hasResume = progress?.t >= 5 && (!progress.d || progress.t < progress.d - 12);

  if (viewName === 'history' && hasResume) {
    thumbNode.append(el('span', { class: 'badge-visited' }, `看到 ${formatClock(progress.t)}`));
  } else if (visitedSet.has(video.vid) && viewName !== 'history') {
    thumbNode.append(el('span', { class: 'badge-visited' },
      hasResume ? `已看 ${formatClock(progress.t)}` : '已看'));
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
      toast('已恢复收藏与浏览记录');
      apply(shown);
    } catch {
      toast('备份文件格式有误');
    }
  });
  document.body.append(input);
  input.click();
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
