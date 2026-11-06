const TYPE_LABELS = {
  talk: '演讲',
  lecture: '课程',
  course: '系列课',
  explainer: '讲解',
  documentary: '纪录片',
  interview: '访谈',
  demo: '演示',
  tutorial: '教程',
  podcast: '播客',
  commentary: '评论',
  news: '新闻',
  comedy: '喜剧',
  music: '音乐',
  other: '其他',
};

const LEVEL_LABELS = {
  intro: '入门',
  intermediate: '进阶',
  advanced: '深入',
  general: '通识',
};

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function initial(name) {
  const text = String(name || '?').trim();
  return text ? text[0].toUpperCase() : '?';
}

function hueFor(name) {
  let hue = 0;
  for (const char of String(name || '')) {
    hue = (hue * 31 + char.codePointAt(0)) % 360;
  }
  return hue;
}

export function avatar(name, extraClass = '') {
  const node = el('span', {
    class: ['avatar', extraClass].filter(Boolean).join(' '),
    'aria-hidden': 'true',
  }, initial(name));
  const hue = hueFor(name);
  node.style.setProperty('--avatar-hue', String(hue));
  return node;
}

export function thumb(video, { className = '', size = 'hqdefault' } = {}) {
  const box = el('div', { class: ['thumb', className].filter(Boolean).join(' ') });
  if (!video?.vid) {
    box.classList.add('thumb-fallback');
    box.append(el('span', {}, '?'));
    return box;
  }
  const img = el('img', {
    src: `https://i.ytimg.com/vi/${video.vid}/${size}.jpg`,
    alt: '',
    loading: 'lazy',
    width: 480,
    height: 270,
  });
  img.addEventListener('error', () => {
    img.remove();
    box.classList.add('thumb-fallback');
    box.append(el('span', {}, initial(video.channel)));
  }, { once: true });
  box.append(img);
  return box;
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

export function progressPercent(progress) {
  if (!progress || !progress.t || progress.t < 5) return 0;
  if (progress.d && progress.d > 0) {
    if (progress.t >= progress.d - 10) return 100;
    return Math.min(98, Math.max(4, Math.round((progress.t / progress.d) * 100)));
  }
  return Math.min(85, Math.max(8, Math.round((progress.t / 1800) * 100)));
}

export function thumbProgress(progress) {
  const pct = progressPercent(progress);
  if (!pct) return null;
  const label = pct >= 100 ? '已看完' : `已看到 ${formatClock(progress.t)}`;
  const fill = el('span', { class: 'thumb-progress-fill' });
  fill.style.width = `${pct}%`;
  return el('div', {
    class: 'thumb-progress',
    title: label,
    'aria-hidden': 'true',
  }, fill);
}

export function typeLabel(value) {
  return TYPE_LABELS[value] || value || '';
}

export function levelLabel(value, { includeGeneral = false } = {}) {
  if (!includeGeneral && value === 'general') return '';
  return LEVEL_LABELS[value] || '';
}

export function yearRange(video) {
  if (!video?.first_year) return '';
  return video.first_year === video.last_year
    ? String(video.first_year)
    : `${video.first_year}–${video.last_year}`;
}

export function metaLine(video) {
  const recommenders = Number(video?.recommenders || 0);
  const parts = [recommenders > 0 ? `${recommenders} 人推荐` : '仅被引用'];
  const years = yearRange(video);
  if (years) parts.push(years);
  return parts.join(' · ');
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

let toastTimer;

export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}
