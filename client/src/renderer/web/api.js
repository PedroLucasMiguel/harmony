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

export const api = {
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

  channels: (s) => requestJson(s, '/api/channels'),
  createChannel: (s, body) => requestJson(s, '/api/channels', { method: 'POST', body }),
  updateChannel: (s, id, body) => requestJson(s, `/api/channels/${id}`, { method: 'POST', body }),
  deleteChannel: (s, id) => requestJson(s, `/api/channels/${id}/delete`, { method: 'POST' }),
  reorderChannels: (s, ids) => requestJson(s, '/api/channels/reorder', { method: 'POST', body: { ids } }),
  me: (s) => requestJson(s, '/api/accounts/me'),
  setAvatar: (s, hash) => requestJson(s, '/api/accounts/avatar', { method: 'POST', body: { hash } }),
  roster: (s) => requestJson(s, '/api/accounts'),
  setRole: (s, id, role) => requestJson(s, `/api/accounts/${id}/role`, { method: 'POST', body: { role } }),
  deleteAccount: (s, id) => requestJson(s, `/api/accounts/${id}/delete`, { method: 'POST' }),

  serverInfo: (s) => requestJson(s, '/api/server'),
  updateServer: (s, body) => requestJson(s, '/api/server', { method: 'POST', body }),

  createGroup: (s, name) => requestJson(s, '/api/channels/groups', { method: 'POST', body: { name } }),
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
};
