import { el, toast } from './ui.js';

/* Subtitle export: turn cue lists into downloadable SRT / VTT / TXT / Markdown. */

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function srtTime(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(t);
  const ms = Math.min(999, Math.round((t - whole) * 1000));
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}`
    + `:${pad(whole % 60)},${pad(ms, 3)}`;
}

function vttTime(seconds) {
  return srtTime(seconds).replace(',', '.');
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours ? pad(minutes) : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${pad(secs)}`;
}

function cueLines(cue, bilingual) {
  const zh = (cue.zh || '').trim();
  const en = (cue.en || '').trim();
  if (!bilingual || !en) return [zh || en].filter(Boolean);
  return [zh, en].filter(Boolean);
}

export function buildSRT(cues, { bilingual = true } = {}) {
  const blocks = [];
  let index = 0;
  for (const cue of cues) {
    const lines = cueLines(cue, bilingual);
    if (!lines.length) continue;
    index += 1;
    blocks.push([
      String(index),
      `${srtTime(cue.s)} --> ${srtTime(cue.e)}`,
      ...lines,
      '',
    ].join('\n'));
  }
  return blocks.join('\n');
}

/** WebVTT cue payloads are parsed for character references and <tags>. */
function escapeVTT(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildVTT(cues, { bilingual = true } = {}) {
  const blocks = [];
  for (const cue of cues) {
    const lines = cueLines(cue, bilingual);
    if (!lines.length) continue;
    blocks.push([
      `${vttTime(cue.s)} --> ${vttTime(cue.e)}`,
      ...lines.map(escapeVTT),
      '',
    ].join('\n'));
  }
  if (!blocks.length) return '';
  return `WEBVTT\n\n${blocks.join('\n')}`;
}

export function buildPlain(cues) {
  return cues.map((cue) => {
    const lines = cueLines(cue, true);
    return `[${clock(cue.s)}] ${lines.join('\n')}`;
  }).join('\n\n');
}

export function buildMarkdown(cues, meta = {}) {
  const vid = meta.vid || '';
  const head = meta.title ? `# ${meta.title}\n\n` : '';
  const body = cues.map((cue) => {
    const lines = cueLines(cue, true);
    const secs = Math.max(0, Math.floor(cue.s));
    const link = vid ? `https://www.youtube.com/watch?v=${vid}&t=${secs}` : '';
    const stamp = link ? `[${clock(cue.s)}](${link})` : `**${clock(cue.s)}**`;
    const zh = lines[0] || '';
    const en = lines.slice(1).join(' / ');
    return en ? `- ${stamp} ${zh}\n  - ${en}` : `- ${stamp} ${zh}`;
  }).join('\n');
  return `${head}${body}\n`;
}

const FORMATS = [
  { id: 'srt-bi', label: 'SRT · 中英双语', build: (cues) => buildSRT(cues, { bilingual: true }), ext: 'srt' },
  { id: 'srt-zh', label: 'SRT · 仅中文', build: (cues) => buildSRT(cues, { bilingual: false }), ext: 'srt' },
  { id: 'vtt-bi', label: 'VTT · 中英双语', build: (cues) => buildVTT(cues, { bilingual: true }), ext: 'vtt' },
  { id: 'txt', label: 'TXT · 中英对照文稿', build: (cues) => buildPlain(cues), ext: 'txt' },
  { id: 'md', label: 'Markdown · 带时间戳链接', build: (cues, meta) => buildMarkdown(cues, meta), ext: 'md' },
];

function safeName(title) {
  const base = String(title || 'hackertube').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim();
  return base.slice(0, 60) || 'hackertube';
}

export function downloadSubtitles(cues, meta, formatId) {
  const format = FORMATS.find((item) => item.id === formatId);
  if (!format || !Array.isArray(cues) || !cues.length) {
    toast('没有可导出的字幕');
    return;
  }
  const text = format.build(cues, meta);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', {
    href: url,
    download: `${safeName(meta?.title)}-中英字幕.${format.ext}`,
  });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give slower browsers a beat to start the download before freeing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${format.label}`);
}

/** A small dropdown next to the transcript toolbar: copy + export in one menu. */
export function buildExportMenu(cues, meta, { onCopy } = {}) {
  const menu = el('div', { class: 'export-menu', role: 'menu', hidden: true },
    ...(onCopy ? [el('button', {
      class: 'export-item export-item-copy',
      type: 'button',
      role: 'menuitem',
      on: { click: () => { close(); onCopy(); } },
    }, '复制到剪贴板')] : []),
    ...FORMATS.map((format) => el('button', {
      class: 'export-item',
      type: 'button',
      role: 'menuitem',
      on: { click: () => { close(); downloadSubtitles(cues, meta, format.id); } },
    }, format.label)),
  );

  const button = el('button', {
    class: 'transcript-follow export-btn',
    type: 'button',
    title: '复制字幕，或导出为 SRT / VTT / TXT / Markdown 文件',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    on: { click: () => setOpen(!isOpen()) },
  }, '复制 ▾');

  const wrap = el('div', { class: 'export-wrap' }, button, menu);
  let open = false;

  function isOpen() {
    return open;
  }

  function setOpen(next) {
    open = next;
    menu.hidden = !next;
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
  }

  function close() {
    setOpen(false);
  }

  function onDocClick(event) {
    if (open && !wrap.contains(event.target)) close();
  }

  function onKey(event) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close();
    }
  }

  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey, true);

  return {
    node: wrap,
    destroy() {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey, true);
    },
  };
}
