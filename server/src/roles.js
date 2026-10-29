// Roles: who may do what, and who outranks whom.
//
// The one idea in here is the RANK. Every account has one number, and every
// rule that compares two people -- who may mute whom, who may hand out which
// role, whose role may be moved -- is that number against that number:
//
//   owner          far above everybody, and the only one who can make a super admin
//   super admin    users.role = 'admin' with no role needed: can do everything a
//                  role can, and ranks above every role
//   a role holder  ranked by their TOP role: the lower its position in the list,
//                  the higher the rank
//   nobody         0
//
// Ranks are strict. Two people of the same rank cannot act on each other,
// which is what stops a falling-out between two moderators turning into a
// race to demote one another -- the same reasoning that already made taking
// admin away an owner-only act.
//
// Everything that depends on the account is read FRESH for every decision
// (context() asks the database), never from a snapshot taken when a socket
// opened or a request began. A role is a promise about what somebody may do
// right now, and "right now" has to include the minute after it was taken away.

import { cleanNameColor } from './accounts.js';
import { publicChannel, publicGroup } from './channels.js';

/** What a role can grant. The order is the order the settings page lists them. */
export const PERMISSIONS = [
  'channels.create',
  'channels.delete',
  'channels.edit',
  'channels.password',
  'users.mute',
  'users.kick',
  'users.ban',
  'messages.delete',
  'roles.hierarchy',
  'badges.create',
  'badges.edit',
];

const PERMISSION_SET = new Set(PERMISSIONS);

/** A role's colour: the six-digit form only, so every client draws the same thing. */
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export const DEFAULT_ROLE_COLOR = '#99aab5';
export const MAX_ROLE_NAME = 32;
export const MAX_ROLES = 50;

/** Above every position a role can have, so a role holder always ranks below a super admin. */
const ROLE_BASE = 1_000_000;
const RANK_SUPER_ADMIN = 10_000_000;
const RANK_OWNER = 100_000_000;

/** Role names are shown as typed, minus anything invisible, as channel names are. */
function cleanRoleName(raw) {
  return String(raw ?? '')
    .replace(/[\p{Cc}\p{Cs}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ROLE_NAME);
}

const parseList = (text) => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const uniqueInts = (list) => [...new Set((Array.isArray(list) ? list : [])
  .map(Number)
  .filter((n) => Number.isInteger(n)))];

/** A role as the wire carries it. */
export const publicRole = (r) => (r ? {
  id: r.id,
  name: r.name,
  color: r.color,
  position: r.position,
  admin: r.admin,
  permissions: r.permissions,
  assignable: r.assignable,
  assignableBadges: r.assignableBadges,
  style: r.style,
} : null);

export class Roles {
  #db;
  #q;
  #cache = null;

  constructor(db) {
    this.#db = db;
    this.#q = {
      all: db.prepare('SELECT * FROM roles ORDER BY position, id'),
      insert: db.prepare(
        'INSERT INTO roles (name, color, position, admin, permissions, assignable, assignable_badges, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      update: db.prepare(
        'UPDATE roles SET name = ?, color = ?, admin = ?, permissions = ?, assignable = ?, '
        + 'assignable_badges = ? WHERE id = ?',
      ),
      setStyle: db.prepare('UPDATE roles SET style = ? WHERE id = ?'),
      setPosition: db.prepare('UPDATE roles SET position = ? WHERE id = ?'),
      remove: db.prepare('DELETE FROM roles WHERE id = ?'),
      userRoles: db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?'),
      clearUser: db.prepare('DELETE FROM user_roles WHERE user_id = ?'),
      addUser: db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)'),
      members: db.prepare('SELECT user_id FROM user_roles WHERE role_id = ?'),
      badgeExists: db.prepare('SELECT 1 AS ok FROM badges WHERE id = ?'),
    };
  }

  // ------------------------------------------------------------- reading

  /** Every role, top of the hierarchy first. */
  list() {
    if (!this.#cache) {
      this.#cache = this.#q.all.all().map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position,
        admin: Boolean(r.admin),
        permissions: parseList(r.permissions).filter((p) => PERMISSION_SET.has(p)),
        assignable: uniqueInts(parseList(r.assignable)),
        assignableBadges: uniqueInts(parseList(r.assignable_badges)),
        style: (() => {
          try { return r.style ? JSON.parse(r.style) : null; } catch { return null; }
        })(),
      }));
    }
    return this.#cache;
  }

  get(id) {
    return this.list().find((r) => r.id === Number(id)) ?? null;
  }

  #changed() {
    this.#cache = null;
  }

  /**
   * Everything a decision about this account needs, read now.
   *
   * @param {{id: number, role?: string}} user  an account row
   */
  context(user) {
    const owned = new Set(this.#q.userRoles.all(user.id).map((r) => r.role_id));
    const held = this.list().filter((r) => owned.has(r.id));
    const owner = user.role === 'owner';
    const superAdmin = user.role === 'admin';
    const adminRole = held.some((r) => r.admin);
    const everything = owner || superAdmin;
    const top = held.length ? held[0].position : null;

    const permissions = new Set(held.flatMap((r) => r.permissions));
    const assignable = new Set(held.flatMap((r) => r.assignable));
    const assignableBadges = new Set(held.flatMap((r) => r.assignableBadges));

    return {
      id: user.id,
      owner,
      superAdmin,
      /** Owner or super admin: nothing about them is limited by a role. */
      everything,
      /** Everything, or a role that says admin: all permissions, and sees all channels. */
      admin: everything || adminRole,
      roleIds: new Set(held.map((r) => r.id)),
      roles: held,
      topPosition: top,
      rank: owner ? RANK_OWNER
        : superAdmin ? RANK_SUPER_ADMIN
          : top === null ? 0 : ROLE_BASE - top,
      can: (permission) => everything || adminRole || permissions.has(permission),
      assignable,
      assignableBadges,
      /** May this account hand out this badge? Admins any; everybody else the ones a role lists. */
      canAward: (badgeId) => everything || adminRole || assignableBadges.has(Number(badgeId)),
    };
  }

  /** What a role is worth against an account's rank. */
  static roleRank(role) {
    return ROLE_BASE - role.position;
  }

  // ------------------------------------------------------------- rules

  /** May this actor act on this target's ACCOUNT (mute, kick, ban, hand out roles)? */
  outranks(actor, target) {
    return actor.rank > target.rank;
  }

  /** May this actor edit, delete or move this role? Only the ones below them. */
  canManageRole(actor, role) {
    if (actor.everything) return true;
    return actor.can('roles.hierarchy') && actor.rank > Roles.roleRank(role);
  }

  /** May this actor put this role on somebody, or take it off? */
  canAssign(actor, role) {
    if (actor.everything) return true;
    if (actor.rank <= Roles.roleRank(role)) return false;
    return actor.assignable.has(role.id) || actor.roles.some((r) => r.admin);
  }

  /**
   * What this actor would be GRANTING by turning `next` on, beyond `previous`.
   *
   * Nobody can hand out what they do not have: otherwise a role that may
   * manage roles is a way to write yourself an admin role. Only what is NEW
   * is checked, so editing the name of a role that carries a permission its
   * editor lacks does not fail on the permission nobody touched.
   */
  #escalation(actor, next, previous) {
    if (actor.everything) return null;
    if (next.admin && !previous?.admin && !actor.admin) return 'cannot_grant';
    for (const permission of next.permissions) {
      if (previous?.permissions.includes(permission)) continue;
      if (!actor.can(permission)) return 'cannot_grant';
    }
    for (const id of next.assignable) {
      if (previous?.assignable.includes(id)) continue;
      const role = this.get(id);
      if (!role || !this.canAssign(actor, role)) return 'cannot_grant';
    }
    // The same for badges: a role cannot be made to award what its maker cannot.
    for (const id of next.assignableBadges) {
      if (previous?.assignableBadges.includes(id)) continue;
      if (!actor.canAward(id)) return 'cannot_grant';
    }
    return null;
  }

  #sanitize(input, previous) {
    const name = input.name === undefined ? previous?.name : cleanRoleName(input.name);
    if (!name) return { error: 'invalid_name' };

    const color = input.color === undefined ? (previous?.color ?? DEFAULT_ROLE_COLOR) : String(input.color);
    if (!COLOR_RE.test(color)) return { error: 'invalid_color' };

    const admin = input.admin === undefined ? Boolean(previous?.admin) : Boolean(input.admin);

    let permissions = previous?.permissions ?? [];
    if (input.permissions !== undefined) {
      if (!Array.isArray(input.permissions)) return { error: 'invalid_permissions' };
      permissions = [...new Set(input.permissions.map(String))];
      if (permissions.some((p) => !PERMISSION_SET.has(p))) return { error: 'invalid_permissions' };
    }

    let assignable = previous?.assignable ?? [];
    if (input.assignable !== undefined) {
      if (!Array.isArray(input.assignable)) return { error: 'invalid_assignable' };
      assignable = uniqueInts(input.assignable);
      if (assignable.some((id) => !this.get(id) || id === previous?.id)) {
        return { error: 'invalid_assignable' };
      }
    }
    let assignableBadges = previous?.assignableBadges ?? [];
    if (input.assignableBadges !== undefined) {
      if (!Array.isArray(input.assignableBadges)) return { error: 'invalid_assignable' };
      assignableBadges = uniqueInts(input.assignableBadges);
      if (assignableBadges.some((id) => !this.#q.badgeExists.get(id))) return { error: 'invalid_assignable' };
    }
    // How the name is drawn when it is more than a colour: null, a gradient
    // that moves, or the rainbow. A solid is just `color`.
    let style = previous?.style ?? null;
    if (input.style !== undefined) {
      style = cleanNameColor(input.style);
      if (style === undefined || style?.mode === 'solid') return { error: 'invalid_style' };
    }
    return { value: { name, color: color.toLowerCase(), admin, permissions, assignable, assignableBadges, style } };
  }

  // ------------------------------------------------------------- writing

  /** A new role goes to the BOTTOM: nobody is outranked by what they just made. */
  create(actor, input) {
    if (!actor.can('roles.hierarchy')) return { ok: false, error: 'forbidden' };
    if (this.list().length >= MAX_ROLES) return { ok: false, error: 'too_many_roles' };

    const clean = this.#sanitize(input ?? {}, null);
    if (clean.error) return { ok: false, error: clean.error };
    const denied = this.#escalation(actor, clean.value, null);
    if (denied) return { ok: false, error: denied };

    const taken = this.list().some((r) => r.name.toLowerCase() === clean.value.name.toLowerCase());
    if (taken) return { ok: false, error: 'name_taken' };

    const position = this.list().length;
    const v = clean.value;
    const info = this.#q.insert.run(
      v.name, v.color, position, v.admin ? 1 : 0,
      JSON.stringify(v.permissions), JSON.stringify(v.assignable),
      JSON.stringify(v.assignableBadges), Date.now(),
    );
    const id = Number(info.lastInsertRowid);
    if (v.style) this.#q.setStyle.run(JSON.stringify(v.style), id);
    this.#changed();
    return { ok: true, role: this.get(id) };
  }

  update(actor, id, input) {
    const role = this.get(id);
    if (!role) return { ok: false, error: 'no_such_role' };
    if (!this.canManageRole(actor, role)) return { ok: false, error: 'forbidden' };

    const clean = this.#sanitize(input ?? {}, role);
    if (clean.error) return { ok: false, error: clean.error };
    const denied = this.#escalation(actor, clean.value, role);
    if (denied) return { ok: false, error: denied };

    const taken = this.list().some(
      (r) => r.id !== role.id && r.name.toLowerCase() === clean.value.name.toLowerCase(),
    );
    if (taken) return { ok: false, error: 'name_taken' };

    const v = clean.value;
    this.#q.update.run(
      v.name, v.color, v.admin ? 1 : 0,
      JSON.stringify(v.permissions), JSON.stringify(v.assignable),
      JSON.stringify(v.assignableBadges), role.id,
    );
    this.#q.setStyle.run(v.style ? JSON.stringify(v.style) : null, role.id);
    this.#changed();
    return { ok: true, role: this.get(role.id) };
  }

  /**
   * Delete a role. Everyone who held it simply no longer does, and the lists
   * that named it (other roles' assignable lists) forget it.
   */
  remove(actor, id) {
    const role = this.get(id);
    if (!role) return { ok: false, error: 'no_such_role' };
    if (!this.canManageRole(actor, role)) return { ok: false, error: 'forbidden' };

    const holders = this.#q.members.all(role.id).map((r) => r.user_id);
    this.#db.exec('BEGIN');
    try {
      this.#q.remove.run(role.id);
      for (const other of this.list()) {
        if (other.id === role.id || !other.assignable.includes(role.id)) continue;
        this.#q.update.run(
          other.name, other.color, other.admin ? 1 : 0, JSON.stringify(other.permissions),
          JSON.stringify(other.assignable.filter((x) => x !== role.id)),
          JSON.stringify(other.assignableBadges), other.id,
        );
      }
      this.#renumber(this.list().filter((r) => r.id !== role.id).map((r) => r.id));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#changed();
    return { ok: true, holders };
  }

  /** A badge was deleted: the roles that could award it no longer list it. */
  forgetBadge(badgeId) {
    for (const role of this.list()) {
      if (!role.assignableBadges.includes(badgeId)) continue;
      this.#q.update.run(
        role.name, role.color, role.admin ? 1 : 0, JSON.stringify(role.permissions),
        JSON.stringify(role.assignable),
        JSON.stringify(role.assignableBadges.filter((id) => id !== badgeId)), role.id,
      );
    }
    this.#changed();
  }

  #renumber(ids) {
    ids.forEach((id, index) => this.#q.setPosition.run(index, id));
  }

  /**
   * Put the roles in this order. Takes the whole list, as channels do, so two
   * people dragging at once cannot interleave into an order neither wanted.
   *
   * Everything from the top down to the actor's own role -- their role
   * included -- has to stay exactly where it is. That is the rule that
   * stops a moderator promoting themselves: the roles above them cannot
   * move, and nothing below them can be put above them.
   */
  reorder(actor, ids) {
    if (!actor.can('roles.hierarchy')) return { ok: false, error: 'forbidden' };
    const current = this.list().map((r) => r.id);
    const wanted = uniqueInts(ids);
    if (wanted.length !== current.length || wanted.some((id) => !current.includes(id))) {
      return { ok: false, error: 'bad_order' };
    }
    if (!actor.everything) {
      const frozen = actor.topPosition === null ? -1 : actor.topPosition;
      for (let i = 0; i <= frozen; i += 1) {
        if (wanted[i] !== current[i]) return { ok: false, error: 'forbidden' };
      }
    }
    this.#db.exec('BEGIN');
    try {
      this.#renumber(wanted);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#changed();
    return { ok: true };
  }

  /**
   * Replace the roles somebody holds.
   *
   * Only the roles that CHANGE are checked against the actor: somebody who
   * holds a role the actor cannot hand out keeps it when the actor adds
   * another one beside it. And the target has to rank below the actor, which
   * is what stops anybody editing their own roles -- or a peer's.
   */
  setUserRoles(actor, target, ids) {
    const wanted = uniqueInts(ids);
    const known = new Set(this.list().map((r) => r.id));
    if (wanted.some((id) => !known.has(id))) return { ok: false, error: 'no_such_role' };

    const now = this.context(target);
    if (!actor.owner && !this.outranks(actor, now)) return { ok: false, error: 'forbidden' };

    const before = [...now.roleIds];
    const added = wanted.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !wanted.includes(id));
    for (const id of [...added, ...removed]) {
      if (!this.canAssign(actor, this.get(id))) return { ok: false, error: 'forbidden' };
    }
    if (!added.length && !removed.length) return { ok: true, changed: false };

    this.#db.exec('BEGIN');
    try {
      this.#q.clearUser.run(target.id);
      for (const id of wanted) this.#q.addUser.run(target.id, id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, changed: true };
  }

  // ------------------------------------------------------------- channels

  /**
   * May this account know the channel exists?
   *
   * A channel with roles is for those roles and nobody else: it is not in
   * the list, not in the voice rosters, not readable. A channel inside a
   * group follows the group's roles instead of having its own.
   *
   * Owner, super admins and admin roles see everything, because they are
   * the ones who have to be able to fix it.
   */
  canSee(ctx, channel, groups) {
    if (ctx.admin) return true;
    // In a group, a channel follows the group; its own lists are not consulted.
    const group = channel.group_id != null ? groups.get(channel.group_id) : null;
    return this.#audienceIncludes(ctx, group ?? channel);
  }

  canSeeGroup(ctx, group) {
    if (ctx.admin) return true;
    return this.#audienceIncludes(ctx, group);
  }

  /**
   * The audience of a channel or group is its roles and the people named on it
   * together: nobody listed at all is an open channel, and otherwise you are in
   * if you hold one of the roles, or are named.
   */
  #audienceIncludes(ctx, subject) {
    const roleIds = subject.roleIds ?? [];
    const userIds = subject.userIds ?? [];
    if (!roleIds.length && !userIds.length) return true;
    return userIds.includes(ctx.id) || roleIds.some((id) => ctx.roleIds.has(id));
  }

  /** The channels and groups this account may know about, and the ids of the channels. */
  visibleTo(ctx, channels) {
    const groupRows = channels.groups();
    const byId = new Map(groupRows.map((g) => [g.id, g]));
    const visibleChannels = channels.list().filter((c) => this.canSee(ctx, c, byId));
    return {
      channels: visibleChannels,
      groups: groupRows.filter((g) => this.canSeeGroup(ctx, g)),
      ids: new Set(visibleChannels.map((c) => c.id)),
    };
  }
}

/** Why a roles call failed, in words a settings page can show. */
export const ROLE_ERRORS = {
  forbidden: 'You do not have permission to do that.',
  cannot_grant: 'You cannot give out something you do not have yourself.',
  invalid_name: 'Give the role a name of 1-32 characters.',
  invalid_color: 'The colour has to look like #3366ff.',
  invalid_style: 'That is not a name style: use a gradient of 2 to 4 colours, or the rainbow.',
  invalid_permissions: 'Unknown permission.',
  invalid_assignable: 'That list can only name other roles that exist.',
  name_taken: 'There is already a role with that name.',
  no_such_role: 'No such role.',
  no_such_user: 'No such user.',
  bad_order: 'Send every role exactly once, in the order you want.',
  too_many_roles: 'That is as many roles as a server can have.',
};

/**
 * What one person is shown of the channels: only the ones they may know about,
 * and who is in each. The shape the hello, the `channels` push and
 * GET /api/channels all share, so a client draws all three the same way.
 */
export function channelViewFor({ roles, channels, voice }, user) {
  const { channels: visible, groups, ids } = roles.visibleTo(roles.context(user), channels);
  const pick = (all) => Object.fromEntries(
    Object.entries(all).filter(([id]) => ids.has(Number(id))),
  );
  return {
    channels: visible.map(publicChannel),
    groups: groups.map(publicGroup),
    occupancy: pick(voice.occupancy()),
    rosters: pick(voice.allRosters()),
  };
}
