// The HTTP side of roles, and of the moderation that roles gate.
//
// Every route here decides WHO may do it with Roles (roles.js) and nothing
// else: the permission, and the rank of the actor against the target. A
// client that hides a button is a courtesy; these are the rules.
//
// Whatever changes is pushed AT ONCE, before the reply: the new role list,
// the person's new roles, and -- through refreshAccess -- the channels they
// may now see or may no longer see, including taking them out of a voice
// room that has just closed to them. A role that takes effect on the next
// reconnect is a role that does not appear to work.

import { publicUser } from './accounts.js';
import { BADGE_ERRORS, publicBadge } from './badges.js';
import { PERMISSIONS, ROLE_ERRORS, publicRole } from './roles.js';

const FORBIDDEN = new Set(['forbidden', 'cannot_grant']);

const statusFor = (error) => (FORBIDDEN.has(error) ? 403 : error?.startsWith('no_such') ? 404 : 400);

const fail = (res, error) => res.status(statusFor(error)).json({
  error,
  message: ROLE_ERRORS[error] ?? 'That did not work.',
});

export function mountRoles(app, { requireLogin, roles, accounts, realtime }) {
  const rt = () => realtime();
  const actorOf = (req) => roles.context(req.user);

  /** Everyone gets the role list; it is how a name's colour gets drawn. */
  app.get('/api/roles', requireLogin, (_req, res) => {
    res.json({ roles: roles.list().map(publicRole), permissions: PERMISSIONS });
  });

  const pushRoles = () => {
    rt()?.broadcast({ type: 'roles', roles: roles.list().map(publicRole) });
    // Holders of a deleted role, or of one whose rank moved, are different
    // people now: their entries, and what they can see, are redrawn.
    rt()?.broadcast({ type: 'accounts', users: accounts.list().map(publicUser) });
    rt()?.refreshAccess();
  };

  // Registered before /:id: Express matches in order, and "reorder" is not an id.
  app.post('/api/roles/reorder', requireLogin, (req, res) => {
    const result = roles.reorder(actorOf(req), req.body?.ids);
    if (!result.ok) return fail(res, result.error);
    pushRoles();
    return res.json({ roles: roles.list().map(publicRole) });
  });

  app.post('/api/roles', requireLogin, (req, res) => {
    const result = roles.create(actorOf(req), req.body);
    if (!result.ok) return fail(res, result.error);
    pushRoles();
    return res.status(201).json({ role: publicRole(result.role) });
  });

  app.post('/api/roles/:id', requireLogin, (req, res) => {
    const result = roles.update(actorOf(req), Number.parseInt(req.params.id, 10), req.body);
    if (!result.ok) return fail(res, result.error);
    pushRoles();
    return res.json({ role: publicRole(result.role) });
  });

  app.post('/api/roles/:id/delete', requireLogin, (req, res) => {
    const result = roles.remove(actorOf(req), Number.parseInt(req.params.id, 10));
    if (!result.ok) return fail(res, result.error);
    pushRoles();
    return res.json({ ok: true });
  });

  /**
   * Replace the roles somebody holds.
   *
   * The reply, the `user:updated` push and the access refresh all happen
   * before this returns, so by the time the admin's request comes back the
   * person's own client has already been told -- their name is the new
   * colour, and the channels list they are looking at is the new one.
   */
  app.post('/api/accounts/:id/roles', requireLogin, (req, res) => {
    const target = accounts.byId(Number.parseInt(req.params.id, 10));
    if (!target) return fail(res, 'no_such_user');
    const result = roles.setUserRoles(actorOf(req), target, req.body?.roles);
    if (!result.ok) return fail(res, result.error);

    const user = publicUser(accounts.byId(target.id));
    if (result.changed) {
      rt()?.broadcast({ type: 'user:updated', user });
      rt()?.refreshAccess();
    }
    return res.json({ user });
  });

  /**
   * Put somebody out of the server: they are signed out everywhere and every
   * socket they have is closed. They can sign in again -- that is what a ban
   * is for, and the difference between the two.
   */
  app.post('/api/accounts/:id/kick', requireLogin, (req, res) => {
    const target = accounts.byId(Number.parseInt(req.params.id, 10));
    if (!target) return fail(res, 'no_such_user');
    const actor = actorOf(req);
    if (!actor.can('users.kick') || !roles.outranks(actor, roles.context(target))) {
      return fail(res, 'forbidden');
    }
    accounts.dropSessions(target.id);
    rt()?.kickUser(target.id, 'kicked');
    rt()?.broadcastPresence();
    console.warn(`[accounts] ${target.nickname} kicked by ${req.user.nickname}`);
    return res.json({ ok: true });
  });

  app.post('/api/accounts/:id/ban', requireLogin, (req, res) => {
    const target = accounts.byId(Number.parseInt(req.params.id, 10));
    if (!target) return fail(res, 'no_such_user');
    const actor = actorOf(req);
    if (!actor.can('users.ban') || !roles.outranks(actor, roles.context(target))) {
      return fail(res, 'forbidden');
    }
    const banned = req.body?.banned !== false;
    const result = accounts.setBanned(target.id, banned);
    if (!result.ok) return fail(res, result.error);

    if (banned) {
      rt()?.kickUser(target.id, 'banned');
      rt()?.broadcastPresence();
    }
    const user = publicUser(result.user);
    rt()?.broadcast({ type: 'user:updated', user });
    console.warn(`[accounts] ${target.nickname} ${banned ? 'banned' : 'unbanned'} by ${req.user.nickname}`);
    return res.json({ user });
  });
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Who may do what with badges:
 *
 *   badges.create   make one
 *   badges.edit     change or delete one
 *   (a role's list of badges it can award)   hand one out, or take it back
 *
 * Owner, super admins and admin roles may do all of it. A picture is a file
 * already uploaded (POST /api/uploads) and retained here, like an avatar: the
 * new one is retained BEFORE the old is released, so setting the same picture
 * again never drops it to zero.
 */
export function mountBadges(app, {
  requireLogin, roles, badges, accounts, chat, realtime, mediaTypeOf, maxImageBytes,
}) {
  const rt = () => realtime();
  const actorOf = (req) => roles.context(req.user);
  const failure = (res, error) => res
    .status(FORBIDDEN.has(error) ? 403 : ['no_such_badge', 'no_such_user'].includes(error) ? 404 : 400)
    .json({ error, message: BADGE_ERRORS[error] ?? 'That did not work.' });

  const pushBadges = () => {
    rt()?.broadcast({ type: 'badges', badges: badges.list().map(publicBadge) });
    rt()?.broadcast({ type: 'roles', roles: roles.list().map(publicRole) });
    rt()?.broadcast({ type: 'accounts', users: accounts.list().map(publicUser) });
  };

  /** A picture is an uploaded image of a sensible size; returns an error code or null. */
  const checkPicture = (hash) => {
    if (hash === undefined || hash === null || hash === '') return null;
    if (!/^[0-9a-f]{64}$/.test(String(hash))) return 'bad_hash';
    const upload = chat.fileInfo(String(hash));
    if (!upload) return 'no_such_upload';
    if (mediaTypeOf(upload.content_type) !== 'image') return 'not_an_image';
    if (upload.bytes > maxImageBytes) return 'picture_too_large';
    return null;
  };

  app.get('/api/badges', requireLogin, (_req, res) => {
    res.json({ badges: badges.list().map(publicBadge) });
  });

  app.post('/api/badges', requireLogin, (req, res) => {
    if (!actorOf(req).can('badges.create')) return failure(res, 'forbidden');
    const bad = checkPicture(req.body?.imageHash);
    if (bad) return failure(res, bad);
    const result = badges.create(req.body);
    if (!result.ok) return failure(res, result.error);
    if (result.badge.image_hash) chat.retain(result.badge.image_hash);
    pushBadges();
    return res.status(201).json({ badge: publicBadge(result.badge) });
  });

  app.post('/api/badges/:id', requireLogin, (req, res) => {
    if (!actorOf(req).can('badges.edit')) return failure(res, 'forbidden');
    const bad = checkPicture(req.body?.imageHash);
    if (bad) return failure(res, bad);
    const result = badges.update(Number.parseInt(req.params.id, 10), req.body);
    if (!result.ok) return failure(res, result.error);
    const now = result.badge.image_hash;
    if (now && now !== result.previousHash) chat.retain(now);
    if (result.previousHash && result.previousHash !== now) chat.release(result.previousHash);
    pushBadges();
    return res.json({ badge: publicBadge(result.badge) });
  });

  app.post('/api/badges/:id/delete', requireLogin, (req, res) => {
    if (!actorOf(req).can('badges.edit')) return failure(res, 'forbidden');
    const id = Number.parseInt(req.params.id, 10);
    const result = badges.remove(id);
    if (!result.ok) return failure(res, result.error);
    if (result.previousHash) chat.release(result.previousHash);
    roles.forgetBadge(id);
    pushBadges();
    return res.json({ ok: true });
  });

  /**
   * Replace the badges somebody holds. Only the badges that change are
   * checked, against the ones the actor's roles list as awardable. The push
   * and the reply both carry the new account, so the person's card changes at
   * once.
   */
  app.post('/api/accounts/:id/badges', requireLogin, (req, res) => {
    const target = accounts.byId(Number.parseInt(req.params.id, 10));
    if (!target) return failure(res, 'no_such_user');
    const actor = actorOf(req);
    const result = badges.setUserBadges(target.id, req.body?.badges, (id) => actor.canAward(id));
    if (!result.ok) return failure(res, result.error);
    const user = publicUser(accounts.byId(target.id));
    if (result.changed) rt()?.broadcast({ type: 'user:updated', user });
    return res.json({ user });
  });
}
