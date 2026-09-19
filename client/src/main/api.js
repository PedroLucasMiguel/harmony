// All HTTP lives in the main process.
//
// The renderer owns the RTCPeerConnection but never makes a network request
// itself. Keeping fetch on this side means the UI can run on a secure custom
// scheme (needed for ES modules, AudioWorklet and getDisplayMedia) while still
// talking to a plain-HTTP server on a LAN -- no CORS preflights, no
// mixed-content blocking, and MediaMTX's allow-origin settings stop mattering.

const REQUEST_TIMEOUT_MS = 10_000;
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

async function requestJson(serverUrl, pathname, { method = 'GET', body } = {}) {
  const url = `${normalizeBase(serverUrl)}${pathname}`;
  let res;
  try {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (password) headers['X-Harmony-Password'] = password;

    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
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
  health: (s) => requestJson(s, '/api/health'),
  streams: (s) => requestJson(s, '/api/streams'),
  // `token` is sent only when reclaiming a username this client already holds.
  session: (s, username, token) =>
    requestJson(s, '/api/session', { method: 'POST', body: { username, token } }),
  heartbeat: (s, username, token) =>
    requestJson(s, '/api/session/heartbeat', { method: 'POST', body: { username, token } }),
  release: (s, username, token) =>
    requestJson(s, '/api/session/release', { method: 'POST', body: { username, token } }),
  sdpExchange,
  deleteResource,
};
