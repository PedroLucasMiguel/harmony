// The profile card: what you get on clicking a person -- in the member list, on
// their picture in a chat or in a voice channel.
//
// A small floating card, not a dialog: it sits beside what was clicked, closes
// on a click anywhere else, and leaves the app usable behind it. It shows who
// they are (picture, banner, name, the roles they hold in the colour of each)
// and the two things you would want to do next: write to them, and -- for
// somebody who may -- change their roles, right there on the chips.
//
// Which controls exist comes from roles.js, which mirrors the server's rules to
// decide what to OFFER; the server decides what is allowed.

import {
  canAssign, contextOf, nameColorOf, outranks, roleIcon, rolesOf, sortRoles,
} from './roles.js';

/**
 * @param {object} deps
 * @param {object} deps.harmony
 * @param {(key: string, values?: object) => string} deps.t
 * @param {() => string} deps.server
 * @param {() => object|null} deps.me
 * @param {() => Array} deps.roles
 * @param {() => Map<number, object>} deps.users
 * @param {() => Set<number>} deps.online
 * @param {() => Object<number, string>} [deps.statuses]  who of them is idle or does not want to be disturbed
 * @param {(userId: number, fallback?: string) => string} deps.displayOf
 * @param {(user: object, size?: string) => HTMLElement} deps.avatarEl
 * @param {(node: HTMLElement, userId: number, user?: object) => void} deps.nameFont
 * @param {(role: string) => string} deps.roleLabel
 * @param {(user: object) => void} deps.setUser   adopt an updated account at once
 * @param {() => boolean} deps.canMessage         private messages are available
 * @param {(userId: number) => void} deps.message
 * @param {(userId: number) => boolean} deps.canManage
 * @param {(userId: number) => void} deps.manage  open the Members page on them
 * @param {() => Array} deps.badges               the server's badges
 * @param {(badge: object, size?: string) => HTMLElement} deps.badgeEl
 * @param {(scope: object, fn: Function) => any} [deps.inServer]  runs a drawing against another server's people
 * @param {(hash: string) => string} [deps.mediaUrl]  where a picture of the server being drawn is loaded from
 *
 * A card is the open server's, with everything to do with a person there -- or, from the private messages, somebody's
 * on the server a conversation belongs to (`open(userId, from, scope)`): read-only, with that server's own roles and
 * badges, its name on the card, and no status, which the private messages do not show.
 */
export function createProfileCard(deps) {
  const {
    harmony, t, me, displayOf, avatarEl, nameFont, roleLabel, setUser, badgeEl,
    statuses = () => ({}), mediaUrl = (hash) => harmony.mediaUrl(hash),
  } = deps;

  /**
   * Another server's person, from the private messages: {server, serverName, meId, users(), roles(), badges()}; or
   * null for the open server's own.
   */
  let scope = null;
  const server = () => (scope ? scope.server : deps.server());
  const users = () => (scope ? scope.users() : deps.users());
  const roles = () => (scope ? scope.roles() : deps.roles());
  const badges = () => (scope ? scope.badges() : deps.badges());
  const online = () => (scope ? new Set() : deps.online());

  const card = document.createElement('div');
  card.className = 'profile-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('profile_card.title'));
  card.hidden = true;
  document.body.append(card);

  // The little card that says what a badge is, over the badge. It lives on the
  // page rather than inside the card, which clips what hangs outside it.
  const tip = document.createElement('div');
  tip.className = 'badge-tip';
  tip.hidden = true;
  document.body.append(tip);

  function showTip(badge, from) {
    // The picture is of this card's server, which the page's own lookups are told when it is not the open one.
    const picture = scope && deps.inServer ? deps.inServer(scope, () => badgeEl(badge, 'large')) : badgeEl(badge, 'large');
    const name = document.createElement('strong');
    name.textContent = badge.name;
    tip.replaceChildren(picture, name);
    if (badge.description) {
      const text = document.createElement('span');
      text.textContent = badge.description;
      tip.append(text);
    }
    if (tip.parentNode !== card.parentNode) card.parentNode.append(tip);
    tip.style.left = '-9999px';
    tip.style.top = '0px';
    tip.hidden = false;
    const a = from.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const x = Math.min(Math.max(8, a.left + a.width / 2 - box.width / 2), window.innerWidth - box.width - 8);
    // Above the badge, or below it when there is no room above.
    const y = a.top - box.height - 8 >= 8 ? a.top - box.height - 8 : a.bottom + 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  const hideTip = () => { tip.hidden = true; };

  let openFor = null;
  let anchor = null;
  let adding = false;

  const button = (className, icon, label, run) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    if (icon) b.dataset.icon = icon;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', run);
    return b;
  };

  const dot = (color) => {
    const span = document.createElement('span');
    span.className = 'role-dot';
    span.style.setProperty('--role-color', color);
    return span;
  };

  function render() {
    // Names and pictures are drawn against the people of the server the card is of.
    return scope && deps.inServer ? deps.inServer(scope, renderCard) : renderCard();
  }

  function renderCard() {
    const user = users().get(openFor);
    if (!user) return close();
    const mine = user.id === (scope ? scope.meId : me()?.id);
    const actor = contextOf(me(), roles());
    // What somebody may do to somebody is the rank on THIS server; another server's people are only looked at.
    const above = scope ? false : (actor.owner ? true : outranks(actor, contextOf(user, roles())));
    const held = rolesOf(user, roles());

    // ---- banner, with the buttons over it
    const banner = document.createElement('div');
    banner.className = 'profile-card-banner';
    const top = nameColorOf(user, roles());
    if (top) banner.style.setProperty('--banner', top);
    if (user.bannerHash) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = mediaUrl(user.bannerHash);
      banner.append(img);
      // As dim as its owner made it; undimmed if they never chose.
      if (user.bannerDim != null) {
        banner.dataset.dim = '';
        banner.style.setProperty('--banner-dim', String(user.bannerDim));
      }
    }
    const actions = document.createElement('div');
    actions.className = 'profile-card-actions';
    if (!scope && !mine && deps.canMessage()) {
      actions.append(button('ghost small icon-only', 'chat-circle-dots', t('profile_card.message'), () => {
        close();
        deps.message(user.id);
      }));
    }
    if (!scope && !mine && deps.canManage(user.id)) {
      actions.append(button('ghost small icon-only', 'gear-six', t('profile_card.manage'), () => {
        close();
        deps.manage(user.id);
      }));
    }
    banner.append(actions);

    // ---- picture, standing on the banner's edge
    const face = avatarEl(user, 'profile-card-avatar');
    const status = document.createElement('span');
    status.className = 'profile-card-status';
    status.toggleAttribute('data-online', online().has(user.id));
    // Idle and do not disturb are what they are on this server; invisible is not on at all, as far as anyone can tell.
    const shown = online().has(user.id) ? (statuses()[user.id] ?? 'online') : null;
    if (shown) status.dataset.status = shown;
    status.title = shown ? t(`status.${shown}`) : t('profile_card.offline');
    // The private messages show nobody's status: no dot at all.
    status.hidden = Boolean(scope);
    // The status dot sits on the picture's edge, so it cannot be a child of the
    // picture (which clips to its circle): the two share a wrapper instead.
    const faceWrap = document.createElement('div');
    faceWrap.className = 'profile-card-face';
    faceWrap.append(face, status);

    // ---- who
    const name = document.createElement('strong');
    name.className = 'profile-card-name';
    name.textContent = displayOf(user.id, user.nickname);
    nameFont(name, user.id, user);
    const handle = document.createElement('div');
    handle.className = 'profile-card-handle';
    handle.textContent = user.nickname;
    if (user.role === 'owner' || user.role === 'admin') {
      handle.append(' ', roleIcon(user.role, roleLabel(user.role)));
    }

    const body = document.createElement('div');
    body.className = 'profile-card-body';
    body.append(name, handle);

    // Badges, right under the name. Pointing at one says what it is.
    const own = (user.badges ?? [])
      .map((id) => badges().find((b) => b.id === id))
      .filter(Boolean);
    if (own.length) {
      const row = document.createElement('div');
      row.className = 'profile-card-badges';
      for (const badge of own) {
        const holder = document.createElement('button');
        holder.type = 'button';
        holder.className = 'profile-card-badge';
        holder.dataset.badgeId = String(badge.id);
        holder.setAttribute('aria-label', badge.description ? `${badge.name}: ${badge.description}` : badge.name);
        holder.append(badgeEl(badge, 'small'));
        holder.addEventListener('mouseenter', () => showTip(badge, holder));
        holder.addEventListener('focus', () => showTip(badge, holder));
        holder.addEventListener('mouseleave', hideTip);
        holder.addEventListener('blur', hideTip);
        // A touch screen has no pointing: a tap shows it, and the next tap hides it.
        holder.addEventListener('click', () => (tip.hidden ? showTip(badge, holder) : hideTip()));
        row.append(holder);
      }
      body.append(row);
    }

    // Whose card it is of, when it is not the server on screen.
    if (scope) {
      const where = document.createElement('div');
      where.className = 'profile-card-server';
      where.textContent = t('profile_card.on_server', { name: scope.serverName });
      body.append(where);
    }

    if (user.createdAt) {
      const since = document.createElement('div');
      since.className = 'profile-card-since';
      since.textContent = t('profile_card.member_since', {
        date: new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
      });
      body.append(since);
    }

    // ---- roles, as chips you can take off and add to
    const section = document.createElement('div');
    section.className = 'profile-card-roles';
    const label = document.createElement('div');
    label.className = 'profile-card-label';
    label.textContent = t('profile_card.roles');
    const chips = document.createElement('div');
    chips.className = 'profile-card-chips';

    const apply = async (ids) => {
      try {
        const { user: fresh } = await harmony.api.setUserRoles(server(), user.id, ids);
        setUser(fresh);
      } catch (err) {
        note.textContent = err.message;
        note.hidden = false;
        return;
      }
      adding = false;
      render();
    };
    const note = document.createElement('p');
    note.className = 'error profile-card-note';
    note.hidden = true;

    for (const role of held) {
      const chip = document.createElement('span');
      chip.className = 'role-chip';
      chip.append(dot(role.color), role.name);
      if (above && canAssign(actor, role)) {
        chip.append(button('profile-card-chip-x', 'x', t('profile_card.remove_role', { name: role.name }), () => {
          apply(held.filter((r) => r.id !== role.id).map((r) => r.id));
        }));
      }
      chips.append(chip);
    }
    const addable = above
      ? sortRoles(roles()).filter((r) => !held.some((h) => h.id === r.id) && canAssign(actor, r))
      : [];
    if (addable.length) {
      chips.append(button('role-chip profile-card-add', 'plus', t('profile_card.add_role'), () => {
        adding = !adding;
        render();
      }));
    }
    if (!held.length && !addable.length) {
      const none = document.createElement('span');
      none.className = 'profile-card-none';
      none.textContent = t('profile_card.no_roles');
      chips.append(none);
    }
    section.append(label, chips);

    if (adding && addable.length) {
      const list = document.createElement('div');
      list.className = 'profile-card-pick';
      for (const role of addable) {
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'ghost menu-item';
        pick.append(dot(role.color), ' ', role.name);
        pick.addEventListener('click', () => apply([...held.map((r) => r.id), role.id]));
        list.append(pick);
      }
      section.append(list);
    }
    section.append(note);
    body.append(section);

    card.replaceChildren(banner, faceWrap, body);
    place();
  }

  /** Beside what was clicked, on the side with room, kept inside the window. */
  function place() {
    if (!anchor?.isConnected) return;
    card.style.left = '-9999px';
    card.style.top = '0px';
    card.hidden = false;
    const a = anchor.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const gap = 8;
    let x = a.left > window.innerWidth / 2 ? a.left - box.width - gap : a.right + gap;
    if (x + box.width > window.innerWidth - gap || x < gap) {
      x = Math.min(Math.max(gap, a.left), window.innerWidth - box.width - gap);
    }
    const y = Math.min(Math.max(gap, a.top), window.innerHeight - box.height - gap);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function close() {
    openFor = null;
    anchor = null;
    adding = false;
    scope = null;
    card.hidden = true;
    card.replaceChildren();
    hideTip();
  }

  /** Open on a person, beside the element that was clicked; the same click again puts it away. */
  function open(userId, from, ofScope = null) {
    if (openFor === userId && anchor === from && !card.hidden) return close();
    openFor = userId;
    anchor = from;
    adding = false;
    scope = ofScope;
    // Over a dialog that is open (a group's members), or it would be behind it: a modal is above the whole page.
    const host = [...document.querySelectorAll('dialog[open]')].pop() ?? document.body;
    if (card.parentNode !== host) host.append(card);
    render();
    return undefined;
  }

  document.addEventListener('pointerdown', (event) => {
    if (card.hidden || card.contains(event.target)) return;
    // The click that opens it is handled by whoever was clicked.
    if (event.target.closest?.('[data-profile-user]')) return;
    close();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !card.hidden) close();
  });
  window.addEventListener('resize', () => { if (!card.hidden) place(); });

  return {
    open,
    close,
    /** Something it shows may have changed (a role, a picture, who is online). */
    refresh() {
      if (!card.hidden) render();
    },
    get isOpen() {
      return !card.hidden;
    },
  };
}
