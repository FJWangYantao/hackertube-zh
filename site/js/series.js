import { el, avatar, thumb } from './ui.js';
import { seriesData, store } from './data.js';
import { replace } from './router.js';

const EP_PREVIEW = 4;
const KIND_LABELS = { numbered: '编号课程', shared: '专题系列' };

/**
 * #/series 合集浏览页：卡片封面 + 已看进度 + 前几集快捷跳转。
 * @param {HTMLElement} container
 * @param {{view: string, params: URLSearchParams}} route
 * @param {{feedIndex: Map<string, object>}} ctx
 */
export function showSeriesList(container, route, ctx, restored = null) {
  const params = new URLSearchParams(route.params);
  let kind = ['numbered', 'shared'].includes(params.get('kind')) ? params.get('kind') : '';
  let keyword = (params.get('q') || '').trim();

  const titleEl = el('h1', { class: 'series-page-head' }, '系列合集');
  const countEl = el('p', { class: 'series-page-count' }, '正在加载合集…');
  const searchInput = el('input', {
    class: 'series-search',
    type: 'search',
    placeholder: '按合集或频道名过滤…',
    value: keyword,
    'aria-label': '过滤合集',
    autocomplete: 'off',
  });
  const chipsEl = el('div', { class: 'series-kinds', role: 'group', 'aria-label': '按合集类型筛选' });
  const grid = el('div', { class: 'series-grid' });
  const shell = el('section', { class: 'series-page' },
    el('div', { class: 'series-toolbar' }, titleEl, countEl),
    el('div', { class: 'series-filters' }, searchInput, chipsEl),
    grid,
  );
  container.replaceChildren(shell);

  let all = [];
  let debounceTimer = 0;

  function syncUrl() {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    if (keyword) q.set('q', keyword);
    const query = q.toString();
    replace(`/series${query ? '?' + query : ''}`);
  }

  function visibleSeries() {
    const kw = keyword.toLowerCase();
    return all.filter((series) => {
      if (kind && series.kind !== kind) return false;
      if (kw && !`${series.title || ''} ${series.channel || ''}`.toLowerCase().includes(kw)) {
        return false;
      }
      return true;
    });
  }

  function renderChips() {
    const chips = [
      kindChip('全部', !kind, () => { kind = ''; render(); syncUrl(); }),
      kindChip(KIND_LABELS.numbered, kind === 'numbered', () => { kind = 'numbered'; render(); syncUrl(); }),
      kindChip(KIND_LABELS.shared, kind === 'shared', () => { kind = 'shared'; render(); syncUrl(); }),
    ];
    chipsEl.replaceChildren(...chips);
  }

  function kindChip(label, pressed, onClick) {
    return el('button', {
      class: 'chip series-kind-chip',
      type: 'button',
      'aria-pressed': pressed ? 'true' : 'false',
      on: { click: onClick },
    }, label);
  }

  function seriesCard(series) {
    const vids = Array.isArray(series.vids) ? series.vids : [];
    if (!vids.length) return null;
    const visitedSet = new Set(store.list('visited'));
    const watched = vids.filter((vid) => visitedSet.has(vid)).length;
    const resumeIdx = vids.findIndex((vid) => !visitedSet.has(vid));
    const startIdx = resumeIdx >= 0 ? resumeIdx : 0;
    const startVid = vids[startIdx];
    const pct = Math.round((watched / vids.length) * 100);
    const kindLabel = KIND_LABELS[series.kind] || '合集';

    const firstRow = ctx.feedIndex.get(vids[0]);
    const coverInner = firstRow
      ? thumb(firstRow, { className: 'series-cover-thumb' })
      : el('div', { class: 'thumb thumb-fallback series-cover-thumb' },
        el('span', {}, (series.channel || '?')[0]?.toUpperCase() || '?'));
    const cover = el('a', {
      class: 'series-cover',
      href: `#/video/${startVid}`,
      title: resumeIdx > 0 ? `继续看第 ${startIdx + 1} 集` : '从第 1 集开始',
    },
      coverInner,
      el('span', { class: 'series-count-badge' }, `共 ${vids.length} 集`),
      pct > 0 ? el('span', { class: 'series-cover-progress', 'aria-hidden': 'true' },
        el('span', { class: 'series-cover-progress-fill' }, ''),
      ) : null,
    );
    if (pct > 0) {
      const fill = cover.querySelector('.series-cover-progress-fill');
      if (fill) fill.style.width = `${pct}%`;
    }

    const eps = vids.slice(0, EP_PREVIEW).map((vid, i) => {
      const row = ctx.feedIndex.get(vid);
      const label = row ? (row.title_zh || row.title) : `第 ${i + 1} 集`;
      return el('a', {
        class: 'series-ep-link' + (visitedSet.has(vid) ? ' is-watched' : ''),
        href: `#/video/${vid}`,
        title: `第 ${i + 1} 集 · ${label}`,
      },
        el('span', { class: 'series-ep-no' }, String(i + 1)),
        el('span', { class: 'series-ep-name' }, label),
      );
    });
    if (vids.length > EP_PREVIEW) {
      eps.push(el('a', { class: 'series-ep-link series-eps-more', href: `#/video/${startVid}` },
        `… 全部 ${vids.length} 集`));
    }

    const startLabel = resumeIdx === 0
      ? '从第 1 集开始'
      : resumeIdx > 0 ? `继续看第 ${startIdx + 1} 集` : '再看一遍';

    return el('article', { class: 'series-card' },
      cover,
      el('div', { class: 'series-body' },
        el('div', { class: 'series-title-row' },
          el('a', { class: 'series-card-title', href: `#/video/${startVid}`, title: series.title },
            series.title || '未命名合集'),
          el('span', { class: 'series-kind-tag' }, kindLabel),
        ),
        series.channel ? el('a', {
          class: 'series-channel',
          href: `#/feed?channel=${encodeURIComponent(series.channel)}`,
          title: `查看「${series.channel}」的全部视频`,
        }, avatar(series.channel, 'xs'), el('span', {}, series.channel)) : null,
        el('div', { class: 'series-eps' }, ...eps),
        el('div', { class: 'series-foot' },
          el('span', { class: 'series-watched' }, `已看 ${watched} / ${vids.length} 集`),
          el('a', { class: 'btn series-start', href: `#/video/${startVid}` }, startLabel),
        ),
      ),
    );
  }

  function render() {
    renderChips();
    const list = visibleSeries();
    countEl.textContent = `共 ${list.length} 个合集`;
    if (!list.length) {
      grid.replaceChildren(el('div', { class: 'empty' },
        el('h2', {}, '没有匹配的合集'),
        el('p', {}, '换个关键词，或清除类型筛选。'),
      ));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const series of list) {
      const card = seriesCard(series);
      if (card) fragment.append(card);
    }
    grid.replaceChildren(fragment);
  }

  searchInput.addEventListener('input', () => {
    keyword = searchInput.value.trim();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      render();
      syncUrl();
    }, 200);
  });

  seriesData().then(({ byId }) => {
    all = [...byId.values()].filter((series) => Array.isArray(series.vids) && series.vids.length >= 2);
    render();
    if (restored?.scrollY > 0) {
      window.scrollTo({ top: restored.scrollY, behavior: 'instant' });
    }
  });

  return {
    refresh() {
      if (all.length) render();
    },
    destroy() {
      clearTimeout(debounceTimer);
    },
  };
}

/**
 * Resolve the 合集 (series) a video belongs to.
 * @returns {Promise<{series: {id: string, title: string, vids: string[]}, index: number} | null>}
 */
export async function loadSeriesFor(vid) {
  if (!vid) return null;
  const { byVid, byId } = await seriesData();
  const id = byVid.get(vid);
  const series = id ? byId.get(id) : null;
  if (!series || !Array.isArray(series.vids) || series.vids.length < 2) return null;
  const index = series.vids.indexOf(vid);
  if (index < 0) return null;
  return { series, index };
}

/** 合集里的下一集 vid；已是最后一集则返回 null。 */
export function nextEpisode({ series, index }) {
  if (!series || !Array.isArray(series.vids)) return null;
  return series.vids[index + 1] || null;
}

/**
 * Horizontal strip of numbered episode chips for the watch page.
 * @param {{series: object, index: number}} info
 * @param {{feedIndex: Map<string, object>}} ctx
 */
export function buildSeriesPanel({ series, index }, ctx) {
  const total = series.vids.length;
  const items = series.vids.map((vid, i) => {
    const row = ctx.feedIndex.get(vid);
    const label = row ? (row.title_zh || row.title) : `第 ${i + 1} 集`;
    const link = el('a', {
      class: 'series-ep' + (i === index ? ' is-current' : ''),
      href: `#/video/${vid}`,
      title: `第 ${i + 1} 集 · ${label}`,
      role: 'listitem',
      'aria-current': i === index ? 'true' : null,
    },
      el('span', { class: 'series-ep-no' }, String(i + 1)),
      el('span', { class: 'series-ep-title' }, label),
    );
    if (i === index) {
      requestAnimationFrame(() => link.scrollIntoView({ block: 'nearest', inline: 'center' }));
    }
    return link;
  });
  return el('section', { class: 'watch-series', 'aria-label': `合集 ${series.title}` },
    el('div', { class: 'series-head' },
      el('h2', { class: 'series-title' }, `合集：${series.title}`),
      el('span', { class: 'series-pos' }, `第 ${index + 1} / ${total} 集`),
    ),
    el('div', { class: 'series-strip', role: 'list' }, ...items),
  );
}
