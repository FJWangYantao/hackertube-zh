import { el, avatar } from './ui.js';

const STANCE = {
  strong_rec: { label: '强烈推荐', cls: 's-strong' },
  rec: { label: '推荐', cls: 's-rec' },
  reference: { label: '引用', cls: 's-ref' },
  joke: { label: '玩笑', cls: 's-joke' },
  critical: { label: '不同意见', cls: 's-crit' },
};

const ORDER = { strong_rec: 0, rec: 1, reference: 2, critical: 3, joke: 4 };

const GROUPS = [
  ['all', '全部'],
  ['rec', '推荐'],
  ['critical', '不同意见'],
  ['reference', '引用'],
  ['joke', '玩笑'],
];

const TS_RE = /(?<![0-9:/-])\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b(?![0-9:/-])/g;

function renderCommentText(container, text, onSeek) {
  if (!text || typeof onSeek !== 'function') {
    container.textContent = text || '';
    return;
  }
  TS_RE.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = TS_RE.exec(text)) !== null) {
    if (match.index > last) {
      container.append(document.createTextNode(text.slice(last, match.index)));
    }
    const label = match[0];
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    const btn = el('button', {
      class: 'comment-ts',
      type: 'button',
      title: `跳转到视频 ${label}`,
      on: {
        click: (event) => {
          event.stopPropagation();
          onSeek(totalSeconds);
        },
      },
    }, label);
    container.append(btn);
    last = match.index + label.length;
  }
  if (last === 0) {
    container.textContent = text;
  } else if (last < text.length) {
    container.append(document.createTextNode(text.slice(last)));
  }
}

export function renderComments(container, payload, onSeek = null) {
  const comments = payload?.comments || [];
  container.replaceChildren();

  if (!comments.length) {
    container.append(
      el('div', { class: 'comments-head' }, el('h2', {}, '讨论')),
      el('p', { class: 'muted' }, '这个视频还没有中文讨论。'),
    );
    return;
  }

  let sort = 'rec';
  let filter = 'all';
  const counts = countGroups(comments);

  const filters = el('div', { class: 'comment-filters' });
  const filterButtons = GROUPS
    .filter(([key]) => key === 'all' || counts[key])
    .map(([key, label]) => ({
      key,
      node: el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': key === filter ? 'true' : 'false',
        on: {
          click: () => {
            filter = key;
            syncButtons(filterButtons, filter);
            draw();
          },
        },
      }, `${label} ${key === 'all' ? comments.length : counts[key]}`),
    }));
  filters.append(...filterButtons.map((item) => item.node));

  const sortWrap = el('div', { class: 'comment-sort' });
  const sortButtons = [
    ['rec', '推荐优先'],
    ['new', '最新'],
  ].map(([key, label]) => ({
    key,
    node: el('button', {
      class: 'sort-pill',
      type: 'button',
      'aria-pressed': key === sort ? 'true' : 'false',
      on: {
        click: () => {
          sort = key;
          syncButtons(sortButtons, sort);
          draw();
        },
      },
    }, label),
  }));
  sortWrap.append(...sortButtons.map((item) => item.node));

  container.append(
    el('div', { class: 'comments-head' },
      el('h2', {}, `${comments.length} 条讨论`),
      el('span', { class: 'comments-sub' }, '摘自 Hacker News 历年讨论帖 · 机器翻译'),
      sortWrap,
    ),
    filters,
  );

  const list = el('div', { class: 'comment-list' });
  container.append(list);

  draw();

  function draw() {
    const rows = comments
      .filter((comment) => inGroup(comment, filter))
      .sort((a, b) => {
        if (sort === 'new') return String(b.month).localeCompare(String(a.month));
        return (ORDER[a.stance] ?? 9) - (ORDER[b.stance] ?? 9)
          || String(b.month).localeCompare(String(a.month));
      });
    list.replaceChildren(...rows.map((comment) => commentCard(comment, onSeek)));
    if (!rows.length) list.append(el('p', { class: 'muted' }, '这一组没有评论。'));
  }
}

function syncButtons(items, active) {
  for (const item of items) {
    item.node.setAttribute('aria-pressed', item.key === active ? 'true' : 'false');
  }
}

function inGroup(comment, group) {
  if (group === 'all') return true;
  if (group === 'rec') return comment.stance === 'rec' || comment.stance === 'strong_rec';
  return comment.stance === group;
}

function countGroups(comments) {
  const counts = { rec: 0, critical: 0, reference: 0, joke: 0 };
  for (const comment of comments) {
    if (comment.stance === 'rec' || comment.stance === 'strong_rec') counts.rec += 1;
    else if (comment.stance in counts) counts[comment.stance] += 1;
  }
  return counts;
}

function commentCard(comment, onSeek) {
  const meta = STANCE[comment.stance] || { label: comment.stance || '评论', cls: 's-ref' };
  const text = comment.text_zh || comment.text || '';
  const english = comment.text || '';
  const long = text.length > 160;

  const body = el('div', { class: 'comment-body' },
    el('div', { class: 'comment-head' },
      el('span', { class: 'comment-author' }, comment.author || '匿名'),
      el('span', { class: 'comment-date' }, comment.month || ''),
      el('span', { class: `stance ${meta.cls}` }, meta.label),
    ),
  );

  const zh = el('p', { class: 'comment-text' + (long ? ' clamped' : '') });
  renderCommentText(zh, text, onSeek);
  body.append(zh);

  let en = null;
  if (english && english !== text) {
    en = el('p', { class: 'comment-text', hidden: true });
    renderCommentText(en, english, onSeek);
    body.append(en);
  }

  const actions = el('div', { class: 'comment-actions' });
  if (long) {
    const toggle = el('button', { type: 'button' }, '展开');
    toggle.addEventListener('click', () => {
      const clamped = zh.classList.toggle('clamped');
      toggle.textContent = clamped ? '展开' : '收起';
    });
    actions.append(toggle);
  }
  if (en) {
    const toggle = el('button', { type: 'button' }, '查看英文');
    toggle.addEventListener('click', () => {
      en.hidden = !en.hidden;
      toggle.textContent = en.hidden ? '查看英文' : '收起英文';
    });
    actions.append(toggle);
  }
  if (comment.hn_url) {
    actions.append(el('a', {
      href: comment.hn_url,
      target: '_blank',
      rel: 'noopener',
    }, 'HN 原帖'));
  }
  body.append(actions);

  if (comment.story_title) {
    body.append(el('p', { class: 'comment-story' }, `讨论帖：${comment.story_title}`));
  }

  return el('article', { class: 'comment' }, avatar(comment.author), body);
}
