import { el, debounce, toast } from './ui.js';
import { load, indexByVid, store } from './data.js';
import { parse } from './router.js';
import * as home from './home.js';
import * as watch from './watch.js';

const view = document.getElementById('view');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchKbd = document.getElementById('search-kbd');
const menuBtn = document.getElementById('menu-btn');
const randomBtn = document.getElementById('random-btn');
const themeBtn = document.getElementById('theme-btn');
const sidebar = document.getElementById('sidebar');
const scrim = document.getElementById('scrim');
const areaNav = document.getElementById('area-nav');
const mobile = window.matchMedia('(max-width: 1000px)');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

const state = {
  feed: [],
  feedIndex: new Map(),
  feedComplete: false,
  meta: { areas: [] },
  areaNames: new Map(),
  mounted: null,
  lastRoute: null,
  lastListKey: '',
  scrollMemory: new Map(),
};

const context = {
  get feed() { return state.feed; },
  get feedIndex() { return state.feedIndex; },
  get feedComplete() { return state.feedComplete; },
  get meta() { return state.meta; },
  areaName: (id) => state.areaNames.get(id) || '',
  setTitle: (title) => { document.title = title; },
  syncNav,
};

async function boot() {
  bindChrome();
  try {
    const [feed, meta] = await Promise.all([load.feed(), load.meta()]);
    state.feed = feed;
    state.feedIndex = indexByVid(feed);
    state.meta = meta;
    state.areaNames = new Map(meta.areas.map((area) => [area.id, area.name_zh]));
  } catch {
    view.replaceChildren(el('div', { class: 'empty' },
      el('h2', {}, '数据加载失败'),
      el('p', {}, '请通过本地服务器打开站点，并先生成 data/feed.json。'),
    ));
    return;
  }
  buildAreaNav();
  window.addEventListener('hashchange', render);
  render();
  loadRemainingFeed();
}

/** Pull the rest of the catalogue in after the first paint. */
async function loadRemainingFeed() {
  try {
    const rest = await load.feedRest();
    if (rest.length) {
      state.feed = [...state.feed, ...rest];
      state.feedIndex = indexByVid(state.feed);
      buildAreaNav();
    }
  } finally {
    state.feedComplete = true;
    state.mounted?.refresh?.();
  }
}

function buildAreaNav() {
  const counts = new Map();
  for (const video of state.feed) {
    if ((video.recommenders || 0) > 0 && video.shelf_life !== 'news') {
      counts.set(video.area, (counts.get(video.area) || 0) + 1);
    }
  }
  areaNav.replaceChildren(...state.meta.areas.map((area) => el('a', {
    class: 'nav-sub',
    href: `#/feed?area=${area.id}`,
    dataset: { area: area.id },
  },
    el('span', { class: 'nav-label' }, area.name_zh),
    el('span', { class: 'nav-count' }, (counts.get(area.id) || 0).toLocaleString('zh-CN')),
  )));
}

function routeKey(route) {
  const q = route.params.toString();
  return `${route.view}${q ? '?' + q : ''}`;
}

function render() {
  const route = parse();
  if (state.lastRoute && state.lastRoute.view !== 'watch') {
    state.scrollMemory.set(state.lastListKey, {
      scrollY: window.scrollY,
      shown: state.mounted?.getShown?.() || 48,
    });
  }
  state.mounted?.destroy?.();
  state.mounted = null;
  closeDrawer(false);
  syncSearch(route);
  syncNav(route.view, route.params);

  if (route.view === 'watch') {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.title = 'HackerTube 中文';
    state.mounted = watch.show(view, route, context) || null;
  } else {
    const key = routeKey(route);
    const returningFromWatch = state.lastRoute?.view === 'watch';
    const restored = returningFromWatch ? state.scrollMemory.get(key) : null;
    state.lastListKey = key;
    document.title = route.view === 'saved'
      ? '收藏 · HackerTube 中文'
      : route.view === 'history'
        ? '已浏览 · HackerTube 中文'
        : 'HackerTube 中文';
    state.mounted = home.show(view, route, context, restored);
    window.scrollTo({ top: restored ? restored.scrollY : 0, behavior: 'instant' });
  }
  state.lastRoute = route;
}

function syncNav(viewName, params) {
  const area = params.get('area') || '';
  const all = params.get('all') === '1';

  document.querySelectorAll('.nav-item').forEach((item) => {
    const key = item.dataset.route;
    const active = key === viewName && !(key === 'feed' && (area || all));
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  const scope = document.querySelector('[data-scope="all"]');
  if (scope) {
    if (viewName === 'feed' && all) scope.setAttribute('aria-current', 'page');
    else scope.removeAttribute('aria-current');
  }

  document.querySelectorAll('.nav-sub').forEach((item) => {
    if (viewName === 'feed' && item.dataset.area === area) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

function syncSearch(route) {
  const query = route.params.get('q') || '';
  if (document.activeElement !== searchInput && searchInput.value !== query) {
    searchInput.value = query;
  }
  syncSearchAffordance();
}

function syncSearchAffordance() {
  const hasValue = Boolean(searchInput.value.trim());
  if (searchClear) searchClear.hidden = !hasValue;
  if (searchKbd) searchKbd.hidden = hasValue;
}

function applySearchValue(raw) {
  const query = raw.trim();
  const current = parse();
  if (current.view === 'feed') {
    state.mounted?.setQuery?.(query);
  } else if (query) {
    location.hash = `#/feed?q=${encodeURIComponent(query)}`;
  }
}

function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return systemDark.matches ? 'dark' : 'light';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  toast(next === 'dark' ? '已切换为深色外观' : '已切换为浅色外观');
}

function openRandomVideo() {
  const current = parse();
  const activeList = state.mounted?.getList?.();
  let pool = Array.isArray(activeList) && activeList.length > 1
    ? activeList
    : state.feed.filter((v) => (v.recommenders || 0) > 0 && v.shelf_life !== 'news');
  if (current.view === 'watch' && current.vid) {
    pool = pool.filter((v) => v.vid !== current.vid);
  }
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  toast(`随机漫游：${pick.title_zh || pick.title}`);
  location.hash = `#/video/${pick.vid}`;
}

function bindChrome() {
  menuBtn.setAttribute('aria-expanded', mobile.matches ? 'false' : 'true');
  setSearchPlaceholder();
  syncSidebarInert();

  randomBtn?.addEventListener('click', openRandomVideo);
  themeBtn?.addEventListener('click', toggleTheme);

  menuBtn.addEventListener('click', () => {
    if (mobile.matches) {
      setDrawer(!sidebar.classList.contains('open'));
    } else {
      const collapsed = document.body.classList.toggle('nav-collapsed');
      menuBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      menuBtn.setAttribute('aria-label', collapsed ? '打开导航' : '收起导航');
    }
  });

  scrim.addEventListener('click', () => closeDrawer(true));

  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (event.key === '/' && !inField && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.key !== 'Escape') return;
    if (document.activeElement === searchInput) {
      if (searchInput.value) {
        searchInput.value = '';
        syncSearchAffordance();
        applySearchValue('');
      } else {
        searchInput.blur();
      }
      return;
    }
    if (sidebar.classList.contains('open')) {
      closeDrawer(true);
    } else if (!mobile.matches && document.body.classList.contains('nav-collapsed')) {
      document.body.classList.remove('nav-collapsed');
      menuBtn.setAttribute('aria-expanded', 'true');
    }
  });

  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeDrawer(false);
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (parse().view === 'feed') {
      state.mounted?.setQuery?.(query);
    } else {
      location.hash = query ? `#/feed?q=${encodeURIComponent(query)}` : '#/';
    }
  });

  const liveSearch = debounce((value) => {
    applySearchValue(value);
  }, 220);
  searchInput.addEventListener('input', (event) => {
    syncSearchAffordance();
    liveSearch(event.target.value);
  });

  searchClear?.addEventListener('click', () => {
    searchInput.value = '';
    syncSearchAffordance();
    applySearchValue('');
    searchInput.focus();
  });

  document.getElementById('skip-link').addEventListener('click', () => {
    view.focus();
    view.scrollIntoView();
  });

  mobile.addEventListener('change', () => {
    closeDrawer(false);
    document.body.classList.remove('nav-collapsed');
    menuBtn.setAttribute('aria-expanded', mobile.matches ? 'false' : 'true');
    menuBtn.setAttribute('aria-label', mobile.matches ? '打开导航' : '收起导航');
    setSearchPlaceholder();
    syncSidebarInert();
  });
}

function setSearchPlaceholder() {
  searchInput.placeholder = mobile.matches ? '搜索' : '搜索视频、频道、字幕';
}

function syncSidebarInert() {
  sidebar.inert = mobile.matches && !sidebar.classList.contains('open');
}

function setDrawer(open) {
  sidebar.classList.toggle('open', open);
  document.body.classList.toggle('drawer-open', open);
  scrim.hidden = !open;
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  syncSidebarInert();
  if (open) sidebar.querySelector('a')?.focus();
}

function closeDrawer(returnFocus) {
  if (!sidebar.classList.contains('open')) return;
  sidebar.classList.remove('open');
  document.body.classList.remove('drawer-open');
  scrim.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
  syncSidebarInert();
  if (returnFocus) menuBtn.focus();
}

boot();
