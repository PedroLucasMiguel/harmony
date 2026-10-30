// A file that has nothing to look at, drawn as a card: its icon, its name and
// how big it is, and the buttons for it at the end -- the way Discord draws one.
//
// Shared by the channels and the private conversations, which draw everything
// else about an attachment on their own.

const KINDS = [
  ['file-zip', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'dmg']],
  ['file-pdf', ['pdf']],
  ['file-doc', ['doc', 'docx', 'odt', 'rtf', 'pages']],
  ['file-xls', ['xls', 'xlsx', 'ods', 'numbers']],
  ['file-ppt', ['ppt', 'pptx', 'odp', 'key']],
  ['file-csv', ['csv', 'tsv']],
  ['file-text', ['txt', 'md', 'log', 'ini', 'cfg']],
  ['file-code', [
    'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'xml', 'yml', 'yaml', 'toml', 'py', 'rb', 'go', 'rs', 'java',
    'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql', 'lua', 'kt', 'swift',
  ]],
  ['file-audio', ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'wma', 'mid']],
  ['file-video', ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg']],
  ['file-image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'ico', 'psd']],
];

const BY_EXTENSION = new Map(KINDS.flatMap(([icon, extensions]) => extensions.map((x) => [x, icon])));
const BY_MEDIA = { image: 'file-image', video: 'file-video', audio: 'file-audio' };

/** The icon for a file: by its extension, else by what the server says it is, else a blank page. */
export function iconFor(name, mediaType) {
  const extension = /\.([^./\\]+)$/.exec(String(name ?? ''))?.[1]?.toLowerCase();
  return BY_EXTENSION.get(extension) ?? BY_MEDIA[mediaType] ?? 'file';
}

/**
 * @param {object} file
 * @param {string} file.name  what it is called
 * @param {string} [file.size]  how big, already worded ("82.26 MB")
 * @param {string} [file.mediaType]  image, video, audio or file
 * @param {string} [file.title]  the name's tooltip, and what it does when pressed
 * @param {() => void} [file.onOpen]  pressing the name or the icon (saving it)
 * @returns {{wrap: HTMLElement, end: HTMLElement}} `end` is where the file's buttons go
 */
export function fileCard({ name, size, mediaType, title, onOpen }) {
  const wrap = document.createElement('span');
  wrap.className = 'attachment attachment-card';

  const icon = document.createElement('span');
  icon.className = 'attachment-icon';
  icon.dataset.icon = iconFor(name, mediaType);
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'attachment-text';
  const label = document.createElement('span');
  label.className = 'attachment-name';
  label.textContent = name;
  label.title = title ?? name;
  text.append(label);
  if (size) {
    const amount = document.createElement('span');
    amount.className = 'attachment-size';
    amount.textContent = size;
    text.append(amount);
  }

  if (onOpen) {
    label.classList.add('attachment-link');
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    label.addEventListener('click', (event) => {
      event.stopPropagation();
      onOpen();
    });
    label.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onOpen();
    });
  }

  const end = document.createElement('span');
  end.className = 'attachment-end';
  wrap.append(icon, text, end);
  return { wrap, end };
}

// ---------------------------------------------------------------------------
// A text file, with its first lines shown
// ---------------------------------------------------------------------------

/** Past this a text file is only a card: showing a few lines would mean fetching all of it. */
export const TEXT_PREVIEW_MAX_FILE = 2 * 1024 * 1024;
/** The most that is ever read of a text file for the preview, expanded or not. */
export const TEXT_PREVIEW_BYTES = 64 * 1024;
/** Lines shown folded, and lines shown unfolded (the rest is for the download). */
const FOLDED_LINES = 10;
const UNFOLDED_LINES = 400;
/** A line longer than this is cut: a minified file is one line of a megabyte. */
const LINE_CHARS = 400;

const TEXT_ICONS = new Set(['file-text', 'file-code', 'file-csv']);

/** Whether a file is read as text, by its name: what a server cannot know of a .md or a .log. */
export function isTextFile(name) {
  return TEXT_ICONS.has(iconFor(name));
}

/** Whether to show the first lines of this one: text, and small enough to fetch for that. */
export function previewsAsText(name, bytes) {
  return isTextFile(name) && Number(bytes) > 0 && Number(bytes) <= TEXT_PREVIEW_MAX_FILE;
}

/**
 * The first bytes of what a URL serves, and no more than that.
 *
 * Asks for the range, and stops reading at the limit whether or not the server
 * answered with only that part.
 */
export async function readHead(url, limit = TEXT_PREVIEW_BYTES) {
  const res = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` } });
  if (!res.ok) throw new Error(`the file returned ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let have = 0;
  while (have < limit) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    have += value.length;
  }
  reader.cancel().catch(() => {});
  const head = new Uint8Array(Math.min(have, limit));
  let at = 0;
  for (const chunk of chunks) {
    const room = head.length - at;
    if (room <= 0) break;
    head.set(chunk.subarray(0, room), at);
    at += Math.min(chunk.length, room);
  }
  return head;
}

/** What to show of the start of a file: its lines, cut, and how much was left out. */
export function excerpt(bytes, fileSize, maxLines) {
  if (bytes.includes(0)) return null; // not text
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const lines = text.split(/\r\n|\n|\r/);
  // The file may have been cut mid-line: the last line of a cut read is not a whole one.
  const cut = bytes.length < fileSize;
  if (cut && lines.length > 1) lines.pop();
  if (!cut && lines.at(-1) === '') lines.pop();
  const shown = lines.slice(0, maxLines).map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}\u2026` : l));
  const hidden = lines.length - shown.length;
  let left = null;
  if (!cut && hidden > 0) left = { lines: hidden };
  else if (cut) {
    const used = new TextEncoder().encode(shown.join('\n')).length;
    left = { bytes: Math.max(0, fileSize - used) };
  }
  return { text: shown.join('\n'), left };
}

/**
 * A text file: its first lines in a box, and under it the card's own row -- a
 * chevron to unfold the box, the name, the size, the buttons.
 *
 * Nothing is read until it is on screen, and never more than TEXT_PREVIEW_BYTES
 * of it. A file that turns out not to be text (a NUL in the head of it) is left
 * as the plain row.
 *
 * @param {object} file
 * @param {string} file.name
 * @param {number} file.bytes  its size
 * @param {string} [file.size]  the size, worded
 * @param {() => Promise<Uint8Array>} file.head  the start of the file, at most TEXT_PREVIEW_BYTES
 * @param {() => void} [file.onOpen]  pressing the name (saving it)
 * @param {(key: string, values?: object) => string} file.t  the words
 * @returns {{wrap: HTMLElement, end: HTMLElement}} `end` is where the file's buttons go
 */
export function textCard({ name, bytes, size, head, onOpen, t }) {
  const wrap = document.createElement('span');
  wrap.className = 'attachment attachment-textfile';

  const body = document.createElement('span');
  body.className = 'textfile-body';
  body.hidden = true;
  const pre = document.createElement('pre');
  pre.className = 'textfile-lines';
  const left = document.createElement('span');
  left.className = 'textfile-left';
  body.append(pre, left);

  const foot = document.createElement('span');
  foot.className = 'textfile-foot';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'textfile-toggle';
  toggle.dataset.icon = 'caret-down';
  toggle.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.title = t('attachment.expand');
  toggle.setAttribute('aria-label', t('attachment.expand'));

  const text = document.createElement('span');
  text.className = 'attachment-text';
  const label = document.createElement('span');
  label.className = 'attachment-name';
  label.textContent = name;
  label.title = name;
  text.append(label);
  if (size) {
    const amount = document.createElement('span');
    amount.className = 'attachment-size';
    amount.textContent = size;
    text.append(amount);
  }
  if (onOpen) {
    label.classList.add('attachment-link');
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    label.title = t('app.download');
    label.addEventListener('click', (event) => {
      event.stopPropagation();
      onOpen();
    });
    label.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onOpen();
    });
  }
  const end = document.createElement('span');
  end.className = 'attachment-end';
  foot.append(toggle, text, end);
  wrap.append(body, foot);

  let head64 = null;
  let unfolded = false;

  const draw = () => {
    const view = excerpt(head64, bytes, unfolded ? UNFOLDED_LINES : FOLDED_LINES);
    if (!view) return;
    pre.textContent = view.text;
    const more = view.left?.lines
      ? t('attachment.lines_left', { count: view.left.lines })
      : view.left?.bytes ? t('attachment.bytes_left', { size: view.left.bytes < 1024 ? `${view.left.bytes} B` : `${Math.round(view.left.bytes / 1024)} KB` }) : '';
    left.textContent = more ? `\u2026 (${more})` : '';
    left.hidden = !more;
    body.toggleAttribute('data-unfolded', unfolded);
  };

  const load = async () => {
    try {
      head64 = await head();
    } catch {
      return; // the row is the whole attachment
    }
    if (!head64?.length || head64.includes(0)) return;
    body.hidden = false;
    toggle.hidden = false;
    draw();
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    unfolded = !unfolded;
    toggle.dataset.icon = unfolded ? 'caret-up' : 'caret-down';
    toggle.setAttribute('aria-expanded', String(unfolded));
    toggle.title = t(unfolded ? 'attachment.fold' : 'attachment.expand');
    toggle.setAttribute('aria-label', toggle.title);
    draw();
  });

  // Read when it is seen, not when it is drawn: a long history is a long list of these.
  if (typeof IntersectionObserver === 'function') {
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watcher.disconnect();
      load();
    }, { rootMargin: '200px' });
    watcher.observe(wrap);
  } else {
    load();
  }

  return { wrap, end };
}
