// Writing clips to disk.
//
// Clips land in the user's Videos folder rather than behind a save dialog: the
// point of the button is to catch something that just happened, and a modal
// asking where to put it defeats that.

const { app, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

function clipsDirectory() {
  let base;
  try {
    base = app.getPath('videos');
  } catch {
    base = app.getPath('documents');
  }
  return path.join(base, 'Harmony Clips');
}

/** Keep the name filesystem-safe and sortable. */
function clipName(label) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('-');
  const safe = String(label || 'clip')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'clip';
  return `${safe}_${stamp}_${time}.mp4`;
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function save(data, label) {
  const dir = clipsDirectory();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, clipName(label));
  await fs.writeFile(file, Buffer.from(data));
  return { path: file, bytes: data.byteLength };
}

function reveal(file) {
  shell.showItemInFolder(file);
  return true;
}

module.exports = { save, reveal, clipsDirectory };
