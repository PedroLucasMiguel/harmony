// Roles, as the client needs them: what a person may do, and what a name looks like.
//
// This MIRRORS server/src/roles.js, and only to decide what to SHOW -- which
// buttons exist, which checkboxes are greyed out. The server decides what is
// allowed, for every request, from the database; nothing here is a check
// anybody has to get right for the app to be safe, which is why it is fine
// for it to be a few lines of plain functions and not a library.
//
// Rank is the one idea: owner, then super admin ("admin" with no role), then
// whoever holds the role highest in the list. Everything that compares two
// people compares those numbers, strictly -- equals cannot act on each other.

/** What a role can grant, in the order the page lists them, grouped. */
export const PERMISSION_GROUPS = [
  { key: 'channels', permissions: ['channels.create', 'channels.edit', 'channels.password', 'channels.delete'] },
  { key: 'users', permissions: ['users.mute', 'users.kick', 'users.ban'] },
  { key: 'messages', permissions: ['messages.delete'] },
  { key: 'roles', permissions: ['roles.hierarchy'] },
  { key: 'badges', permissions: ['badges.create', 'badges.edit'] },
];

const ROLE_BASE = 1_000_000;
const RANK_SUPER_ADMIN = 10_000_000;
const RANK_OWNER = 100_000_000;

/** The roles in hierarchy order, top first, whatever order they arrived in. */
export const sortRoles = (roles) => [...(roles ?? [])].sort((a, b) => a.position - b.position);

/**
 * What this account may do, from the roles list as it is now.
 *
 * @param {{id: number, role?: string, roles?: number[]} | null} user
 * @param {Array} roles
 */
export function contextOf(user, roles) {
  const ordered = sortRoles(roles);
  const mine = new Set(user?.roles ?? []);
  const held = ordered.filter((r) => mine.has(r.id));
  const owner = user?.role === 'owner';
  const superAdmin = user?.role === 'admin';
  const everything = owner || superAdmin;
  const adminRole = held.some((r) => r.admin);
  const granted = new Set(held.flatMap((r) => r.permissions));
  const top = held.length ? held[0].position : null;

  return {
    owner,
    superAdmin,
    everything,
    /** Nothing about them is limited by a role, or a role says admin. */
    admin: everything || adminRole,
    roles: held,
    roleIds: new Set(held.map((r) => r.id)),
    topPosition: top,
    rank: owner ? RANK_OWNER : superAdmin ? RANK_SUPER_ADMIN : top === null ? 0 : ROLE_BASE - top,
    assignable: new Set(held.flatMap((r) => r.assignable)),
    assignableBadges: new Set(held.flatMap((r) => r.assignableBadges ?? [])),
    /** May this account hand out this badge? Admins any; the rest the ones a role lists. */
    canAward: (badgeId) => everything || adminRole
      || held.some((r) => (r.assignableBadges ?? []).includes(badgeId)),
    can: (permission) => everything || adminRole || granted.has(permission),
  };
}

/**
 * What to type after the @ to mention a role. THE SERVER HAS THE SAME FOLD
 * (roleHandle in server/src/roles.js) and it is the one that decides who is
 * notified; if one changes the other has to.
 */
export const roleHandle = (name) => {
  const folded = String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return folded || null;
};

/**
 * The role a handle names, or null. The highest one wins when two names fold
 * to the same handle, as on the server.
 */
export const roleByHandle = (roles, handle) => sortRoles(roles).find((r) => roleHandle(r.name) === handle) ?? null;

export const roleRank = (role) => ROLE_BASE - role.position;

/** The roles an account holds, top of the hierarchy first. */
export const rolesOf = (user, roles) => {
  const mine = new Set(user?.roles ?? []);
  return sortRoles(roles).filter((r) => mine.has(r.id));
};

/** The colour a name is drawn in: that of the highest role held, or none. */
export const nameColorOf = (user, roles) => rolesOf(user, roles)[0]?.color ?? null;

/** What a role's name looks like: its gradient or rainbow if it has one, else its plain colour. */
export const roleLook = (role) => (role?.style ?? (role?.color ? { mode: 'solid', color: role.color } : null));

/** The same, for the highest role somebody holds: what their name is drawn in, in the absence of a colour of their own. */
export const nameLookOf = (user, roles) => roleLook(rolesOf(user, roles)[0]);

/** Whether the actor may act on this account at all (mute, kick, ban, hand out roles). */
export const outranks = (actor, target) => actor.rank > target.rank;

/** May the actor edit, delete or move this role? Only the ones below them. */
export const canManageRole = (actor, role) => actor.everything
  || (actor.can('roles.hierarchy') && actor.rank > roleRank(role));

/** May the actor put this role on somebody, or take it off? */
export const canAssign = (actor, role) => {
  if (actor.everything) return true;
  if (actor.rank <= roleRank(role)) return false;
  return actor.assignable.has(role.id) || actor.roles.some((r) => r.admin);
};

/**
 * Can this actor make the list `ids` out of the current one? The roles from
 * the top down to their own, theirs included, have to stay where they are.
 */
export function canReorderTo(actor, current, ids) {
  if (!actor.can('roles.hierarchy')) return false;
  if (actor.everything) return true;
  const frozen = actor.topPosition === null ? -1 : actor.topPosition;
  for (let i = 0; i <= frozen; i += 1) if (ids[i] !== current[i]?.id) return false;
  return true;
}

/** Anything in the server dialog this person could use. */
export function canAdminister(actor) {
  return actor.owner || actor.admin
    || ['roles.hierarchy', 'channels.create', 'channels.edit', 'channels.password', 'channels.delete',
      'users.kick', 'users.ban', 'badges.create', 'badges.edit'].some((p) => actor.can(p))
    || actor.assignable.size > 0 || actor.assignableBadges.size > 0;
}

/**
 * What marks the owner and a super admin, in the lists and on the card: an icon
 * rather than a word, so it costs a name no room. A crown for the owner and a
 * shield with a star for a super admin, drawn in the palette's own colours.
 *
 * @param {'owner'|'admin'} role  the account role
 * @param {string} label  what it is called, in the person's language
 */
export function roleIcon(role, label) {
  const span = document.createElement('span');
  span.className = `role-icon ${role === 'owner' ? 'owner' : 'super'}`;
  span.dataset.icon = role === 'owner' ? 'crown-simple' : 'shield-star';
  span.dataset.kind = role;
  span.title = label;
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', label);
  return span;
}
