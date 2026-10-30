// All HTTP lives in the main process.
//
// The renderer owns the RTCPeerConnection but never makes a network request
// itself. Keeping fetch on this side means the UI can run on a secure custom
// scheme (needed for ES modules, AudioWorklet and getDisplayMedia) while still
// talking to a plain-HTTP server on a LAN -- no CORS preflights, no
// mixed-content blocking, and MediaMTX's allow-origin settings stop mattering.

const fs = require('node:fs');
const { once } = require('node:events');
const { Readable } = require('node:stream');

const REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long to wait for a server to say whether it is there. Shorter than an
 * ordinary request, because a server that is down would otherwise hold the
 * connect screen for the full ten seconds before saying so.
 */
const HEALTH_TIMEOUT_MS = 5_000;
const SDP_TIMEOUT_MS = 20_000;

/**
 * What each server has been given: its password, if it asks for one, and the
 * signed-in account's bearer token.
 *
 * Held here rather than passed through every call: it belongs to the server
 * address, not to any one request, and threading it through six signatures
 * would mean six chances to forget it on the call that matters. The renderer
 * sets it once per server, before anything else talks to that server.
 *
 * KEYED BY SERVER: with several servers live at once, one pair for "the
 * current server" would send one server's token to another. A request to a
 * server nobody has set credentials for carries none.
 *
 * Media URLs are not covered by this -- they carry a token the control server
 * puts in them, so the password itself never reaches MediaMTX.
 *
 * The token is the session token and NOT the account password. The renderer
 * never holds the password after login, and "remember me" persists this token
 * instead -- it expires on its own and can be revoked server-side, neither of
 * which is true of a stored password.
 */
const credentials = new Map();

/** The same server however it was typed: scheme assumed, no trailing slash, any case. */
function credKey(serverUrl) {
  const trimmed = String(serverUrl ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '').toLowerCase();
}

const credsOf = (serverUrl) => credentials.get(credKey(serverUrl)) ?? { password: '', token: '' };

function setCreds(serverUrl, patch) {
  const key = credKey(serverUrl);
  if (!key) return { ok: false };
  credentials.set(key, { ...credsOf(serverUrl), ...patch });
  return { ok: true };
}

const setPassword = (value, serverUrl) => setCreds(serverUrl, { password: String(value ?? '') });
const setSessionToken = (value, serverUrl) => setCreds(serverUrl, { token: String(value ?? '') });
const setCredentials = (serverUrl, { password = '', token = '' } = {}) => setCreds(serverUrl, {
  password: String(password ?? ''), token: String(token ?? ''),
});

/** The headers that identify us to ONE server. */
function authHeaders(serverUrl, headers = {}) {
  const { password, token } = credsOf(serverUrl);
  if (password) headers['X-Harmony-Password'] = password;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeBase(serverUrl) {
  const trimmed = String(serverUrl ?? '').trim();
  if (!trimmed) throw new ApiError('No server address configured.', { code: 'no_server' });
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * @param {object} [options]
 * @param {string} [options.serverPassword]  send THIS instead of the current
 *   server's password, and no session token at all. For asking a server that
 *   is not the current one about itself: the current server's credentials
 *   must never be sent to another.
 * @param {number} [options.timeoutMs]
 */
async function requestJson(serverUrl, pathname, {
  method = 'GET', body, serverPassword, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  const foreign = serverPassword !== undefined;
  let res;
  try {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (foreign) {
      if (serverPassword) headers['X-Harmony-Password'] = serverPassword;
    } else {
      authHeaders(serverUrl, headers);
    }

    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(
      err.name === 'TimeoutError'
        ? 'The server did not respond in time.'
        : `Could not reach ${url}. Check the server address and that Harmony is running.`,
      { code: 'unreachable' },
    );
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    throw new ApiError(payload?.message ?? `Server returned ${res.status}.`, {
      status: res.status,
      code: payload?.error ?? 'http_error',
    });
  }
  return payload;
}

/**
 * Private conversations: the paths they use, and nothing else.
 *
 * One narrow door instead of a wrapper per route -- there are about a dozen --
 * and narrow on purpose: the renderer can only ask for these, with these
 * methods, so a page that went wrong could not use it as a way to call the rest
 * of the API with the session's token.
 */
const DM_PATH = new RegExp(
  '^/api/(keys(/wrap|/lookup)?|inbox'
  + '|dms(/blocks|/\\d+(/(messages|read|clear))?)?'
  + '|dm-messages/\\d+/(edit|edits|delete|react))(\\?[A-Za-z0-9=&,._-]*)?$',
);

/**
 * A private-conversation request, answered as DATA: {status, body}, for every
 * HTTP status. An error here carries things the caller needs (a `stale_key`
 * refusal brings the keys to seal to again), and errors cross to the page as a
 * message and a code only. Only a server that cannot be reached throws.
 */
async function dmRequest(serverUrl, method, pathname, body) {
  if (!['GET', 'POST'].includes(method) || !DM_PATH.test(String(pathname))) {
    throw new ApiError('Not a private-conversation request.', { code: 'bad_request' });
  }
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  let res;
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    authHeaders(serverUrl, headers);
    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      err.name === 'TimeoutError'
        ? 'The server did not respond in time.'
        : `Could not reach ${url}. Check the server address and that Harmony is running.`,
      { code: 'unreachable' },
    );
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, body: payload };
}

/** A file already sealed on this computer, to a conversation. {status, body}. */
async function dmUpload(serverUrl, conversationId, bytes) {
  if (!Number.isSafeInteger(Number(conversationId))) throw new ApiError('Bad conversation.', { code: 'bad_request' });
  const url = `${normalizeBase(serverUrl)}/api/dms/${Number(conversationId)}/uploads`;
  const headers = { 'Content-Type': 'application/octet-stream' };
  authHeaders(serverUrl, headers);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: Buffer.from(bytes), signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new ApiError(`Upload failed: ${err.message}`, { code: 'unreachable' });
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, body: payload };
}

/** A sealed file, still sealed: {status, bytes}. Opened by whoever holds its key. */
async function dmDownload(serverUrl, conversationId, hash) {
  if (!Number.isSafeInteger(Number(conversationId)) || !/^[0-9a-f]{64}$/.test(String(hash))) {
    throw new ApiError('Bad file.', { code: 'bad_request' });
  }
  const url = `${normalizeBase(serverUrl)}/api/dms/${Number(conversationId)}/uploads/${hash}`;
  const headers = {};
  authHeaders(serverUrl, headers);
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new ApiError(`Could not download the file: ${err.message}`, { code: 'unreachable' });
  }
  if (!res.ok) return { status: res.status, bytes: null };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * The WHIP/WHEP handshake: POST an SDP offer, get an SDP answer plus a
 * Location header naming the session resource (used later to hang up).
 */
async function sdpExchange(url, offerSdp) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offerSdp,
      signal: AbortSignal.timeout(SDP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      err.name === 'TimeoutError'
        ? 'The media server did not answer in time.'
        : `Could not reach the media server at ${url}.`,
      { code: 'media_unreachable' },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError('The media server refused this session. The username reservation may have expired.', {
      status: res.status,
      code: 'unauthorized',
    });
  }
  if (res.status === 404) {
    throw new ApiError('That stream is not live yet.', { status: 404, code: 'not_live' });
  }
  if (!res.ok) {
    throw new ApiError(`Media server returned ${res.status}: ${(await res.text()).slice(0, 200)}`, {
      status: res.status,
      code: 'media_error',
    });
  }

  const answer = await res.text();
  const location = res.headers.get('location');
  return {
    answer,
    resourceUrl: location ? new URL(location, url).toString() : null,
  };
}

/**
 * Download a stored file as raw bytes.
 *
 * Separate from requestJson because the response is binary and because the
 * media cache verifies the sha256 of what arrives -- it needs the buffer, not
 * a parsed body.
 */
/**
 * Any saved server's logo, with THAT server's password and no session token
 * -- the same rule as probe(): one server's credentials never go to another.
 * Shaped like fetchUpload, for the logo cache to verify and store.
 */
async function fetchServerLogo(serverUrl, serverPassword) {
  const url = `${normalizeBase(serverUrl)}/api/server/logo`;
  const headers = {};
  if (serverPassword) headers['X-Harmony-Password'] = serverPassword;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new ApiError(`Could not download the logo: ${err.message}`, { code: 'unreachable' });
  }
  if (!res.ok) {
    throw new ApiError(`The server returned ${res.status} for its logo.`, {
      status: res.status, code: res.status === 404 ? 'no_logo' : 'media_error',
    });
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

async function fetchUpload(serverUrl, hash) {
  const url = `${normalizeBase(serverUrl)}/api/uploads/${hash}`;
  const headers = {};
  authHeaders(serverUrl, headers);

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ApiError(`Could not download ${hash.slice(0, 8)}: ${err.message}`, {
      code: 'unreachable',
    });
  }
  if (!res.ok) {
    throw new ApiError(`The server returned ${res.status} for that file.`, {
      status: res.status,
      code: 'media_error',
    });
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/** Upload raw bytes. Returns { hash, contentType, bytes }. */
async function uploadFile(serverUrl, bytes, contentType) {
  const url = `${normalizeBase(serverUrl)}/api/uploads`;
  const headers = { 'Content-Type': contentType };
  authHeaders(serverUrl, headers);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ApiError(`Upload failed: ${err.message}`, { code: 'unreachable' });
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new ApiError(payload?.message ?? `Upload refused (${res.status}).`, {
      status: res.status,
      code: payload?.error ?? 'upload_failed',
    });
  }
  return payload;
}

/*
 * Big uploads, in pieces (server/src/upload-sessions.js). The renderer reads
 * the file a piece at a time and hands each one over, so neither process
 * ever holds more of a 2 GB file than one piece.
 */
const CHUNK_TIMEOUT_MS = 5 * 60_000;

async function uploadRequest(serverUrl, pathname, { body, json, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  const headers = {};
  authHeaders(serverUrl, headers);
  if (json) headers['Content-Type'] = 'application/json';
  else if (body) headers['Content-Type'] = 'application/octet-stream';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(`Upload failed: ${err.message}`, { code: 'unreachable' });
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const error = new ApiError(payload?.message ?? `Upload refused (${res.status}).`, {
      status: res.status,
      code: payload?.error ?? 'upload_failed',
    });
    // Where the server really is, when a piece arrived at the wrong place.
    error.received = payload?.received;
    throw error;
  }
  return payload;
}

const uploadOpen = (serverUrl, size, contentType) => uploadRequest(serverUrl, '/api/uploads/sessions', {
  json: { size, contentType },
});
const uploadChunk = (serverUrl, id, offset, bytes) => uploadRequest(
  serverUrl,
  `/api/uploads/sessions/${encodeURIComponent(id)}/chunk?offset=${Number(offset)}`,
  { body: Buffer.from(bytes), timeoutMs: CHUNK_TIMEOUT_MS },
);
const uploadFinish = (serverUrl, id) => uploadRequest(
  serverUrl, `/api/uploads/sessions/${encodeURIComponent(id)}/finish`, { json: {}, timeoutMs: 60_000 },
);
const uploadCancel = (serverUrl, id) => uploadRequest(
  serverUrl, `/api/uploads/sessions/${encodeURIComponent(id)}/cancel`, { json: {} },
).catch(() => null);

/**
 * Download a stored file straight to a path, reporting progress.
 *
 * Not through the media cache: a file someone is saving is not one they
 * are looking at, and a 2 GB one would push everything else out of a cache
 * with a 512 MB budget. Written beside the target first and renamed, so a
 * broken download never leaves half a file under the name asked for.
 */
async function downloadTo(serverUrl, hash, filePath, onProgress) {
  const url = `${normalizeBase(serverUrl)}/api/uploads/${hash}`;
  const headers = {};
  authHeaders(serverUrl, headers);

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new ApiError(`Could not download that file: ${err.message}`, { code: 'unreachable' });
  }
  if (!res.ok || !res.body) {
    throw new ApiError(`The server returned ${res.status} for that file.`, {
      status: res.status, code: 'media_error',
    });
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const temp = `${filePath}.part`;
  const out = fs.createWriteStream(temp);
  let received = 0;
  let reported = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      // A few times a second at most, not once per network packet.
      const now = Date.now();
      if (now - reported > 150) {
        reported = now;
        onProgress?.(received, total);
      }
    }
    out.end();
    await once(out, 'finish');
    await fs.promises.rename(temp, filePath);
  } catch (err) {
    out.destroy();
    await fs.promises.unlink(temp).catch(() => {});
    throw new ApiError(`The download broke off: ${err.message}`, { code: 'unreachable' });
  }
  onProgress?.(received, total || received);
  return received;
}

async function deleteResource(resourceUrl) {
  if (!resourceUrl) return;
  try {
    await fetch(resourceUrl, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  } catch {
    // Best effort. If the DELETE is lost, MediaMTX drops the session on ICE
    // timeout anyway and the username frees itself.
  }
}

module.exports = {
  ApiError,
  setPassword,
  setSessionToken,
  setCredentials,
  credKey,
  dmRequest,
  dmUpload,
  dmDownload,
  // The current server, with a shorter wait than an ordinary request: this
  // is what the connect screen shows a spinner for.
  health: (s) => requestJson(s, '/api/health', { timeoutMs: HEALTH_TIMEOUT_MS }),
  // Any saved server, with ITS OWN password (or none) and no session token.
  probe: (s, serverPassword) =>
    requestJson(s, '/api/health', { serverPassword: serverPassword ?? '', timeoutMs: HEALTH_TIMEOUT_MS }),

  // Accounts. All of these sit behind the shared server password, so they
  // inherit the X-Harmony-Password header above without doing anything.
  register: (s, nickname, password_, ownerKey) =>
    requestJson(s, '/api/accounts/register', {
      method: 'POST',
      body: { nickname, password: password_, ...(ownerKey ? { ownerKey } : {}) },
    }),
  login: (s, nickname, password_, ownerKey) =>
    requestJson(s, '/api/accounts/login', {
      method: 'POST',
      body: { nickname, password: password_, ...(ownerKey ? { ownerKey } : {}) },
    }),
  logout: (s) => requestJson(s, '/api/accounts/logout', { method: 'POST' }),

  // The password: changing it while signed in, and getting back in when it is
  // forgotten (three questions the person wrote -- see server/src/recovery.js).
  // The last three need no session: they are what the sign-in screen uses.
  changePassword: (s, current, password_) =>
    requestJson(s, '/api/accounts/password', { method: 'POST', body: { current, password: password_ } }),
  recoveryStatus: (s) => requestJson(s, '/api/accounts/recovery'),
  setRecovery: (s, current, items) =>
    requestJson(s, '/api/accounts/recovery', { method: 'POST', body: { current, items } }),
  clearRecovery: (s, current) =>
    requestJson(s, '/api/accounts/recovery/clear', { method: 'POST', body: { current } }),
  recoveryStart: (s, nickname) =>
    requestJson(s, '/api/accounts/recovery/start', { method: 'POST', body: { nickname } }),
  recoveryVerify: (s, nickname, answers) =>
    requestJson(s, '/api/accounts/recovery/verify', { method: 'POST', body: { nickname, answers } }),
  recoveryReset: (s, resetToken, password_) =>
    requestJson(s, '/api/accounts/recovery/reset', { method: 'POST', body: { resetToken, password: password_ } }),

  // Channels. Reading is any member; everything else is admin-gated server
  // side, so these just surface whatever it answers.
  channels: (s) => requestJson(s, '/api/channels'),
  createChannel: (s, body) => requestJson(s, '/api/channels', { method: 'POST', body }),
  updateChannel: (s, id, body) =>
    requestJson(s, `/api/channels/${id}`, { method: 'POST', body }),
  deleteChannel: (s, id) =>
    requestJson(s, `/api/channels/${id}/delete`, { method: 'POST' }),
  reorderChannels: (s, ids) =>
    requestJson(s, '/api/channels/reorder', { method: 'POST', body: { ids } }),
  me: (s) => requestJson(s, '/api/accounts/me'),
  // `hash` is an already-uploaded image, or null to go back to initials. The
  // picture itself travels through uploadFile like any other attachment.
  setAvatar: (s, hash) =>
    requestJson(s, '/api/accounts/avatar', { method: 'POST', body: { hash } }),
  // The banner and the join sound are the same: an already-uploaded file's
  // hash, or null to take it away. See setAvatar.
  // 0-100, or null for the default.
  setBannerDim: (s, dim) => requestJson(s, '/api/accounts/banner-dim', { method: 'POST', body: { dim } }),
  setBanner: (s, hash) =>
    requestJson(s, '/api/accounts/banner', { method: 'POST', body: { hash } }),
  setJoinSound: (s, hash) =>
    requestJson(s, '/api/accounts/join-sound', { method: 'POST', body: { hash } }),
  // One of the server's fixed list of ids, or null for the ordinary font.
  // A solid colour, a moving gradient or the rainbow for the name -- or null to
  // go back to the colour of the highest role. The server validates the shape.
  setNameColor: (s, nameColor) =>
    requestJson(s, '/api/accounts/name-color', { method: 'POST', body: { nameColor } }),
  setNameFont: (s, font) =>
    requestJson(s, '/api/accounts/name-font', { method: 'POST', body: { font } }),
  roster: (s) => requestJson(s, '/api/accounts'),
  setRole: (s, id, role) =>
    requestJson(s, `/api/accounts/${id}/role`, { method: 'POST', body: { role } }),
  // Takes the account and everything written under it. Owner only, server
  // side; the client hides the control for everybody else.
  deleteAccount: (s, id) =>
    requestJson(s, `/api/accounts/${id}/delete`, { method: 'POST' }),

  // Roles, and what they gate. Every rule is enforced server side.
  roles: (s) => requestJson(s, '/api/roles'),
  createRole: (s, body) =>
    requestJson(s, '/api/roles', { method: 'POST', body: body }),
  updateRole: (s, id, body) =>
    requestJson(s, `/api/roles/${id}`, { method: 'POST', body: body }),
  deleteRole: (s, id) =>
    requestJson(s, `/api/roles/${id}/delete`, { method: 'POST' }),
  reorderRoles: (s, ids) =>
    requestJson(s, '/api/roles/reorder', { method: 'POST', body: { ids } }),
  setUserRoles: (s, id, roles) =>
    requestJson(s, `/api/accounts/${id}/roles`, { method: 'POST', body: { roles } }),
  kickUser: (s, id) =>
    requestJson(s, `/api/accounts/${id}/kick`, { method: 'POST' }),
  banUser: (s, id, banned) =>
    requestJson(s, `/api/accounts/${id}/ban`, { method: 'POST', body: { banned } }),
  updateGroup: (s, id, body) =>
    requestJson(s, `/api/channels/groups/${id}`, { method: 'POST', body: body }),

  // Badges: a name, a description and a picture or an emoji, on a profile card.
  badges: (s) => requestJson(s, '/api/badges'),
  createBadge: (s, body) =>
    requestJson(s, '/api/badges', { method: 'POST', body: body }),
  updateBadge: (s, id, body) =>
    requestJson(s, `/api/badges/${id}`, { method: 'POST', body: body }),
  deleteBadge: (s, id) =>
    requestJson(s, `/api/badges/${id}/delete`, { method: 'POST' }),
  setUserBadges: (s, id, badges) =>
    requestJson(s, `/api/accounts/${id}/badges`, { method: 'POST', body: { badges } }),

  serverInfo: (s) => requestJson(s, '/api/server'),
  updateServer: (s, body) => requestJson(s, '/api/server', { method: 'POST', body }),

  createGroup: (s, name, extra) =>
    requestJson(s, '/api/channels/groups', { method: 'POST', body: { ...extra, name } }),
  renameGroup: (s, id, name) =>
    requestJson(s, `/api/channels/groups/${id}`, { method: 'POST', body: { name } }),
  deleteGroup: (s, id) =>
    requestJson(s, `/api/channels/groups/${id}/delete`, { method: 'POST' }),
  // The whole sidebar after a drag, not a move: see Channels.arrange.
  arrange: (s, body) =>
    requestJson(s, '/api/channels/arrange', { method: 'POST', body }),

  renameClip: (s, id, body) =>
    requestJson(s, `/api/soundpad/${id}/rename`, { method: 'POST', body }),

  setDisplayName: (s, displayName) =>
    requestJson(s, '/api/accounts/display-name', { method: 'POST', body: { displayName } }),
  streams: (s) => requestJson(s, '/api/streams'),
  // `token` is sent only when reclaiming a username this client already holds.
  // `kind` is 'camera' to claim the caller's own `<nickname>-cam` path. The
  // server derives that name itself; it is never sent as a username.
  session: (s, username, token, kind) =>
    requestJson(s, '/api/session', {
      method: 'POST',
      body: { username, token, ...(kind ? { kind } : {}) },
    }),
  heartbeat: (s, username, token) =>
    requestJson(s, '/api/session/heartbeat', { method: 'POST', body: { username, token } }),
  release: (s, username, token) =>
    requestJson(s, '/api/session/release', { method: 'POST', body: { username, token } }),
  sdpExchange,
  deleteResource,
  fetchUpload,
  fetchServerLogo,
  uploadFile,
  uploadOpen,
  uploadChunk,
  uploadFinish,
  uploadCancel,
  downloadTo,

  // Messages
  // "I have read this channel up to here", and what is new in every channel.
  markRead: (s, id, upTo) => requestJson(s, `/api/channels/${Number(id)}/read`, {
    method: 'POST', body: upTo === undefined ? {} : { upTo: Number(upTo) },
  }),
  unread: (s) => requestJson(s, '/api/unread'),
  messages: (s, id, before) =>
    requestJson(s, `/api/channels/${id}/messages${before ? `?before=${before}` : ''}`),
  postMessage: (s, id, body) =>
    requestJson(s, `/api/channels/${id}/messages`, { method: 'POST', body }),
  pinMessage: (s, id, pinned) =>
    requestJson(s, `/api/messages/${id}/pin`, { method: 'POST', body: { pinned } }),
  deleteMessage: (s, id) =>
    requestJson(s, `/api/messages/${id}/delete`, { method: 'POST' }),
  // Your own only; the server refuses anybody else's, admin or not.
  editMessage: (s, id, body) =>
    requestJson(s, `/api/messages/${id}/edit`, { method: 'POST', body: { body } }),
  // An absent hash means "take the file off", which the server refuses if
  // it would leave the message with nothing in it.
  setAttachment: (s, id, body) =>
    requestJson(s, `/api/messages/${id}/attachment`, { method: 'POST', body }),
  // A toggle, not an add: the server decides, because clicking an emoji
  // somebody else already chose has to add to it rather than replace it.
  react: (s, id, emoji, on) =>
    requestJson(s, `/api/messages/${id}/react`, { method: 'POST', body: { emoji, on } }),

  emojis: (s) => requestJson(s, '/api/emojis'),
  addEmoji: (s, body) => requestJson(s, '/api/emojis', { method: 'POST', body }),
  deleteEmoji: (s, id) => requestJson(s, `/api/emojis/${id}/delete`, { method: 'POST' }),

  soundpad: (s) => requestJson(s, '/api/soundpad'),
  addClip: (s, body) => requestJson(s, '/api/soundpad', { method: 'POST', body }),
  deleteClip: (s, id) => requestJson(s, `/api/soundpad/${id}/delete`, { method: 'POST' }),
  reorderClips: (s, ids) =>
    requestJson(s, '/api/soundpad/reorder', { method: 'POST', body: { ids } }),
  search: (s, id, q) =>
    requestJson(s, `/api/channels/${id}/search?q=${encodeURIComponent(q)}`),
};
