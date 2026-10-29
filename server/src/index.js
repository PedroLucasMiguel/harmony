// Harmony control server.
//
// Two jobs, nothing more:
//   * /api/*          -- the client asks "is this username free?" and gets back
//                        either a publish token or a watch URL.
//   * /mediamtx/auth  -- MediaMTX asks "may this connection publish/read?".
//
// No media touches this process.

import express from 'express';
import { config, iceServers, whepUrl, whipUrl } from './config.js';
import { LoginLimiter, secretsMatch } from './auth.js';
import { MediaMtxMonitor } from './mediamtx-api.js';
import { Rooms, normalizeUsername, normalizePath } from './rooms.js';
import { ensureDataDir, openDatabase, meta } from './db.js';
import { ServerSettings } from './server-settings.js';
import { Accounts, NAME_FONTS, NAME_COLOR_SPEED, claimOwner, ensureOwnerToken, publicUser } from './accounts.js';
import { wavSeconds } from './wav.js';
import {
  Channels,
  VoiceRooms,
  channelPath,
  channelSecret,
  mintChannelToken,
  parseChannelPath,
  publicChannel,
  publicGroup,
  readChannelToken,
  MEDIA_KINDS,
} from './channels.js';
import { Realtime } from './realtime.js';
import { Roles, channelViewFor } from './roles.js';
import { mountBadges, mountRoles } from './roles-routes.js';
import { Badges } from './badges.js';
import { mintMediaKey, verifyMediaKey } from './media-keys.js';
import {
  Chat, Soundpad, Emojis,
  publicMessage, publicClip, publicEmoji, mediaTypeOf, mentionsIn,
  MAX_UPLOAD_BYTES, MAX_AVATAR_BYTES, MAX_BANNER_BYTES, MAX_JOIN_SOUND_BYTES,
  MAX_JOIN_SOUND_SECONDS, MAX_CLIP_BYTES, MAX_EMOJI_BYTES, MAX_EMOJIS,
  MAX_FILE_LIMIT, DEFAULT_FILE_BYTES, SEALED_TYPE,
} from './chat.js';
import { UploadSessions } from './upload-sessions.js';
import { DirectMessages } from './dms.js';
import { mountDirectMessages } from './dm-routes.js';
import { Recovery, mountRecovery } from './recovery.js';

const app = express();
app.disable('x-powered-by');

/**
 * Trust only a proxy on this machine -- Caddy, or a Cloudflare Tunnel connector.
 *
 * `true` would trust the whole X-Forwarded-For chain, and every entry in that
 * header except the one our own proxy appends is written by the client. With a
 * password to guess that is not academic: the rate limiter is keyed on the
 * address, so a spoofable address is a rate limiter that can be stepped around
 * by changing one header. 'loopback' makes Express walk back only through
 * proxies it actually trusts, landing on the address Caddy observed.
 */
app.set('trust proxy', 'loopback');
/*
 * Request bodies are small JSON everywhere except a private conversation's
 * routes, where a message arrives sealed: a 4000-character body that is all
 * emoji is 16 KB of UTF-8 before it is encrypted and base64'd. Those get a
 * bigger allowance -- still a ceiling, enforced again per field in dms.js --
 * and everything else keeps the tight one.
 */
const smallJson = express.json({ limit: '16kb' });
const sealedJson = express.json({ limit: '96kb' });
// Not for an upload: a file that happens to be JSON is a file, and the parser
// would read it as a request body (and refuse anything past 16 kb of it).
const isUpload = (path) => path === '/api/uploads' || /^\/api\/dms\/\d+\/uploads$/.test(path);
app.use((req, res, next) => {
  if (isUpload(req.path)) return next();
  return (req.path.startsWith('/api/dm') ? sealedJson : smallJson)(req, res, next);
});

const db = openDatabase({ dataDir: ensureDataDir(config.dataDir) });
const metaStore = meta(db);
const accounts = new Accounts(db);
ensureOwnerToken(accounts, metaStore);

const roles = new Roles(db);
const badges = new Badges(db);
const channels = new Channels(db);
const voice = new VoiceRooms();
const mediaSecret = channelSecret(metaStore);
const chat = new Chat(db, { dataDir: config.dataDir, maxDiskBytes: config.maxDiskBytes });
const uploads = new UploadSessions(chat);
const soundpad = new Soundpad(db);
const emojis = new Emojis(db);
const dms = new DirectMessages(db);
const recovery = new Recovery(db);
/*
 * The name and the door key.
 *
 * The environment is still the default; this only looks at server_meta once
 * the owner has set something there. config.password is read exactly once
 * more, to seed it, and nothing else in this file should consult it again.
 */
const serverSettings = new ServerSettings(metaStore, { envPassword: config.password });

const rooms = new Rooms({ claimTtlMs: config.claimTtlMs });
const limiter = new LoginLimiter({
  maxAttempts: config.maxLoginAttempts,
  lockoutMinutes: config.lockoutMinutes,
});

/**
 * A second limiter for account logins, keyed by nickname rather than address.
 *
 * The shared-password limiter is keyed by IP, which is the right control for
 * "someone is guessing the door key". It is the wrong one here: everybody
 * behind one NAT shares an address, so one person fat-fingering their password
 * would lock out the household. Keying by nickname also means an attacker who
 * rotates addresses still cannot grind a single account.
 */
const loginLimiter = new LoginLimiter({
  maxAttempts: config.maxLoginAttempts,
  lockoutMinutes: config.lockoutMinutes,
});
/**
 * Wrong "current password" tries by somebody ALREADY signed in -- changing the
 * password, setting recovery questions. Separate from the login limiter on
 * purpose: somebody holding a stolen session must not be able to lock the real
 * owner out of signing in by guessing here.
 */
const passwordLimiter = new LoginLimiter({
  maxAttempts: config.maxLoginAttempts,
  lockoutMinutes: config.lockoutMinutes,
});
const monitor = new MediaMtxMonitor({
  apiUrl: config.mediamtxApi,
  intervalMs: config.pollIntervalMs,
});

monitor.on('paths', (paths) => rooms.syncFromPaths(paths));
monitor.on('down', (err) => console.warn(`[mediamtx] control API unreachable: ${err.message}`));
monitor.on('up', () => console.log('[mediamtx] control API connected'));

// The desktop client is not served from a browser origin, but allowing CORS
// keeps a plain browser usable for the read-only stream list.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Harmony-Password, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Read by the web build's download progress.
  res.set('Access-Control-Expose-Headers', 'Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/**
 * Gate for everything except /api/health.
 *
 * On an open server this is a no-op, so the un-passworded deployment keeps
 * exactly the behaviour it had. The password may arrive as a header or in the
 * JSON body; the header is what the client uses, the body form is there so the
 * endpoint can be exercised with curl.
 */
function requirePassword(req, res, next) {
  if (!serverSettings.passwordRequired) return next();

  const key = req.ip ?? 'unknown';
  const gate = limiter.check(key);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec: gate.retryAfterSec,
      message: `Too many wrong passwords. Try again in ${formatWait(gate.retryAfterSec)}.`,
    });
  }

  const offered = req.get('x-harmony-password') ?? req.body?.password;

  // Offering nothing is not a guess, and must not burn an attempt. The client
  // asks for the stream list as soon as it opens, before the user has typed
  // anything -- counting that would let someone lock themselves out of their
  // own server in three refreshes without ever getting a password wrong.
  if (!offered) {
    return res.status(401).json({
      error: 'password_required',
      message: 'This server needs a password.',
    });
  }

  if (serverSettings.matches(offered)) {
    limiter.succeed(key);
    return next();
  }

  const result = limiter.fail(key);
  console.warn(
    `[auth] wrong password from ${key}` +
      (result.locked ? ` -- locked out for ${formatWait(result.retryAfterSec)}` : ''),
  );
  if (result.locked) {
    res.set('Retry-After', String(result.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec: result.retryAfterSec,
      message: `Too many wrong passwords. Try again in ${formatWait(result.retryAfterSec)}.`,
    });
  }
  return res.status(401).json({
    error: 'bad_password',
    attemptsLeft: result.attemptsLeft,
    message: `Wrong password. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left before a lockout.`,
  });
}

function formatWait(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

// ---------------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------------

/**
 * Deliberately outside the password gate: the client has to be able to ask
 * "does this server want a password?" before it can sensibly prompt for one.
 * It gives away nothing but that answer until the caller authenticates.
 */
app.get('/api/health', (req, res) => {
  // Checking the password here used to be free: no rate limiting, so
  // `authenticated` flipped to true on a correct guess without ever burning an
  // attempt -- an unmetered oracle sitting next to a metered one. Offering
  // nothing is still free, because the client probes this endpoint before the
  // user has typed anything.
  let authed = !serverSettings.passwordRequired;
  if (serverSettings.passwordRequired) {
    const offered = req.get('x-harmony-password');
    const key = req.ip ?? 'unknown';
    const gate = limiter.check(key);
    if (offered && !gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({
        error: 'locked_out',
        retryAfterSec: gate.retryAfterSec,
        message: `Too many wrong passwords. Try again in ${formatWait(gate.retryAfterSec)}.`,
      });
    }
    if (offered) {
      authed = serverSettings.matches(offered);
      if (authed) limiter.succeed(key);
      else limiter.fail(key);
    }
  }
  res.json({
    ok: monitor.reachable,
    mediamtx: monitor.reachable ? 'up' : 'down',
    passwordRequired: serverSettings.passwordRequired,
    authenticated: authed,
    // What this server can do beyond the basics, for a client to ask before it
    // relies on it. Private conversations themselves are told by their routes
    // answering at all (a 404 on /api/keys is a server without them).
    // `dm-clear`: deleting a conversation for yourself. Ciranda's list also
    // has `inbox`, which promises sockets that carry only private messages;
    // Harmony's sockets are all the same kind, so it is not claimed here.
    features: ['dm-clear'],
    ...(authed
      ? {
          name: serverSettings.name,
          // The hash, not the picture: a client compares it with the copy it
          // cached and only downloads on a change (GET /api/server/logo).
          logo: serverSettings.logo,
          signalingBase: config.signalingBase,
          liveStreams: rooms.listLive().length,
          // Lets the client show "create the first account" rather than a
          // login form on a brand new server.
          hasAccounts: !accounts.isEmpty,
          needsOwner: !accounts.hasOwner,
        }
      : {}),
  });
});

/**
 * A stored file, by media key rather than by headers.
 *
 * For clients that load uploads straight into <img>/<video>/<audio> -- the
 * browser and Android builds -- which cannot attach the door password or a
 * session token to those requests. The key stands in for both: it is only
 * issued behind the door and a login (GET /api/media-key), and it names the
 * account, which must still exist. Registered BEFORE the door on purpose;
 * the key is what was checked at the door. See media-keys.js.
 */
app.get('/api/media/:hash', (req, res) => {
  const userId = verifyMediaKey(mediaSecret, req.query.k);
  if (!userId || !accounts.byId(userId)) {
    return res.status(401).json({ error: 'bad_media_key', message: 'That media link has expired.' });
  }
  return sendUpload(req, res);
});

app.use('/api', requirePassword);

// ---------------------------------------------------------------------------
// Accounts
//
// These sit BEHIND the shared password: it is still the door, accounts are the
// rooms. A stranger cannot reach any of this, let alone enumerate nicknames.
// ---------------------------------------------------------------------------

/**
 * Resolve `Authorization: Bearer <token>` to req.user, or leave it undefined.
 *
 * Never rejects on its own -- plenty of routes are usable logged out, and the
 * ones that are not say so themselves. That keeps "who may do this" next to the
 * thing being done rather than in a middleware chain.
 */
app.use('/api', (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const user = accounts.resolveSession(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
});

const requireLogin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'login_required', message: 'Log in first.' });
  }
  return next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'login_required', message: 'Log in first.' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission.' });
  }
  return next();
};

app.post('/api/accounts/register', async (req, res) => {
  const result = await accounts.register(req.body?.nickname, req.body?.password);
  if (!result.ok) {
    const messages = {
      invalid_nickname:
        '2-20 characters: letters, digits, hyphen or underscore, starting with a letter or '
        + 'digit. Cannot start with "vc-" or end with "-cam".',
      weak_password: 'Use at least 6 characters.',
      nickname_taken: 'That nickname is already registered.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }

  // The owner key is offered at registration so claiming ownership is one step
  // rather than "register, then find the other box".
  const becameOwner = req.body?.ownerKey
    ? claimOwner(accounts, metaStore, result.user.id, req.body.ownerKey)
    : false;

  const user = accounts.find(result.user.nickname);
  const token = accounts.startSession(user.id);
  /*
   * Everybody else learns there is somebody new.
   *
   * The member list is drawn from the accounts each client already holds,
   * crossed with who is online -- so a new account appeared in nobody's
   * list until they restarted, even once its owner was online. user:updated
   * is what every client already handles by adding to that map; a new
   * account is just one nobody had yet.
   */
  realtime?.broadcast({ type: 'user:updated', user: publicUser(user) });
  return res.status(201).json({
    user: publicUser(user),
    token,
    ownerClaimed: becameOwner,
    // Tell them the key was wrong rather than silently making them a member.
    ownerKeyRejected: Boolean(req.body?.ownerKey) && !becameOwner,
  });
});

app.post('/api/accounts/login', async (req, res) => {
  const nickname = String(req.body?.nickname ?? '').trim().toLowerCase();
  const gate = loginLimiter.check(nickname);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec: gate.retryAfterSec,
      message: `Too many wrong passwords for "${nickname}". Try again in ${formatWait(gate.retryAfterSec)}.`,
    });
  }

  const user = await accounts.verify(nickname, req.body?.password);
  if (!user) {
    const result = loginLimiter.fail(nickname);
    if (result.locked) {
      res.set('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        error: 'locked_out',
        retryAfterSec: result.retryAfterSec,
        message: `Too many wrong passwords. Try again in ${formatWait(result.retryAfterSec)}.`,
      });
    }
    // One message for "no such account" and "wrong password" -- the pair would
    // otherwise tell an attacker which nicknames exist.
    return res.status(401).json({
      error: 'bad_credentials',
      attemptsLeft: result.attemptsLeft,
      message: 'Wrong nickname or password.',
    });
  }
  loginLimiter.succeed(nickname);

  // After the password, not before: telling somebody they are banned before
  // they have proved they are who they say is a way to learn who is.
  if (user.banned_at) {
    return res.status(403).json({
      error: 'banned',
      message: 'This account has been banned from the server.',
    });
  }

  const becameOwner = req.body?.ownerKey
    ? claimOwner(accounts, metaStore, user.id, req.body.ownerKey)
    : false;

  const token = accounts.startSession(user.id);
  return res.json({
    user: publicUser(accounts.find(user.nickname)),
    token,
    ownerClaimed: becameOwner,
    ownerKeyRejected: Boolean(req.body?.ownerKey) && !becameOwner,
  });
});

app.post('/api/accounts/logout', (req, res) => {
  if (req.sessionToken) accounts.endSession(req.sessionToken);
  res.json({ ok: true });
});

app.get('/api/accounts/me', requireLogin, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/accounts/password', requireLogin, async (req, res) => {
  const key = `u${req.user.id}`;
  const gate = passwordLimiter.check(key);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec: gate.retryAfterSec,
      message: `Too many wrong passwords. Try again in ${formatWait(gate.retryAfterSec)}.`,
    });
  }
  const ok = await accounts.verify(req.user.nickname, req.body?.current);
  if (!ok) {
    const failed = passwordLimiter.fail(key);
    if (failed.locked) {
      res.set('Retry-After', String(failed.retryAfterSec));
      return res.status(429).json({
        error: 'locked_out',
        retryAfterSec: failed.retryAfterSec,
        message: `Too many wrong passwords. Try again in ${formatWait(failed.retryAfterSec)}.`,
      });
    }
    return res.status(401).json({ error: 'bad_credentials', message: 'Current password is wrong.' });
  }
  passwordLimiter.succeed(key);
  const result = await accounts.changePassword(req.user.id, req.body?.password);
  if (!result.ok) {
    return res.status(400).json({ error: result.error, message: 'Use at least 6 characters.' });
  }
  // changePassword drops every session for this account, including this one.
  return res.json({ ok: true, token: accounts.startSession(req.user.id) });
});

mountRecovery(app, {
  requireLogin, accounts, recovery, loginLimiter, passwordLimiter, publicUser,
});

/**
 * Set or clear your profile picture.
 *
 * Two steps on purpose: the picture is uploaded through /api/uploads like any
 * other file, and this only points the account at it. That means avatars
 * inherit the content-type allowlist, the disk quota and the content-addressed
 * storage for free, and two people who pick the same picture cost one copy.
 *
 * The reference juggling is the part that matters. An avatar nobody references
 * is an orphan the moment the next upload needs room, so the new file is
 * retained BEFORE the old one is released -- re-setting the same picture must
 * not momentarily drop it to zero.
 */
app.post('/api/accounts/avatar', requireLogin, (req, res) => {
  const hash = req.body?.hash == null ? null : String(req.body.hash);

  if (hash !== null) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return res.status(400).json({ error: 'bad_hash', message: 'That is not an uploaded file.' });
    }
    const upload = chat.fileInfo(hash);
    if (!upload) {
      return res.status(400).json({ error: 'no_such_upload', message: 'Upload the picture first.' });
    }
    if (mediaTypeOf(upload.content_type) !== 'image') {
      return res.status(400).json({
        error: 'not_an_image',
        message: 'A profile picture has to be an image.',
      });
    }
    if (upload.bytes > MAX_AVATAR_BYTES) {
      return res.status(400).json({
        error: 'avatar_too_large',
        message: `Profile pictures are limited to ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.`,
      });
    }
    chat.retain(hash);
  }

  const result = accounts.setAvatar(req.user.id, hash);
  if (!result.ok) return res.status(404).json({ error: result.error });
  if (result.previous && result.previous !== hash) chat.release(result.previous);

  const user = publicUser(result.user);
  // Everyone draws everyone else's picture, so everyone needs to know.
  realtime?.broadcast({ type: 'user:updated', user });
  return res.json({ user });
});

/**
 * Set or clear one of the files on your profile: the banner or the join sound.
 *
 * The same two steps and the same reference juggling as the avatar (see
 * above): uploaded first, retained BEFORE the old one is released. `check`
 * returns an error body for a file that does not qualify, or null.
 */
function setProfileFile(req, res, { set, check }) {
  const hash = req.body?.hash == null ? null : String(req.body.hash);

  if (hash !== null) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return res.status(400).json({ error: 'bad_hash', message: 'That is not an uploaded file.' });
    }
    const upload = chat.fileInfo(hash);
    if (!upload) {
      return res.status(400).json({ error: 'no_such_upload', message: 'Upload the file first.' });
    }
    const refusal = check(upload);
    if (refusal) return res.status(400).json(refusal);
    chat.retain(hash);
  }

  const result = set(req.user.id, hash);
  if (!result.ok) return res.status(404).json({ error: result.error });
  if (result.previous && result.previous !== hash) chat.release(result.previous);

  const user = publicUser(result.user);
  realtime?.broadcast({ type: 'user:updated', user });
  return res.json({ user });
}

/** Your profile banner: any picture or GIF, up to MAX_BANNER_BYTES. */
app.post('/api/accounts/banner', requireLogin, (req, res) => setProfileFile(req, res, {
  set: (id, hash) => accounts.setBanner(id, hash),
  check: (upload) => {
    if (mediaTypeOf(upload.content_type) !== 'image') {
      return { error: 'not_an_image', message: 'A banner has to be an image or a GIF.' };
    }
    if (upload.bytes > MAX_BANNER_BYTES) {
      return {
        error: 'banner_too_large',
        message: `Banners are limited to ${Math.round(MAX_BANNER_BYTES / 1024 / 1024)} MB.`,
      };
    }
    return null;
  },
}));

/**
 * The sound played to the room when you join it.
 *
 * WAV only, because it is the one format whose length the server can read
 * without a decoder -- see wav.js. The client converts what was picked.
 */
app.post('/api/accounts/join-sound', requireLogin, (req, res) => setProfileFile(req, res, {
  set: (id, hash) => accounts.setJoinSound(id, hash),
  check: (upload) => {
    if (upload.content_type !== 'audio/wav') {
      return { error: 'not_wav', message: 'A join sound has to be a WAV file.' };
    }
    if (upload.bytes > MAX_JOIN_SOUND_BYTES) {
      return {
        error: 'join_sound_too_large',
        message: `Join sounds are limited to ${Math.round(MAX_JOIN_SOUND_BYTES / 1024)} KB.`,
      };
    }
    const seconds = wavSeconds(upload.path);
    if (seconds === null) {
      return { error: 'bad_audio', message: 'That is not a WAV file the server can read.' };
    }
    // A little slack for a header-and-rounding hair over the limit.
    if (seconds > MAX_JOIN_SOUND_SECONDS + 0.1) {
      return {
        error: 'join_sound_too_long',
        message: `Join sounds are limited to ${MAX_JOIN_SOUND_SECONDS} seconds.`,
      };
    }
    return null;
  },
}));

/**
 * The colour of your display name: a solid colour, a gradient that moves, or
 * the rainbow -- or null to go back to the colour of your highest role. See
 * cleanNameColor for the exact shapes; anything else is refused.
 */
app.post('/api/accounts/name-color', requireLogin, (req, res) => {
  const result = accounts.setNameColor(req.user.id, req.body?.nameColor);
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      message: result.error === 'bad_name_color'
        ? `A colour is #rrggbb; a gradient takes 2 to 4 of them; the speed is ${NAME_COLOR_SPEED.min}-${NAME_COLOR_SPEED.max} seconds.`
        : 'No such user.',
    });
  }
  const user = publicUser(result.user);
  realtime?.broadcast({ type: 'user:updated', user });
  return res.json({ user });
});

/** Your display name's font: one of a fixed list, or null for the default. */
app.post('/api/accounts/name-font', requireLogin, (req, res) => {
  const result = accounts.setNameFont(req.user.id, req.body?.font);
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      message: result.error === 'unknown_font'
        ? `Pick one of: ${NAME_FONTS.join(', ')}.` : 'No such user.',
    });
  }
  const user = publicUser(result.user);
  realtime?.broadcast({ type: 'user:updated', user });
  return res.json({ user });
});

/**
 * Change your own display name.
 *
 * Your OWN: there is no id in the path. Renaming other people is not a
 * thing an admin needs to do, and leaving it out means there is no
 * permission check here to get wrong.
 */
app.post('/api/accounts/display-name', requireLogin, (req, res) => {
  const result = accounts.setDisplayName(req.user.id, req.body?.displayName);
  if (!result.ok) {
    const messages = {
      no_such_user: 'No such user.',
      too_long: 'That name is too long. 32 characters at most.',
      bad_characters: 'That name contains characters that cannot be displayed.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }
  const user = publicUser(result.user);
  realtime?.broadcast({ type: 'user:updated', user });
  return res.json({ user });
});

/** Anyone logged in may see the roster; it is a friends' server, not a forum. */
app.get('/api/accounts', requireLogin, (_req, res) => {
  res.json({ users: accounts.list().map((u) => publicUser(u)) });
});

/**
 * Change somebody's ACCOUNT role: owner, "super admin" (users.role 'admin') or
 * member. Nothing to do with the roles in roles.js, which are handed out by
 * POST /api/accounts/:id/roles.
 *
 * The owner's alone. A super admin is an account nothing about which a role
 * can limit, so the only person who may make one is the person nobody can
 * limit either -- and, with symmetric powers, any two super admins could
 * demote each other and the first to click would win. Enforced here rather
 * than by hiding the control, because the control being hidden is a
 * statement about one client's UI and this is a statement about the server.
 */
app.post('/api/accounts/:id/role', requireRole('owner'), (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const role = String(req.body?.role ?? '');

  const result = accounts.setRole(id, role);
  if (!result.ok) {
    const messages = {
      invalid_role: 'Role must be owner, admin or member.',
      no_such_user: 'No such user.',
      last_owner: 'There has to be at least one owner.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }
  const user = publicUser(result.user);
  realtime?.broadcast({ type: 'user:updated', user });
  // A super admin sees every channel; a demoted one stops.
  realtime?.refreshAccess();
  return res.json({ user });
});

/**
 * Everything needed to watch, without reserving anything.
 *
 * The mosaic opens several streams at once, and going through /api/session for
 * each would be a trap: a name that stops being live between the listing and
 * the call comes back as "free", and the viewer would silently claim someone
 * else's username. Watching is public, so the watch URL belongs here.
 */
/**
 * Delete an account, and everything written under it.
 *
 * OWNER ONLY, and not even an admin. Granting admin is reversible and
 * force-muting somebody lasts until they are unmuted; this takes a person's
 * whole history off the server and there is no undo anywhere in the app.
 * The same reasoning already makes removing an admin owner-only.
 *
 * The owner cannot be deleted at all, including by themselves: a server
 * with no owner has no way back short of editing the database by hand.
 */
app.post('/api/accounts/:id/delete', requireRole('owner'), (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const target = accounts.byId(id);
  if (!target) return res.status(404).json({ error: 'no_such_user' });

  const result = accounts.remove(id);
  if (!result.ok) {
    return res.status(result.error === 'cannot_remove_owner' ? 403 : 404).json({
      error: result.error,
      message: result.error === 'cannot_remove_owner'
        ? 'The owner cannot be removed. Hand ownership over first.'
        : 'No such account.',
    });
  }

  // Their sessions went with the row, so every later request fails -- but a
  // socket authenticates once and would go on receiving everything.
  realtime?.kickUser(id);
  // Everything that named them is now wrong: the member list, every message
  // they wrote, every roster they were in.
  realtime?.broadcast({ type: 'accounts', users: accounts.list().map(publicUser) });
  realtime?.broadcastPresence();
  console.warn(`[accounts] ${target.nickname} removed by ${req.user.nickname}, `
    + `${result.messages} messages deleted`);
  return res.json({ ok: true, messages: result.messages });
});

mountRoles(app, { requireLogin, roles, accounts, realtime: () => realtime });
mountBadges(app, {
  requireLogin, roles, badges, accounts, chat, mediaTypeOf, maxImageBytes: MAX_AVATAR_BYTES, realtime: () => realtime,
});

// ---------------------------------------------------------------------------
// The server itself
// ---------------------------------------------------------------------------

/*
 * What the server says about itself, with the upload limits beside the name:
 * everybody's client checks a file against maxFileBytes before sending it,
 * and the owner's settings show the rest.
 */
const serverView = () => ({
  ...serverSettings.publicView(),
  maxFileBytes: chat.maxFileBytes,
  storageBytes: chat.quotaBytes,
  usedBytes: chat.usedBytes,
  diskFreeBytes: chat.diskFreeBytes(),
  maxFileLimit: MAX_FILE_LIMIT,
});

app.get('/api/server', requireLogin, (_req, res) => {
  res.json({ server: serverView() });
});

/**
 * Rename the server, or change the key to its front door.
 *
 * Owner only. `password` is applied only when the field is present at all,
 * so renaming cannot clear the password by omission -- and an empty string
 * IS a value here, meaning "take the door off", which is why the two cases
 * have to be told apart rather than both treated as falsy.
 */
app.post('/api/server', requireRole('owner'), (req, res) => {
  /*
   * The logo: the hash of something already uploaded (POST /api/uploads),
   * or null to take it away -- the same two steps as an avatar, and the same
   * order of references: the new one retained BEFORE the old is released,
   * so setting the same picture again never drops it to zero.
   */
  if (req.body?.logo !== undefined) {
    const hash = req.body.logo === null ? null : String(req.body.logo);
    if (hash !== null) {
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return res.status(400).json({ error: 'bad_hash', message: 'That is not an uploaded file.' });
      }
      const upload = chat.fileInfo(hash);
      if (!upload) {
        return res.status(400).json({ error: 'no_such_upload', message: 'Upload the logo first.' });
      }
      if (mediaTypeOf(upload.content_type) !== 'image') {
        return res.status(400).json({ error: 'not_an_image', message: 'A logo has to be an image.' });
      }
      if (upload.bytes > MAX_AVATAR_BYTES) {
        return res.status(400).json({
          error: 'logo_too_large',
          message: `Server logos are limited to ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.`,
        });
      }
      chat.retain(hash);
    }
    const previous = serverSettings.setLogo(hash);
    if (previous && previous !== hash) chat.release(previous);
  }

  if (req.body?.name !== undefined) serverSettings.setName(req.body.name);
  if (typeof req.body?.password === 'string') serverSettings.setPassword(req.body.password);

  /*
   * The upload limits. null puts one back to its default. The total is not
   * checked against the disk: the disk changes, and the reserve in
   * Chat.makeRoom is what actually keeps the server alive when it fills.
   */
  if (req.body?.maxFileBytes !== undefined) {
    const raw = req.body.maxFileBytes;
    const bytes = raw === null ? null : Math.round(Number(raw));
    if (bytes !== null && !(bytes >= 1024 * 1024 && bytes <= MAX_FILE_LIMIT)) {
      return res.status(400).json({
        error: 'bad_limit',
        message: `The largest file has to be between 1 MB and ${MAX_FILE_LIMIT / 1024 ** 3} GB.`,
      });
    }
    serverSettings.setMaxFileBytes(bytes);
  }
  if (req.body?.storageBytes !== undefined) {
    const raw = req.body.storageBytes;
    const bytes = raw === null ? null : Math.round(Number(raw));
    if (bytes !== null && !(bytes >= 64 * 1024 * 1024 && bytes <= 64 * 1024 ** 4)) {
      return res.status(400).json({
        error: 'bad_limit',
        message: 'Upload storage has to be at least 64 MB.',
      });
    }
    serverSettings.setStorageBytes(bytes);
  }
  applyUploadLimits();

  const view = serverView();
  realtime?.broadcast({ type: 'server', server: view });
  return res.json({ server: view });
});

/** server_meta's limits, or the defaults, into the Chat that enforces them. */
function applyUploadLimits() {
  chat.maxFileBytes = serverSettings.maxFileBytes ?? DEFAULT_FILE_BYTES;
  chat.quotaBytes = serverSettings.storageBytes ?? config.maxDiskBytes;
}
applyUploadLimits();

/*
 * Upload sessions: a big file in chunks, straight to disk. See
 * upload-sessions.js for why, and POST /api/uploads for small ones.
 */
const UPLOAD_ERRORS = {
  file_too_large: () => [413, `Files on this server are limited to ${formatBytes(chat.maxFileBytes)}.`],
  server_full: () => [507, 'The server has run out of space for uploads.'],
  too_many_uploads: () => [429, 'Finish or cancel your other uploads first.'],
  no_such_upload: () => [404, 'That upload has expired. Start it again.'],
  bad_offset: () => [409, 'The upload lost its place.'],
  chunk_too_large: () => [413, 'That piece of the file is too big.'],
  incomplete: () => [409, 'The file has not all arrived yet.'],
  empty_file: () => [400, 'That file is empty.'],
  aborted: () => [400, 'The upload was interrupted.'],
};

/*
 * Express 4 does not catch a rejected promise: an async route that threw
 * would be an unhandled rejection, which ends the process. These are the
 * routes that touch the disk, so they hand errors to Express instead.
 */
const guarded = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sendUploadError(res, result) {
  const [status, message] = (UPLOAD_ERRORS[result.error] ?? (() => [400, 'Upload refused.']))();
  return res.status(status).json({ error: result.error, message, received: result.received });
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

app.post('/api/uploads/sessions', requireLogin, guarded(async (req, res) => {
  const result = await uploads.open({
    userId: req.user.id,
    size: Number(req.body?.size),
    contentType: req.body?.contentType,
  });
  if (!result.ok) return sendUploadError(res, result);
  return res.status(201).json({ id: result.id, chunkBytes: result.chunkBytes });
}));

// The raw body, unparsed: express.json only reads application/json, and a
// chunk is sent as application/octet-stream.
app.post('/api/uploads/sessions/:id/chunk', requireLogin, guarded(async (req, res) => {
  const result = await uploads.append({
    id: String(req.params.id),
    userId: req.user.id,
    offset: Number(req.query.offset),
    body: req,
  });
  if (!result.ok) return sendUploadError(res, result);
  return res.json({ received: result.received });
}));

app.post('/api/uploads/sessions/:id/finish', requireLogin, guarded(async (req, res) => {
  const result = await uploads.finish({ id: String(req.params.id), userId: req.user.id });
  if (!result.ok) return sendUploadError(res, result);
  return res.status(201).json({
    hash: result.upload.hash,
    contentType: result.upload.content_type,
    bytes: result.upload.bytes,
    deduplicated: result.deduplicated,
    usedBytes: chat.usedBytes,
    quotaBytes: chat.quotaBytes,
  });
}));

app.post('/api/uploads/sessions/:id/cancel', requireLogin, guarded(async (req, res) => {
  await uploads.cancel({ id: String(req.params.id), userId: req.user.id });
  return res.json({ ok: true });
}));

/**
 * The server's logo, as an image.
 *
 * Behind the door password like everything else, but NOT behind a login:
 * the client's server list asks every saved server for its logo with that
 * server's own password and no session token -- which is the point, since a
 * session belongs to one server and is never sent to another. The file is
 * content-addressed, so it can be cached forever; a new logo is a new hash,
 * which /api/health reports.
 */
app.get('/api/server/logo', (_req, res) => {
  const hash = serverSettings.logo;
  const info = hash ? chat.fileInfo(hash) : null;
  if (!info) return res.status(404).json({ error: 'no_logo' });
  res.set('Content-Type', info.content_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Harmony-Hash', hash);
  return res.sendFile(info.path);
});

app.get('/api/streams', (_req, res) => {
  res.json({
    streams: rooms.listLive().map((stream) => ({ ...stream, whepUrl: whepUrl(stream.username) })),
    iceServers: iceServers(),
  });
});

// The single entry point behind the username box. Always answers with a role.
app.post('/api/session', (req, res) => {
  /**
   * Who is allowed to claim what.
   *
   * This endpoint used to let anyone past the door password claim any free
   * name. Once nicknames are permanent identities that is impersonation: log in
   * as `bob`, claim the stream name `alice`, and your screen share appears
   * under her name to everyone watching. So an authenticated caller streams
   * under their own nickname and the body's `username` is ignored outright.
   *
   * The anonymous path survives only while no account exists, so an existing
   * 1.0.0 deployment keeps working right up until someone registers. After
   * that, logging in is required -- leaving it open would leave the hole open.
   */
  /*
   * `kind: 'camera'` claims the caller's OWN derived webcam path.
   *
   * It has to be a flag rather than a username, for the same reason the body's
   * username is ignored above: letting the client name the path is exactly the
   * impersonation this endpoint was fixed to prevent. The `-cam` suffix is
   * appended here, server-side, from the authenticated nickname -- and
   * normalizeUsername refuses anything ending in `-cam` as INPUT, so the
   * namespace cannot be squatted.
   */
  const wantsCamera = req.body?.kind === 'camera';
  if (wantsCamera && !req.user) {
    return res.status(401).json({
      error: 'login_required',
      message: 'Sign in before starting your camera.',
    });
  }

  const username = req.user
    ? `${req.user.nickname}${wantsCamera ? '-cam' : ''}`
    : normalizeUsername(req.body?.username);

  if (!req.user && !accounts.isEmpty) {
    return res.status(401).json({
      error: 'login_required',
      message: 'This server has accounts. Log in to stream under your own name.',
    });
  }

  if (!username) {
    return res.status(400).json({
      error: 'invalid_username',
      message: '2-24 characters: letters, digits, hyphen or underscore, starting with a letter or digit.',
    });
  }

  if (!monitor.reachable) {
    return res.status(503).json({
      error: 'media_server_down',
      message: 'The media server is not responding. Try again in a moment.',
    });
  }

  const result = rooms.claim(username, { token: req.body?.token, ip: req.ip });

  if (result.role === 'broadcaster') {
    return res.json({
      role: 'broadcaster',
      username,
      token: result.token,
      whipUrl: whipUrl(username, result.token),
      iceServers: iceServers(),
      heartbeatMs: Math.floor(config.claimTtlMs / 3),
    });
  }

  return res.json({
    role: 'viewer',
    username,
    pending: result.pending,
    whepUrl: whepUrl(username),
    iceServers: iceServers(),
  });
});

app.post('/api/session/heartbeat', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const ok = username && rooms.heartbeat(username, req.body?.token);
  res.status(ok ? 200 : 404).json({ ok: Boolean(ok), live: username ? rooms.isLive(username) : false });
});

app.post('/api/session/release', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const ok = username && rooms.release(username, req.body?.token);
  res.json({ ok: Boolean(ok) });
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Owner, super admin, or somebody whose role says admin. */
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'login_required', message: 'Log in first.' });
  if (!roles.context(req.user).admin) {
    return res.status(403).json({ error: 'forbidden', message: 'Admins only.' });
  }
  return next();
};

/** The same, asked inside a route that needs several answers. */
const may = (req, permission) => roles.context(req.user).can(permission);
const forbid = (res) => res.status(403).json({ error: 'forbidden', message: 'You do not have permission.' });

app.get('/api/channels', requireLogin, (req, res) => {
  const view = channelViewFor({ roles, channels, voice }, req.user);
  const holdsEveryKey = roles.context(req.user).admin;
  res.json({
    channels: view.channels.map((c) => ({
      ...c,
      // So the client can show "you will not be asked again" rather than a
      // padlock on a channel this person already unlocked. An admin has every
      // key, so for them nothing is locked.
      unlocked: !c.locked || holdsEveryKey || channels.hasGrant(c.id, req.user.id),
    })),
    groups: view.groups,
    occupancy: view.occupancy,
    // Derived from open sockets, never stored. Empty when the realtime
    // layer is not up, which is honest: with no sockets nobody is online.
    online: realtime?.onlineUserIds() ?? [],
    // Same payload the WebSocket hello carries, so the read-only fallback
    // path the client uses when the socket is down shows the same sidebar.
    rosters: view.rosters,
  });
});

/*
 * Who may do what to channels, by permission:
 *
 *   channels.create    a channel or a group
 *   channels.edit      rename, move, restrict to roles
 *   channels.password  put a password on a channel or a group, or take it off
 *   channels.delete    delete a channel or a group
 *
 * Owner, super admins and admin roles have all of them. A channel somebody
 * cannot see does not exist for them, so editing one is a 404, not a 403:
 * "forbidden" would tell them it is there.
 */
const CHANNEL_ERRORS = {
  invalid_kind: 'A channel is either voice or text.',
  invalid_name: 'Give it a name of 1-32 characters.',
  no_such_channel: 'No such channel.',
  no_such_group: 'No such group.',
  no_such_role: 'That role does not exist any more.',
  no_such_user: 'That person does not exist any more.',
  follows_group: 'A channel inside a group follows the group: change it there.',
};

const channelFailure = (res, error) => res.status(error?.startsWith('no_such') ? 404 : 400)
  .json({ error, message: CHANNEL_ERRORS[error] });

/** Whether this caller may know that a channel or group is there at all. */
const visibleChannel = (req, id) => {
  const channel = channels.get(id);
  if (!channel) return null;
  const byId = new Map(channels.groups().map((g) => [g.id, g]));
  return roles.canSee(roles.context(req.user), channel, byId) ? channel : null;
};
const visibleGroup = (req, id) => {
  const group = channels.group(id);
  return group && roles.canSeeGroup(roles.context(req.user), group) ? group : null;
};

/** What changed about who can see what: everybody gets the list they may see. */
const channelsChanged = () => realtime?.refreshAccess();

app.post('/api/channels', requireLogin, async (req, res) => {
  if (!may(req, 'channels.create')) return forbid(res);
  // A password or roles on the new channel are the two other permissions.
  if (req.body?.password && !may(req, 'channels.password')) return forbid(res);
  if ((req.body?.roles?.length || req.body?.users?.length) && !may(req, 'channels.edit')) return forbid(res);

  // Inside a group: only a group the caller may see, and its own settings
  // are the group's (see Channels.create).
  const groupId = req.body?.groupId ?? null;
  if (groupId != null && !visibleGroup(req, Number(groupId))) return channelFailure(res, 'no_such_group');

  const result = await channels.create({
    kind: req.body?.kind,
    name: req.body?.name,
    password: req.body?.password,
    groupId,
  });
  if (!result.ok) return channelFailure(res, result.error);

  if (groupId == null && Array.isArray(req.body?.roles) && req.body.roles.length) {
    const restricted = channels.setRoles(result.channel.id, req.body.roles);
    if (!restricted.ok) {
      // Not left open: a channel that was meant to be private and was
      // created public because of a bad role id is a leak.
      channels.remove(result.channel.id);
      return channelFailure(res, restricted.error);
    }
  }
  if (groupId == null && Array.isArray(req.body?.users) && req.body.users.length) {
    const named = channels.setUsers(result.channel.id, req.body.users);
    if (!named.ok) {
      channels.remove(result.channel.id);
      return channelFailure(res, named.error);
    }
  }
  channelsChanged();
  return res.status(201).json({ channel: publicChannel(channels.get(result.channel.id)) });
});

// Registered BEFORE /api/channels/:id on purpose. Express matches routes in
// registration order, so with these the other way round a POST to
// /api/channels/reorder is matched by /:id with id="reorder", parsed as NaN,
// and answered "no such channel" -- a 400 that looks like a validation bug and
// is really a routing one.
app.post('/api/channels/groups', requireLogin, async (req, res) => {
  if (!may(req, 'channels.create')) return forbid(res);
  if (req.body?.password && !may(req, 'channels.password')) return forbid(res);
  if ((req.body?.roles?.length || req.body?.users?.length) && !may(req, 'channels.edit')) return forbid(res);

  const result = channels.createGroup(req.body?.name);
  if (!result.ok) return channelFailure(res, result.error);
  const id = result.group.id;

  if (Array.isArray(req.body?.roles) && req.body.roles.length) {
    const restricted = channels.setGroupRoles(id, req.body.roles);
    if (!restricted.ok) {
      channels.removeGroup(id);
      return channelFailure(res, restricted.error);
    }
  }
  if (Array.isArray(req.body?.users) && req.body.users.length) {
    const named = channels.setGroupUsers(id, req.body.users);
    if (!named.ok) {
      channels.removeGroup(id);
      return channelFailure(res, named.error);
    }
  }
  if (req.body?.password) await channels.setGroupPassword(id, req.body.password);
  channelsChanged();
  return res.status(201).json({ group: publicGroup(channels.group(id)) });
});

app.post('/api/channels/groups/:id', requireLogin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!visibleGroup(req, id)) return channelFailure(res, 'no_such_group');

  // Each field needs its own permission, and nothing is changed until all of
  // them have been checked -- half an edit is worse than a refused one.
  const wantsName = req.body?.name !== undefined;
  const wantsRoles = req.body?.roles !== undefined;
  const wantsUsers = req.body?.users !== undefined;
  const wantsPassword = req.body?.password !== undefined;
  if ((wantsName || wantsRoles || wantsUsers) && !may(req, 'channels.edit')) return forbid(res);
  if (wantsPassword && !may(req, 'channels.password')) return forbid(res);

  if (wantsName) {
    const named = channels.renameGroup(id, req.body.name);
    if (!named.ok) return channelFailure(res, named.error);
  }
  if (wantsRoles) {
    const restricted = channels.setGroupRoles(id, req.body.roles);
    if (!restricted.ok) return channelFailure(res, restricted.error);
  }
  if (wantsUsers) {
    const named = channels.setGroupUsers(id, req.body.users);
    if (!named.ok) return channelFailure(res, named.error);
  }
  if (wantsPassword) await channels.setGroupPassword(id, String(req.body.password));
  channelsChanged();
  return res.json({ group: publicGroup(channels.group(id)) });
});

/**
 * Delete a group. Its channels survive, ungrouped.
 *
 * The schema's ON DELETE SET NULL does that, and it is deliberate: a group
 * is a folder for the sidebar, not something that owns what is inside it.
 * Deleting it must not take a year of chat with it. They keep the password
 * and roles they were following, so deleting a private group does not make
 * its channels public.
 */
app.post('/api/channels/groups/:id/delete', requireLogin, (req, res) => {
  if (!may(req, 'channels.delete')) return forbid(res);
  const id = Number.parseInt(req.params.id, 10);
  if (!visibleGroup(req, id)) return channelFailure(res, 'no_such_group');
  const result = channels.removeGroup(id);
  if (!result.ok) return channelFailure(res, result.error);
  channelsChanged();
  return res.json({ ok: true });
});

/** The whole sidebar after a drag: see Channels.arrange. */
app.post('/api/channels/arrange', requireLogin, (req, res) => {
  if (!may(req, 'channels.edit')) return forbid(res);
  // A person cannot move what they cannot see -- nor, by naming it, find out
  // that it exists.
  const named = [
    ...(Array.isArray(req.body?.order) ? req.body.order.map((e) => e?.id).filter((x) => x != null) : []),
    ...(Array.isArray(req.body?.channels) ? req.body.channels.map((e) => e?.id) : []),
  ].map(Number);
  if (named.some((id) => !visibleChannel(req, id))) return channelFailure(res, 'no_such_channel');

  const result = channels.arrange({
    groups: req.body?.groups,
    channels: req.body?.channels,
    order: req.body?.order,
  });
  if (!result.ok) {
    const messages = {
      no_such_channel: 'That channel is gone -- refresh and try again.',
      no_such_group: 'That group is gone -- refresh and try again.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }
  channelsChanged();
  const view = channelViewFor({ roles, channels, voice }, req.user);
  return res.json({ channels: view.channels, groups: view.groups });
});

app.post('/api/channels/reorder', requireLogin, (req, res) => {
  if (!may(req, 'channels.edit')) return forbid(res);
  const result = channels.reorder(Array.isArray(req.body?.ids) ? req.body.ids : []);
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      message: 'Send every channel id exactly once, in the order you want.',
    });
  }
  channelsChanged();
  return res.json({ channels: result.channels.map(publicChannel) });
});

app.post('/api/channels/:id', requireLogin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!visibleChannel(req, id)) return channelFailure(res, 'no_such_channel');

  const wantsName = req.body?.name !== undefined;
  const wantsRoles = req.body?.roles !== undefined;
  const wantsUsers = req.body?.users !== undefined;
  const wantsPassword = req.body?.password !== undefined;
  if ((wantsName || wantsRoles || wantsUsers) && !may(req, 'channels.edit')) return forbid(res);
  if (wantsPassword && !may(req, 'channels.password')) return forbid(res);

  // Checked before anything is written: a channel in a group takes none of
  // these, and half of an edit is worse than a refused one.
  if ((wantsRoles || wantsUsers || wantsPassword) && channels.get(id).group_id != null) {
    return channelFailure(res, 'follows_group');
  }
  if (wantsRoles) {
    const restricted = channels.setRoles(id, req.body.roles);
    if (!restricted.ok) return channelFailure(res, restricted.error);
  }
  if (wantsUsers) {
    const named = channels.setUsers(id, req.body.users);
    if (!named.ok) return channelFailure(res, named.error);
  }
  const result = await channels.update(id, {
    ...(wantsName ? { name: req.body.name } : {}),
    ...(wantsPassword ? { password: req.body.password } : {}),
  });
  if (!result.ok) return channelFailure(res, result.error);
  channelsChanged();
  return res.json({ channel: publicChannel(result.channel) });
});

app.post('/api/channels/:id/delete', requireLogin, (req, res) => {
  if (!may(req, 'channels.delete')) return forbid(res);
  const id = Number.parseInt(req.params.id, 10);
  if (!visibleChannel(req, id)) return channelFailure(res, 'no_such_channel');
  const result = channels.remove(id);
  if (!result.ok) return channelFailure(res, result.error);
  // Anyone sitting in it has nowhere to be any more.
  for (const { channelId } of voice.leaveAll(-1)) void channelId;
  channelsChanged();
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat: messages, pins, search and uploads
// ---------------------------------------------------------------------------

/** A channel the caller is allowed to read, or null. */
function readableChannel(req, id) {
  const channel = visibleChannel(req, id);
  if (!channel) return null;
  if (channel.password_hash && !channels.hasGrant(id, req.user.id) && !roles.context(req.user).admin) return null;
  return channel;
}

/**
 * publicMessage over a list, with its reactions and its mentions attached.
 *
 * Here rather than inside publicMessage because both need something it has
 * not got: the reactions are a second query, and the mentions need the
 * nickname table. Doing either per message would make a fifty-row page
 * fifty lookups.
 *
 * EVERY route that hands a client a message goes through this. A field
 * missing from one of them and present in another is the worst case: the
 * client draws it from the pushed copy and then loses it on the next
 * refresh, which looks like the feature working intermittently.
 */
function forClient(messages) {
  const list = [].concat(messages).filter(Boolean);
  const byId = chat.reactionsFor(list.map((m) => m.id));
  // Built once for the page. Eleven people on a friends' server, so the map
  // is cheaper than the eleven-row query it replaces per message.
  const ids = new Map(accounts.list().map((u) => [u.nickname, u.id]));
  const idOf = (nickname) => ids.get(nickname) ?? null;
  return list.map(
    (m) => publicMessage(m, byId.get(m.id) ?? [], mentionsIn(m.body, idOf)),
  );
}

const oneForClient = (message) => forClient([message])[0] ?? null;

/**
 * Push something about a message to everyone who may read where it lives.
 *
 * An open channel is everybody, which is the plain broadcast. A password
 * channel is only the people holding a grant -- otherwise every message in
 * it reaches every connected client and is merely not drawn, which is not
 * the same thing as not being sent. It matters more now than it did: a
 * client that receives a message it cannot read would ring a mention bell
 * for a conversation it is not in.
 */
function toChannelReaders(channelId, payload) {
  const channel = channels.get(channelId);
  if (!channel) return undefined;
  const byId = new Map(channels.groups().map((g) => [g.id, g]));
  return realtime?.broadcastWhere(payload, (user) => {
    const fresh = accounts.byId(user.id) ?? user;
    const ctx = roles.context(fresh);
    if (!roles.canSee(ctx, channel, byId)) return false;
    // Admins hold every key, so a passworded channel reaches them as an open one.
    return !channel.password_hash || channels.hasGrant(channelId, user.id) || ctx.admin;
  });
}

app.get('/api/channels/:id/messages', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const channel = readableChannel(req, id);
  if (!channel) return res.status(404).json({ error: 'no_such_channel' });

  const before = Number.parseInt(req.query.before ?? '', 10);
  return res.json({
    messages: forClient(
      chat.history(id, { before: Number.isFinite(before) ? before : undefined }),
    ),
    pinned: forClient(chat.pinned(id)),
  });
});

app.post('/api/channels/:id/messages', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const channel = readableChannel(req, id);
  if (!channel) return res.status(404).json({ error: 'no_such_channel' });

  const result = chat.post({
    channelId: id,
    user: req.user,
    body: req.body?.body,
    attachmentHash: req.body?.attachmentHash ?? null,
    attachmentName: req.body?.attachmentName ?? null,
    replyTo: req.body?.replyTo ?? null,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  const message = oneForClient(result.message);
  toChannelReaders(id, { type: 'message', message });
  return res.status(201).json({ message });
});

app.post('/api/messages/:id/pin', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const target = chat.get(id);
  if (target && !readableChannel(req, target.channel_id)) {
    return res.status(404).json({ error: 'no_such_message' });
  }
  const result = chat.setPinned(id, req.body?.pinned !== false);
  if (!result.ok) return res.status(404).json({ error: result.error });
  const message = oneForClient(result.message);
  toChannelReaders(message.channelId, { type: 'message:updated', message });
  return res.json({ message });
});

/**
 * Change what a message says.
 *
 * YOUR OWN ONLY, and an admin is not an exception -- which is the one
 * place this app's admin rules are narrower than for deleting. Deleting
 * somebody's message removes it and everyone can see that it is gone;
 * editing it would put words in their mouth under their name, and nothing
 * in the UI could tell the difference.
 */
app.post('/api/messages/:id/edit', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = chat.get(id);
  if (!existing) return res.status(404).json({ error: 'no_such_message' });
  if (!readableChannel(req, existing.channel_id)) {
    return res.status(404).json({ error: 'no_such_channel' });
  }
  if (existing.user_id !== req.user.id) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'You can only edit your own messages.',
    });
  }

  const result = chat.edit(id, req.body?.body);
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      message: result.error === 'empty_message'
        ? 'A message has to say something, unless it carries a file.'
        : 'No such message.',
    });
  }

  const message = oneForClient(result.message);
  toChannelReaders(existing.channel_id, { type: 'message:updated', message });
  return res.json({ message });
});

/**
 * Change the file on a message, or take it off.
 *
 * Your own only, the same rule editing follows and for the same reason:
 * swapping somebody's picture under their name is putting something in
 * their mouth, while deleting the message is visible to everyone.
 */
app.post('/api/messages/:id/attachment', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = chat.get(id);
  if (!existing) return res.status(404).json({ error: 'no_such_message' });
  if (!readableChannel(req, existing.channel_id)) {
    return res.status(404).json({ error: 'no_such_channel' });
  }
  if (existing.user_id !== req.user.id) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'You can only change your own messages.',
    });
  }

  const result = chat.setAttachment(id, {
    hash: req.body?.hash ?? null,
    name: req.body?.name ?? null,
  });
  if (!result.ok) {
    const messages = {
      no_such_upload: 'Upload the file first.',
      empty_message: 'Removing the file would leave nothing. Write something first.',
      no_such_message: 'No such message.',
    };
    return res.status(result.error === 'no_such_message' ? 404 : 400)
      .json({ error: result.error, message: messages[result.error] });
  }

  const message = oneForClient(result.message);
  toChannelReaders(existing.channel_id, { type: 'message:updated', message });
  return res.json({ message });
});

app.post('/api/messages/:id/delete', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);

  // Checked BEFORE deleting, obviously -- the first draft of this removed the
  // row and then decided whether it was allowed to.
  const existing = chat.get(id);
  if (!existing) return res.status(404).json({ error: 'no_such_message' });

  const isOwn = existing.user_id === req.user.id;
  if (!isOwn && !may(req, 'messages.delete')) {
    return res.status(403).json({ error: 'forbidden', message: 'Not your message.' });
  }

  const result = chat.remove(id);
  if (!result.ok) return res.status(404).json({ error: result.error });
  toChannelReaders(existing.channel_id, {
    type: 'message:deleted', id, channelId: existing.channel_id,
  });
  return res.json({ ok: true });
});

/**
 * React, or take it back. One route, because it is one gesture.
 *
 * No permission check beyond being signed in and able to read the channel:
 * a reaction is the cheapest thing anybody can say, and the only person it
 * can be removed by is the one who left it.
 */
app.post('/api/messages/:id/react', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = chat.get(id);
  if (!existing) return res.status(404).json({ error: 'no_such_message' });
  if (!readableChannel(req, existing.channel_id)) {
    return res.status(404).json({ error: 'no_such_channel' });
  }

  const result = chat.react({
    messageId: id,
    userId: req.user.id,
    emoji: req.body?.emoji,
    on: req.body?.on !== false,
  });
  if (!result.ok) {
    return res.status(result.error === 'no_such_message' ? 404 : 400).json({
      error: result.error,
      message: result.error === 'bad_emoji'
        ? 'React with an emoji or a :name:, not a paragraph.'
        : 'No such message.',
    });
  }

  toChannelReaders(existing.channel_id, {
    type: 'message:reactions',
    id,
    channelId: existing.channel_id,
    reactions: result.reactions,
  });
  return res.json({ reactions: result.reactions });
});

app.get('/api/channels/:id/search', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const channel = readableChannel(req, id);
  if (!channel) return res.status(404).json({ error: 'no_such_channel' });

  const { mode, results } = chat.search(id, req.query.q);
  return res.json({ mode, results: forClient(results) });
});

/**
 * Upload a file.
 *
 * express.raw rather than the global express.json: that parser is
 * content-type gated, so an image/png body passes straight through it
 * untouched and arrives here unparsed. Verified -- the 16 kb JSON limit does
 * NOT apply to this route and does not need reordering.
 */
app.post(
  '/api/uploads',
  requireLogin,
  // Any type: one that is not on the list is kept as a plain download
  // (storedType in chat.js). express.raw only reads bodies whose type
  // matches, so the match has to be everything.
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    // express.raw leaves {} where there was no body, so an empty FILE is told
    // from no file by the length the client declared.
    const body = Buffer.isBuffer(req.body)
      ? req.body
      : req.get('content-length') === '0' ? Buffer.alloc(0) : null;
    if (!body) {
      return res.status(400).json({
        error: 'empty_file',
        message: 'Send the file as the raw request body.',
      });
    }

    const result = chat.store(body, req.get('content-type'));
    if (!result.ok) {
      const messages = {
        file_too_large: `Files are limited to ${formatBytes(Math.min(MAX_UPLOAD_BYTES, chat.maxFileBytes))} `
          + 'in one request. Newer versions of Harmony send bigger ones in pieces.',
        server_full: 'The server has run out of space for uploads.',
      };
      return res.status(result.error === 'server_full' ? 507 : 400).json({
        error: result.error,
        message: messages[result.error] ?? 'Upload refused.',
      });
    }

    return res.status(201).json({
      hash: result.upload.hash,
      contentType: result.upload.content_type,
      bytes: result.upload.bytes,
      deduplicated: result.deduplicated,
      usedBytes: chat.usedBytes,
      quotaBytes: chat.quotaBytes,
    });
  },
);

/**
 * Serve a stored file.
 *
 * Always with the content type recorded at upload, never one the request
 * asks for, and always as an attachment-safe type: a file smuggled in as
 * image/png is served as image/png and cannot execute. X-Content-Type-Options
 * stops a browser sniffing its way to a different conclusion.
 */
app.get('/api/uploads/:hash', requireLogin, (req, res) => sendUpload(req, res));

// ---------------------------------------------------------------------------
// Private conversations: see dm-routes.js
// ---------------------------------------------------------------------------

mountDirectMessages(app, {
  requireLogin,
  dms,
  chat,
  accounts,
  push: (userIds, payload) => { for (const id of userIds) realtime?.toUser(id, payload); },
  broadcast: (payload) => realtime?.broadcast(payload),
});

/**
 * Whether anything arrived, for a client that keeps this server in the
 * background with no socket open: the newest private message. Cheap on
 * purpose, since it is asked every 15 seconds; the client opens a socket only
 * once the answer changes. The same route, and the same two fields beside
 * `latest`, as Ciranda's, which also has calls to report here: there are none
 * in Harmony, so nobody is ringing and nobody is in one.
 */
app.get('/api/inbox', requireLogin, (req, res) => {
  res.json({ latest: dms.latest(req.user.id), ringing: false, inCall: false });
});

/** A key for loading uploads without headers. See GET /api/media/:hash. */
app.get('/api/media-key', requireLogin, (req, res) => {
  res.json({ key: mintMediaKey(mediaSecret, req.user.id) });
});

function sendUpload(req, res) {
  const hash = String(req.params.hash);
  if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: 'bad_hash' });

  const info = chat.fileInfo(hash);
  // A conversation's sealed file is read through that conversation, by the two
  // people in it (dm-routes.js), and through nothing else.
  if (!info || info.content_type === SEALED_TYPE) return res.status(404).json({ error: 'no_such_file' });

  res.set('Content-Type', info.content_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  // ?download=<name>: save it rather than show it. For the browser and
  // Android builds, which hand a big file to the system's own downloader
  // instead of holding all of it in a page's memory.
  if (typeof req.query.download === 'string') {
    res.attachment(req.query.download.replace(/[\\/\p{Cc}]/gu, '_').slice(0, 200) || hash.slice(0, 12));
  }
  // Content-addressed, so it can never change: cache it forever.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(info.path);
}

// ---------------------------------------------------------------------------
// Custom emoji
//
// Any member may add one; the uploader or an admin may remove it. See the
// Emojis class for why this is looser than the soundpad.
// ---------------------------------------------------------------------------

app.get('/api/emojis', requireLogin, (_req, res) => {
  res.json({ emojis: emojis.list().map(publicEmoji) });
});

app.post('/api/emojis', requireLogin, (req, res) => {
  const result = emojis.add({
    name: req.body?.name,
    fileHash: req.body?.hash,
    userId: req.user.id,
  });
  if (!result.ok) {
    const messages = {
      invalid_name: 'Names are 2-32 characters of a-z, 0-9 and _ -- it becomes the :trigger:.',
      name_taken: 'Something else is already called that.',
      too_many_emojis: `This server is at its limit of ${MAX_EMOJIS} custom emoji.`,
      no_such_upload: 'Upload the picture first.',
      not_an_image: 'A custom emoji has to be an image.',
      emoji_too_large:
        `Custom emoji are limited to ${Math.round(MAX_EMOJI_BYTES / 1024)} KB -- `
        + 'every client downloads every one of them.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }
  const list = emojis.list().map(publicEmoji);
  realtime?.broadcast({ type: 'emojis', emojis: list });
  return res.status(201).json({ emoji: publicEmoji(result.emoji) });
});

app.post('/api/emojis/:id/delete', requireLogin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);

  // Checked before removing, for the same reason deleting a message is.
  const existing = emojis.get(id);
  if (!existing) return res.status(404).json({ error: 'no_such_emoji' });

  const isOwn = existing.uploaded_by === req.user.id;
  if (!isOwn && !roles.context(req.user).admin) {
    return res.status(403).json({ error: 'forbidden', message: 'Not yours to remove.' });
  }

  const result = emojis.remove(id);
  if (!result.ok) return res.status(404).json({ error: result.error });
  realtime?.broadcast({ type: 'emojis', emojis: emojis.list().map(publicEmoji) });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Soundpad
// ---------------------------------------------------------------------------

app.get('/api/soundpad', requireLogin, (_req, res) => {
  res.json({ clips: soundpad.list().map(publicClip) });
});

app.post('/api/soundpad', requireAdmin, (req, res) => {
  const result = soundpad.add({
    name: req.body?.name,
    emoji: req.body?.emoji,
    fileHash: req.body?.hash,
    userId: req.user.id,
  });
  if (!result.ok) {
    const messages = {
      invalid_name: 'Give the clip a name.',
      no_such_upload: 'Upload the audio first.',
      not_audio: 'Soundpad clips have to be audio.',
      clip_too_large:
        `Soundpad clips are limited to ${Math.round(MAX_CLIP_BYTES / 1024 / 1024)} MB -- `
        + 'every client downloads every clip.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }
  realtime?.broadcast({ type: 'soundpad', clips: soundpad.list().map(publicClip) });
  return res.status(201).json({ clip: publicClip(result.clip) });
});

// Before /api/soundpad/:id/delete only by habit -- they cannot collide, since
// that one has a second path segment. The ordering rule still applies to the
// next person who adds /api/soundpad/:id, so it stays up here.
app.post('/api/soundpad/reorder', requireAdmin, (req, res) => {
  const result = soundpad.reorder(Array.isArray(req.body?.ids) ? req.body.ids : []);
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      message: 'Send every clip id exactly once, in the order you want.',
    });
  }
  const clips = result.clips.map(publicClip);
  realtime?.broadcast({ type: 'soundpad', clips });
  return res.json({ clips });
});

app.post('/api/soundpad/:id/rename', requireAdmin, (req, res) => {
  const result = soundpad.rename(
    Number.parseInt(req.params.id, 10), req.body?.name, req.body?.emoji,
  );
  if (!result.ok) {
    const messages = {
      no_such_clip: 'No such clip.',
      invalid_name: 'Give the clip a name.',
    };
    return res.status(400).json({ error: result.error, message: messages[result.error] });
  }
  realtime?.broadcast({ type: 'soundpad', clips: soundpad.list().map(publicClip) });
  return res.json({ clip: publicClip(result.clip) });
});

app.post('/api/soundpad/:id/delete', requireAdmin, (req, res) => {
  const result = soundpad.remove(Number.parseInt(req.params.id, 10));
  if (!result.ok) return res.status(404).json({ error: result.error });
  realtime?.broadcast({ type: 'soundpad', clips: soundpad.list().map(publicClip) });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// MediaMTX auth hook
//
// MediaMTX POSTs { user, password, token, ip, action, path, protocol, id,
// query, userAgent } and reads only the status code: 2xx allows, anything else
// denies.
// ---------------------------------------------------------------------------

app.post('/mediamtx/auth', (req, res) => {
  const { action, path, query } = req.body ?? {};

  // api / metrics / pprof are already excluded in mediamtx.yml, but MediaMTX
  // will ask if that config is ever edited. Loopback only.
  if (action === 'api' || action === 'metrics' || action === 'pprof') {
    return res.sendStatus(204);
  }

  /**
   * CHANNEL PATHS ARE HANDLED FIRST, AND THAT ORDERING IS SECURITY-CRITICAL.
   *
   * Two things below this point would otherwise defeat channel passwords
   * entirely:
   *
   *   1. the legacy read branch accepts the single process-wide `mediaToken`,
   *      which every client gets just for knowing the server password -- so a
   *      legacy client could listen to a password-protected voice channel;
   *   2. the open-server shortcut (`if (!config.mediaToken) return 204`) lets
   *      ANY read through on a server with no HARMONY_PASSWORD -- so a channel
   *      password would mean nothing at all there.
   *
   * Neither is a bug in those branches; they are correct for the flat username
   * namespace. They are simply the wrong answer for `vc-...`, and the only
   * thing keeping them from being asked is this early return. Do not "simplify"
   * it downwards.
   */
  const channelTarget = parseChannelPath(path);
  if (channelTarget) {
    const token = new URLSearchParams(query ?? '').get('token');
    const claim = readChannelToken(mediaSecret, token);

    if (!claim || claim.cid !== channelTarget.cid) {
      console.warn(`[auth] channel ${action} REJECTED for "${path}" (bad or expired token)`);
      return res.sendStatus(401);
    }

    if (action === 'read' || action === 'playback') {
      // Membership of the channel is the whole check: any member may watch any
      // other member. The hook never consults live presence, which keeps it
      // stateless, restart-proof, and off any lock during a join storm.
      return res.sendStatus(204);
    }

    if (action === 'publish') {
      // Publishing additionally requires the SLOT to match, or one member
      // could publish into another member's path.
      if (claim.mid !== channelTarget.mid) {
        console.warn(`[auth] channel publish REJECTED for "${path}" (slot mismatch)`);
        return res.sendStatus(401);
      }
      // The enforcing half of force-mute. The Phase 0 spike showed that
      // kicking the live session alone does nothing lasting -- the path is
      // immediately re-publishable -- so this refusal is what makes a mute
      // stick across the reconnect that follows.
      if (channelTarget.kind === MEDIA_KINDS.voice
          && voice.isForceMuted(channelTarget.cid, channelTarget.mid)) {
        console.warn(`[auth] channel publish REFUSED for "${path}" (force-muted)`);
        return res.sendStatus(401);
      }
      return res.sendStatus(204);
    }

    return res.sendStatus(401);
  }

  // normalizePath, NOT normalizeUsername: `bob-cam` is a system path that is
  // refused as user input but is legitimate here. Using the user-input
  // validator in the auth hook is what would make the two namespaces collide.
  const username = normalizePath(path);
  if (!username) return res.sendStatus(401);

  // On an open server, watching is open to anyone who knows the name -- that is
  // the design. With a password configured it must not be: MediaMTX listens on
  // its own port, so a reader who never touched the control server would other-
  // wise walk straight past the password. The watch URLs handed out by
  // /api/streams carry the token that proves the holder got them from us.
  if (action === 'read' || action === 'playback') {
    if (!config.mediaToken) return res.sendStatus(204);
    const token = new URLSearchParams(query ?? '').get('token');
    if (secretsMatch(token, config.mediaToken)) return res.sendStatus(204);
    console.warn(`[auth] read REJECTED for "${username}" (missing or stale watch token)`);
    return res.sendStatus(401);
  }

  if (action === 'publish') {
    // MediaMTX forwards the raw query string from the WHIP URL.
    const token = new URLSearchParams(query ?? '').get('token');
    if (rooms.mayPublish(username, token)) {
      console.log(`[auth] publish accepted for "${username}"`);
      return res.sendStatus(204);
    }
    console.warn(`[auth] publish REJECTED for "${username}" (bad or expired token)`);
    return res.sendStatus(401);
  }

  return res.sendStatus(401);
});

// ---------------------------------------------------------------------------

/**
 * The media URLs and tokens a member needs for one channel.
 *
 * One token covers reading and publishing; see channels.js for why that is
 * safe. The client builds every peer's WHEP URL from `readToken` and its own
 * WHIP URLs from the paths here.
 */
function issueTokens(channelId, userId, mid) {
  const token = mintChannelToken(mediaSecret, {
    cid: channelId, mid, ttlMs: config.channelTokenTtlMs,
  });
  const url = (kind) =>
    `${config.signalingBase}/${channelPath(channelId, mid, kind)}`;
  return {
    token,
    publish: {
      voice: `${url('voice')}/whip?token=${encodeURIComponent(token)}`,
      cam: `${url('cam')}/whip?token=${encodeURIComponent(token)}`,
      screen: `${url('screen')}/whip?token=${encodeURIComponent(token)}`,
    },
    // A template rather than a list: the roster changes constantly and the
    // client already knows every member's slot from it.
    whepBase: config.signalingBase,
    /*
     * How long this token lasts, so the client can come back before it does
     * not. It is a HINT and not a contract -- the client halves it and the
     * server re-issues on request, so neither side has to agree on a clock.
     *
     * Sending this and never acting on it is precisely the bug that shipped:
     * a channel's tokens were minted once at join and never renewed, so
     * after ten minutes no new subscription, camera or screen share in that
     * channel could be authorised. Nothing in flight broke, which is what
     * made it look like "sometimes I cannot hear someone".
     */
    expiresInMs: config.channelTokenTtlMs,
  };
}

monitor.start();

// Sweep idle sessions hourly. Cheap, and it keeps a long-lived server from
// accumulating a row per login forever.
const sessionSweeper = setInterval(
  () => accounts.expireSessions(config.sessionIdleMs),
  60 * 60 * 1000,
);
sessionSweeper.unref();

let realtime = null;

const server = app.listen(config.port, config.host, () => {
  console.log(`[harmony] control server on http://${config.host}:${config.port}`);
  console.log(`[harmony] clients will be sent to ${config.signalingBase}`);
  // serverSettings, not config: the owner may have changed the door from
  // the client, and a banner that reports the environment would be lying
  // about the server it just started.
  console.log(
    serverSettings.passwordRequired
      ? `[harmony] password required — ${config.maxLoginAttempts} tries, then ${config.lockoutMinutes.join('/')} minute lockouts`
      : '[harmony] NO PASSWORD SET — anyone who can reach this server can use it',
  );
  console.log(`[harmony] this server is called ${serverSettings.name}`);
});

realtime = new Realtime({
  server,
  accounts,
  channels,
  voice,
  roles,
  badges,
  soundpad,
  issueTokens,
  kickMember: (channelId, mid) => monitor.kickPath(channelPath(channelId, mid, 'voice')),
});

/**
 * Push the live stream list instead of having every client poll for it.
 *
 * Only on CHANGE: the monitor ticks once a second and the list is usually
 * identical, so broadcasting every tick would be the same poll with extra
 * steps. The client keeps a slow reconciliation poll as a safety net.
 */
let lastStreamsJson = '';
monitor.on('paths', () => {
  const streams = rooms.listLive().map((s) => ({ ...s, whepUrl: whepUrl(s.username) }));
  const json = JSON.stringify(streams);
  if (json === lastStreamsJson) return;
  lastStreamsJson = json;
  realtime.broadcastStreams(streams);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[harmony] ${signal} -- shutting down`);
    monitor.stop();
    realtime?.close();
    clearInterval(sessionSweeper);
    server.close(() => {
      // Closing checkpoints the WAL, so the next start does not have to replay
      // it. Skipping this is survivable but leaves -wal/-shm files behind.
      db.close();
      process.exit(0);
    });
  });
}
