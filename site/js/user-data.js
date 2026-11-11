import { el, toast } from './ui.js';
import { store } from './data.js';

export const BACKUP_SETTING_KEYS = [
  'hud_mode',
  'hud_blocker_enabled',
  'hud_veil',
  'hud_hide_ms',
  'heatmap_enabled',
  'remember_playback',
  'subs_mode',
  'speed',
  'autoplay',
  'skip_silence',
  'sub_size',
  'sub_alpha',
  'sub_box',
  'theme',
  'theater',
  'stream_lang',
  'volume',
  'muted',
];

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueIds(values, limit) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string'))].slice(0, limit);
}

export function exportUserData() {
  const settings = {};
  for (const key of BACKUP_SETTING_KEYS) {
    const value = store.get(key, null);
    if (value !== null) settings[key] = value;
  }
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    saved: store.list('saved'),
    visited: store.list('visited'),
    progress: store.get('progress', {}),
    notes: store.get('notes', {}),
    settings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', {
    href: url,
    download: `hackertube-zh-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  toast('已导出个人数据与设置');
}

export async function importUserData(file) {
  if (!file || file.size > 10 * 1024 * 1024) throw new Error('invalid backup');
  const data = JSON.parse(await file.text());
  if (!isRecord(data)) throw new Error('invalid backup');

  if (Array.isArray(data.saved)) {
    const merged = uniqueIds([...data.saved, ...store.list('saved')], 1000);
    store.set('saved', merged);
  }
  if (Array.isArray(data.visited)) {
    const merged = uniqueIds([...data.visited, ...store.list('visited')], 500);
    store.set('visited', merged);
  }
  if (isRecord(data.progress)) {
    const current = store.get('progress', {});
    store.set('progress', { ...data.progress, ...(isRecord(current) ? current : {}) });
  }
  if (isRecord(data.notes)) {
    const current = store.get('notes', {});
    const merged = isRecord(current) ? { ...current } : {};
    for (const [vid, rows] of Object.entries(data.notes)) {
      if (!Array.isArray(rows)) continue;
      const existing = Array.isArray(merged[vid]) ? merged[vid] : [];
      const known = new Set(existing.map((note) => note?.id));
      const additions = rows.filter((note) => isRecord(note) && note.id && !known.has(note.id));
      if (additions.length) merged[vid] = [...existing, ...additions];
    }
    store.set('notes', merged);
  }

  const settings = {};
  if (isRecord(data.settings)) {
    for (const key of BACKUP_SETTING_KEYS) {
      if (Object.hasOwn(data.settings, key)) {
        settings[key] = data.settings[key];
        store.set(key, data.settings[key]);
      }
    }
  }
  return { settings };
}

export function triggerImportUserData(onImported) {
  const input = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
  });
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const result = await importUserData(file);
      toast(Object.keys(result.settings).length
        ? '已恢复收藏、记录、随手记与设置'
        : '已恢复收藏、记录与随手记');
      onImported?.(result);
    } catch {
      toast('备份文件格式有误或文件过大');
    }
  }, { once: true });
  document.body.append(input);
  input.click();
}
