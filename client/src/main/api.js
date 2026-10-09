// All HTTP lives in the main process.
//
// The renderer owns the RTCPeerConnection but never makes a network request
// itself. Keeping fetch on this side means the UI can run on a secure custom
// scheme (needed for ES modules, AudioWorklet and getDisplayMedia) while still
// talking to a plain-HTTP server on a LAN -- no CORS preflights, no
// mixed-content blocking, and MediaMTX's allow-origin settings stop mattering.

const REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long to wait for a server to say whether it is there. Shorter than an
 * ordinary request, because a server that is down would otherwise hold the
 * connect screen for the full ten seconds before saying so.
 */
const HEALTH_TIMEOUT_MS = 5_000;
const SDP_TIMEOUT_MS = 20_000;

/**
 * The server password, if the server asks for one.
 *
 * Held here rather than passed through every call: it belongs to the server
 * address, not to any one request, and threading it through six signatures
 * would mean six chances to forget it on the call that matters. The renderer
 * sets it once, before anything else talks to the server.
 *
 * Media URLs are not covered by this -- they carry a token the control server
 * puts in them, so the password itself never reaches MediaMTX.
 */
let password = '';
const setPassword = (value) => {
  password = String(value ?? '');
  return { ok: true };
};

/**
 * The logged-in account's bearer token, held for the same reason as the
 * password above: it belongs to the connection, not to any one call.
 *
 * Note this is the session token and NOT the account password. The renderer
 * never holds the password after login, and "remember me" persists this token
 * instead -- it expires on its own and can be revoked server-side, neither of
 * which is true of a stored password.
 */
let sessionToken = '';
const setSessionToken = (value) => {
  sessionToken = String(value ?? '');
  return { ok: true };
};

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
    const door = foreign ? serverPassword : password;
    if (door) headers['X-Harmony-Password'] = door;
    if (sessionToken && !foreign) headers.Authorization = `Bearer ${sessionToken}`;

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
  if (password) headers['X-Harmony-Password'] = password;
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

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
  if (password) headers['X-Harmony-Password'] = password;
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

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
  roster: (s) => requestJson(s, '/api/accounts'),
  setRole: (s, id, role) =>
    requestJson(s, `/api/accounts/${id}/role`, { method: 'POST', body: { role } }),
  // Takes the account and everything written under it. Owner only, server
  // side; the client hides the control for everybody else.
  deleteAccount: (s, id) =>
    requestJson(s, `/api/accounts/${id}/delete`, { method: 'POST' }),

  serverInfo: (s) => requestJson(s, '/api/server'),
  updateServer: (s, body) => requestJson(s, '/api/server', { method: 'POST', body }),

  createGroup: (s, name) =>
    requestJson(s, '/api/channels/groups', { method: 'POST', body: { name } }),
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

  // Messages
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
