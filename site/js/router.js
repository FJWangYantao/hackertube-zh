export function parse(hash = location.hash) {
  const raw = (hash || '#/').replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);

  if (path.startsWith('/video/')) {
    const vid = path.slice('/video/'.length).split('/')[0];
    return { view: 'watch', vid, params, path };
  }
  if (path === '/saved') return { view: 'saved', params, path };
  if (path === '/history') return { view: 'history', params, path };
  if (path === '/series') return { view: 'series', params, path };
  return { view: 'feed', params, path: '/feed' };
}

export function pathFor(view, params = new URLSearchParams()) {
  const query = params.toString();
  const base = view === 'watch' ? params.get('vid') || '' : `/${view}`;
  if (view === 'watch') return `/video/${base}`;
  const suffix = query ? `?${query}` : '';
  return `${base}${suffix}`;
}

export function replace(path) {
  const target = '#' + path;
  if (location.hash === target) return;
  history.replaceState(null, '', target);
}

export function go(path) {
  const target = '#' + path;
  if (location.hash === target) return;
  location.hash = target;
}
