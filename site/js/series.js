import { el } from './ui.js';
import { seriesData } from './data.js';

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
