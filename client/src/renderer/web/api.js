// HTTP, for the builds that have no main process: the browser and Android.
//
// A port of src/main/api.js, which the desktop app keeps using unchanged. The
// two are kept apart rather than shared because main is CommonJS run by Node
// and this is an ES module run by a page, and because the differences are in
// exactly the places that matter: bytes are Uint8Array here, not Buffer, and
// every request is a cross-origin one, which the server allows (it sends
// Access-Control-Allow-Origin: * on everything).
//
// A route added to main/api.js needs adding here too. The route table at the
// bottom is the only part that grows.

const REQUEST_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
const SDP_TIMEOUT_MS = 20_000;

let password = '';
let sessionToken = '';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeBase(serverUrl) {
  const trimmed = String(serverUrl ?? '').trim();
  if (!trimmed) throw new ApiError('No server address configured.', { code: 'no_server' });
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** AbortSignal.timeout, where it exists; a plain timer where it does not. */
function timeout(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
  return controller.signal;
}

const timedOut = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

function authHeaders({ serverPassword } = {}) {
  const foreign = serverPassword !== undefined;
  const headers = {};
  const door = foreign ? serverPassword : password;
  if (door) headers['X-Harmony-Password'] = door;
  if (sessionToken && !foreign) headers.Authorization = `Bearer ${sessionToken}`;
  return headers;
}

async function requestJson(serverUrl, pathname, {
  method = 'GET', body, serverPassword, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  let res;
  try {
    const headers = authHeaders({ serverPassword });
    if (body) headers['Content-Type'] = 'application/json';
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(
      timedOut(err)
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

/** WHIP/WHEP: POST an SDP offer, get the answer and the session's URL. */
async function sdpExchange(url, offerSdp) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offerSdp,
      signal: timeout(SDP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      timedOut(err)
        ? 'The media server did not answer in time.'
        : `Could not reach the media server at ${url}.`,
      { code: 'media_unreachable' },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('The media server refused this session. The username reservation may have expired.', {
      status: res.status, code: 'unauthorized',
    });
  }
  if (res.status === 404) {
    throw new ApiError('That stream is not live yet.', { status: 404, code: 'not_live' });
  }
  if (!res.ok) {
    throw new ApiError(`Media server returned ${res.status}: ${(await res.text()).slice(0, 200)}`, {
      status: res.status, code: 'media_error',
    });
  }
  const answer = await res.text();
  // Readable cross-origin only because MediaMTX exposes it
  // (Access-Control-Expose-Headers). Without it, hanging up is left to ICE
  // timing out, which MediaMTX does on its own anyway.
  const location = res.headers.get('location');
  return { answer, resourceUrl: location ? new URL(location, url).toString() : null };
}

async function deleteResource(resourceUrl) {
  if (!resourceUrl) return;
  try {
    await fetch(resourceUrl, { method: 'DELETE', signal: timeout(5000) });
  } catch {
    // Best effort, as on the desktop: MediaMTX drops it on ICE timeout.
  }
}

/** Any URL on the current server, as bytes, with the current credentials. */
export async function fetchBytes(serverUrl, pathname, { serverPassword } = {}) {
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders({ serverPassword }), signal: timeout(30_000) });
  } catch (err) {
    throw new ApiError(`Could not download ${pathname}: ${err.message}`, { code: 'unreachable' });
  }
  if (!res.ok) {
    throw new ApiError(`The server returned ${res.status}.`, {
      status: res.status, code: res.status === 404 ? 'not_found' : 'media_error',
    });
  }
  return res.blob();
}

async function uploadFile(serverUrl, bytes, contentType) {
  const url = `${normalizeBase(serverUrl)}/api/uploads`;
  const headers = { ...authHeaders(), 'Content-Type': contentType };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: bytes instanceof Blob ? bytes : new Uint8Array(bytes),
      signal: timeout(60_000),
    });
  } catch (err) {
    throw new ApiError(`Upload failed: ${err.message}`, { code: 'unreachable' });
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new ApiError(payload?.message ?? `Upload refused (${res.status}).`, {
      status: res.status, code: payload?.error ?? 'upload_failed',
    });
  }
  return payload;
}

/* Big uploads, in pieces -- the same protocol as the desktop's main/api.js. */
async function uploadRequest(serverUrl, pathname, { body, json, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  const headers = authHeaders();
  if (json) headers['Content-Type'] = 'application/json';
  else if (body) headers['Content-Type'] = 'application/octet-stream';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: json ? JSON.stringify(json) : body,
      signal: timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(`Upload failed: ${err.message}`, { code: 'unreachable' });
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const error = new ApiError(payload?.message ?? `Upload refused (${res.status}).`, {
      status: res.status, code: payload?.error ?? 'upload_failed',
    });
    error.received = payload?.received;
    throw error;
  }
  return payload;
}

const uploadSession = {
  open: (s, size, contentType) => uploadRequest(s, '/api/uploads/sessions', { json: { size, contentType } }),
  // A Blob slice: the browser reads it from disk as it sends.
  chunk: (s, id, offset, blob) => uploadRequest(
    s, `/api/uploads/sessions/${encodeURIComponent(id)}/chunk?offset=${Number(offset)}`,
    { body: blob, timeoutMs: 5 * 60_000 },
  ),
  finish: (s, id) => uploadRequest(
    s, `/api/uploads/sessions/${encodeURIComponent(id)}/finish`, { json: {}, timeoutMs: 60_000 },
  ),
  cancel: (s, id) => uploadRequest(
    s, `/api/uploads/sessions/${encodeURIComponent(id)}/cancel`, { json: {} },
  ).catch(() => null),
};

/**
 * Private conversations: the paths they use, and nothing else. See main/api.js,
 * which this mirrors: the same narrow door and the same answers as data.
 */
const DM_PATH = new RegExp(
  '^/api/(keys(/wrap|/lookup)?|inbox'
  + '|dms(/blocks|/\\d+(/(messages|read|clear))?)?'
  + '|dm-messages/\\d+/(edit|edits|delete|react))(\\?[A-Za-z0-9=&,._-]*)?$',
);

async function dmRequest(serverUrl, method, pathname, body) {
  if (!['GET', 'POST'].includes(method) || !DM_PATH.test(String(pathname))) {
    throw new ApiError('Not a private-conversation request.', { code: 'bad_request' });
  }
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  let res;
  try {
    const headers = authHeaders();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      timedOut(err)
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

async function dmUpload(serverUrl, conversationId, bytes) {
  if (!Number.isSafeInteger(Number(conversationId))) throw new ApiError('Bad conversation.', { code: 'bad_request' });
  const url = `${normalizeBase(serverUrl)}/api/dms/${Number(conversationId)}/uploads`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
      signal: timeout(120_000),
    });
  } catch (err) {
    throw new ApiError(`Upload failed: ${err.message}`, { code: 'unreachable' });
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, body: payload };
}

async function dmDownload(serverUrl, conversationId, hash) {
  if (!Number.isSafeInteger(Number(conversationId)) || !/^[0-9a-f]{64}$/.test(String(hash))) {
    throw new ApiError('Bad file.', { code: 'bad_request' });
  }
  const url = `${normalizeBase(serverUrl)}/api/dms/${Number(conversationId)}/uploads/${hash}`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders(), signal: timeout(120_000) });
  } catch (err) {
    throw new ApiError(`Could not download the file: ${err.message}`, { code: 'unreachable' });
  }
  if (!res.ok) return { status: res.status, bytes: null };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

export const api = {
  dmRequest,
  dmUpload,
  dmDownload,
  setPassword: (value) => {
    password = String(value ?? '');
    return { ok: true };
  },
  setSessionToken: (value) => {
    sessionToken = String(value ?? '');
    return { ok: true };
  },

  health: (s) => requestJson(s, '/api/health', { timeoutMs: HEALTH_TIMEOUT_MS }),
  probe: (s, serverPassword) =>
    requestJson(s, '/api/health', { serverPassword: serverPassword ?? '', timeoutMs: HEALTH_TIMEOUT_MS }),

  register: (s, nickname, password_, ownerKey) =>
    requestJson(s, '/api/accounts/register', {
      method: 'POST', body: { nickname, password: password_, ...(ownerKey ? { ownerKey } : {}) },
    }),
  login: (s, nickname, password_, ownerKey) =>
    requestJson(s, '/api/accounts/login', {
      method: 'POST', body: { nickname, password: password_, ...(ownerKey ? { ownerKey } : {}) },
    }),
  logout: (s) => requestJson(s, '/api/accounts/logout', { method: 'POST' }),

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

  channels: (s) => requestJson(s, '/api/channels'),
  createChannel: (s, body) => requestJson(s, '/api/channels', { method: 'POST', body }),
  updateChannel: (s, id, body) => requestJson(s, `/api/channels/${id}`, { method: 'POST', body }),
  deleteChannel: (s, id) => requestJson(s, `/api/channels/${id}/delete`, { method: 'POST' }),
  reorderChannels: (s, ids) => requestJson(s, '/api/channels/reorder', { method: 'POST', body: { ids } }),
  me: (s) => requestJson(s, '/api/accounts/me'),
  setAvatar: (s, hash) => requestJson(s, '/api/accounts/avatar', { method: 'POST', body: { hash } }),
  setBanner: (s, hash) => requestJson(s, '/api/accounts/banner', { method: 'POST', body: { hash } }),
  setJoinSound: (s, hash) => requestJson(s, '/api/accounts/join-sound', { method: 'POST', body: { hash } }),
  badges: (s) => requestJson(s, '/api/badges'),
  createBadge: (s, body) => requestJson(s, '/api/badges', { method: 'POST', body: body }),
  updateBadge: (s, id, body) => requestJson(s, `/api/badges/${id}`, { method: 'POST', body: body }),
  deleteBadge: (s, id) => requestJson(s, `/api/badges/${id}/delete`, { method: 'POST' }),
  setUserBadges: (s, id, badges) => requestJson(s, `/api/accounts/${id}/badges`, { method: 'POST', body: { badges } }),
  setNameColor: (s, nameColor) =>
    requestJson(s, '/api/accounts/name-color', { method: 'POST', body: { nameColor } }),
  setNameFont: (s, font) => requestJson(s, '/api/accounts/name-font', { method: 'POST', body: { font } }),
  roster: (s) => requestJson(s, '/api/accounts'),
  setRole: (s, id, role) => requestJson(s, `/api/accounts/${id}/role`, { method: 'POST', body: { role } }),
  deleteAccount: (s, id) => requestJson(s, `/api/accounts/${id}/delete`, { method: 'POST' }),

  roles: (s) => requestJson(s, '/api/roles'),
  createRole: (s, body) => requestJson(s, '/api/roles', { method: 'POST', body: body }),
  updateRole: (s, id, body) => requestJson(s, `/api/roles/${id}`, { method: 'POST', body: body }),
  deleteRole: (s, id) => requestJson(s, `/api/roles/${id}/delete`, { method: 'POST' }),
  reorderRoles: (s, ids) => requestJson(s, '/api/roles/reorder', { method: 'POST', body: { ids } }),
  setUserRoles: (s, id, roles) => requestJson(s, `/api/accounts/${id}/roles`, { method: 'POST', body: { roles } }),
  kickUser: (s, id) => requestJson(s, `/api/accounts/${id}/kick`, { method: 'POST' }),
  banUser: (s, id, banned) => requestJson(s, `/api/accounts/${id}/ban`, { method: 'POST', body: { banned } }),
  updateGroup: (s, id, body) => requestJson(s, `/api/channels/groups/${id}`, { method: 'POST', body: body }),
  serverInfo: (s) => requestJson(s, '/api/server'),
  updateServer: (s, body) => requestJson(s, '/api/server', { method: 'POST', body }),

  createGroup: (s, name, extra) =>
    requestJson(s, '/api/channels/groups', { method: 'POST', body: { ...extra, name } }),
  renameGroup: (s, id, name) =>
    requestJson(s, `/api/channels/groups/${id}`, { method: 'POST', body: { name } }),
  deleteGroup: (s, id) => requestJson(s, `/api/channels/groups/${id}/delete`, { method: 'POST' }),
  arrange: (s, body) => requestJson(s, '/api/channels/arrange', { method: 'POST', body }),

  renameClip: (s, id, body) => requestJson(s, `/api/soundpad/${id}/rename`, { method: 'POST', body }),
  setDisplayName: (s, displayName) =>
    requestJson(s, '/api/accounts/display-name', { method: 'POST', body: { displayName } }),
  streams: (s) => requestJson(s, '/api/streams'),
  session: (s, username, token, kind) =>
    requestJson(s, '/api/session', {
      method: 'POST', body: { username, token, ...(kind ? { kind } : {}) },
    }),
  heartbeat: (s, username, token) =>
    requestJson(s, '/api/session/heartbeat', { method: 'POST', body: { username, token } }),
  release: (s, username, token) =>
    requestJson(s, '/api/session/release', { method: 'POST', body: { username, token } }),
  sdp: (url, offer) => sdpExchange(url, offer),
  hangup: (resourceUrl) => deleteResource(resourceUrl).then(() => true),

  messages: (s, id, before) =>
    requestJson(s, `/api/channels/${id}/messages${before ? `?before=${before}` : ''}`),
  postMessage: (s, id, body) => requestJson(s, `/api/channels/${id}/messages`, { method: 'POST', body }),
  pinMessage: (s, id, pinned) => requestJson(s, `/api/messages/${id}/pin`, { method: 'POST', body: { pinned } }),
  deleteMessage: (s, id) => requestJson(s, `/api/messages/${id}/delete`, { method: 'POST' }),
  editMessage: (s, id, body) => requestJson(s, `/api/messages/${id}/edit`, { method: 'POST', body: { body } }),
  setAttachment: (s, id, body) => requestJson(s, `/api/messages/${id}/attachment`, { method: 'POST', body }),
  react: (s, id, emoji, on) =>
    requestJson(s, `/api/messages/${id}/react`, { method: 'POST', body: { emoji, on } }),

  emojis: (s) => requestJson(s, '/api/emojis'),
  addEmoji: (s, body) => requestJson(s, '/api/emojis', { method: 'POST', body }),
  deleteEmoji: (s, id) => requestJson(s, `/api/emojis/${id}/delete`, { method: 'POST' }),

  soundpad: (s) => requestJson(s, '/api/soundpad'),
  addClip: (s, body) => requestJson(s, '/api/soundpad', { method: 'POST', body }),
  deleteClip: (s, id) => requestJson(s, `/api/soundpad/${id}/delete`, { method: 'POST' }),
  reorderClips: (s, ids) => requestJson(s, '/api/soundpad/reorder', { method: 'POST', body: { ids } }),
  search: (s, id, q) => requestJson(s, `/api/channels/${id}/search?q=${encodeURIComponent(q)}`),

  // Not on the desktop's list: these are what the main process does for it.
  mediaKey: (s) => requestJson(s, '/api/media-key'),
  uploadFile,
  uploadOpen: uploadSession.open,
  uploadChunk: uploadSession.chunk,
  uploadFinish: uploadSession.finish,
  uploadCancel: uploadSession.cancel,
};
