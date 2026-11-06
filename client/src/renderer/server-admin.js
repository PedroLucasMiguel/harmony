// The server's own pages of the server dialog: Roles, Members and Channels.
// (General -- the name, the logo, the door -- is app.js's, and older.)
//
// Everything here asks the server and shows what it says. The checks in
// roles.js decide which controls are OFFERED, so nobody is handed a button
// that always ends in "you do not have permission"; the server decides what
// is allowed, on every request, and these pages only carry its answer.
//
// A change is applied at once and the page is drawn from what came back:
// toggling a role on somebody is one request, not a checkbox and a Save, and
// by the time it returns their client has already been told. Every editor
// here works that way, not only the member's: a switch or a menu is sent as
// it is moved, and a name or a colour a moment after the last keystroke (see
// `autosave`). Only a role, channel or badge that does not exist yet has a
// button, Create, because making one tells everybody.

import {
  PERMISSION_GROUPS, canAssign, canManageRole, canReorderTo, contextOf, nameLookOf, outranks, roleIcon, roleLook, rolesOf,
  sortRoles,
} from './roles.js';
import {
  NAME_COLOR_SPEED, NAME_COLOR_STOPS, paintName, startingPoint,
} from './name-color.js';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Sends what an editor holds, whenever it has changed, without a Save.
 *
 * `touch(delay)` says "it changed": the save runs `delay` ms after the last such call (so a name is sent when the
 * typing stops, not on every key, and a handful of switches in a row are one request). Saves run one at a time, in
 * order, and each reads the editor as it is when it runs, so a change made during a save is sent by the next one
 * rather than lost or sent out of turn. `flush()` runs what is waiting at once and resolves when everything is
 * sent: it is what has to be awaited before the thing being edited is changed or closed.
 *
 * @param {() => Promise<boolean|void>} run  reads the editor and sends it; throws to say it could not, and
 *   returns false when there was nothing to send (a colour half typed, a name not yet written)
 * @param {(state: 'saving'|'saved'|'idle'|'error', message?: string) => void} [report]
 */
export function autosave(run, report = () => {}) {
  let timer = null;
  let running = null;
  let again = false;
  let dirty = false;

  async function cycle() {
    do {
      again = false;
      dirty = false;
      report('saving');
      try {
        const sent = await run();
        if (!again && !dirty) report(sent === false ? 'idle' : 'saved');
      } catch (err) {
        report('error', err.message);
      }
    } while (again);
  }

  function fire() {
    timer = null;
    // One at a time: what changed meanwhile is what the running cycle goes round again for.
    if (running) {
      again = true;
      return running;
    }
    running = cycle().finally(() => { running = null; });
    return running;
  }

  return {
    touch(delay = 600) {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(fire, delay);
    },
    /** Nothing is waiting any more: the thing it was for is gone. */
    cancel() {
      clearTimeout(timer);
      timer = null;
      dirty = false;
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        fire();
      }
      while (running) await running;
    },
    get pending() { return timer !== null || running !== null; },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.harmony
 * @param {(key: string, values?: object) => string} deps.t
 * @param {() => string} deps.server
 * @param {() => object|null} deps.me                 the signed-in account
 * @param {() => Array} deps.roles                    the roles, any order
 * @param {() => Map<number, object>} deps.users
 * @param {() => {list: Array, groups: Array}} deps.channels
 * @param {(roles: Array) => void} deps.setRoles      adopt a roles list at once
 * @param {(user: object) => void} deps.setUser       adopt an updated account at once
 * @param {(userId: number, fallback?: string) => string} deps.displayOf
 * @param {(user: object, size?: string) => HTMLElement} deps.avatarEl
 * @param {(text: string, options?: object) => Promise<boolean>} deps.confirm
 * @param {(channelId: number, groupId: number|null) => void} deps.moveToGroup
 * @param {(userId: number, role: string) => Promise<object>} deps.setAccountRole
 * @param {() => Array} deps.badges                   the server's badges
 * @param {(file: File) => Promise<{hash: string, preview: string}>} deps.uploadBadgeImage
 * @param {(badge: object, size?: string) => HTMLElement} deps.badgeEl   a badge's picture or emoji
 */
export function createServerAdmin(deps) {
  const {
    harmony, t, server, me, roles, users, channels, setRoles, setUser, displayOf, avatarEl,
    badges, badgeEl,
  } = deps;
  const $ = (id) => document.getElementById(id);
  const ctx = () => contextOf(me(), roles());

  // ---- changes applied as they are made ------------------------------------------------------

  /** The "Saving..." / "Saved" line in the dialog's footer, with failures on the editor's own error line as well. */
  const statusLine = (note, errorNode) => (state, message) => {
    if (state === 'error') {
      // In the footer, where it is seen whatever the editor is scrolled to, and on the editor's own line too.
      note.textContent = message;
      note.dataset.state = 'error';
      show(errorNode, message);
      return;
    }
    show(errorNode, '');
    if (state === 'idle') {
      note.textContent = '';
      delete note.dataset.state;
      return;
    }
    note.textContent = state === 'saving' ? t('server_admin.saving') : t('server_admin.saved_live');
    note.dataset.state = state;
  };

  // ---- small widgets ----------------------------------------------------------------------

  const clear = (node) => node.replaceChildren();

  const show = (node, text) => {
    node.textContent = text ?? '';
    node.hidden = !text;
  };

  const dot = (color) => {
    const span = document.createElement('span');
    span.className = 'role-dot';
    if (color) span.style.setProperty('--role-color', color);
    return span;
  };

  /** A checkbox with a label, in the app's own `.check` shape. */
  function checkRow({ label, hint, checked, disabled, color, onChange }) {
    const row = document.createElement('label');
    row.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    // The same switch as the settings pages.
    input.className = 'switch';
    input.setAttribute('role', 'switch');
    input.checked = Boolean(checked);
    input.disabled = Boolean(disabled);
    input.addEventListener('change', () => onChange?.(input.checked, input));
    const text = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = label;
    if (color) name.prepend(dot(color), ' ');
    text.append(name);
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      text.append(small);
    }
    row.append(input, text);
    return row;
  }

  const item = (selected, ...children) => {
    const li = document.createElement('li');
    li.className = 'admin-item';
    li.tabIndex = 0;
    if (selected) li.setAttribute('aria-selected', 'true');
    li.append(...children.filter(Boolean));
    return li;
  };

  const iconButton = (icon, label, disabled, run) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost small icon-only';
    button.dataset.icon = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    return button;
  };

  const roleChips = (user) => {
    const wrap = document.createElement('span');
    wrap.className = 'role-chips';
    for (const role of rolesOf(user, roles())) {
      const chip = document.createElement('span');
      chip.className = 'role-chip';
      chip.append(dot(role.color), role.name);
      wrap.append(chip);
    }
    return wrap;
  };

  // =========================================================================================
  // Roles
  // =========================================================================================

  const rl = {
    filter: $('roles-filter'),
    list: $('roles-list'),
    add: $('roles-new'),
    editor: $('roles-editor'),
    name: $('role-name'),
    style: $('role-style'),
    admin: $('role-admin'),
    permissions: $('role-permissions'),
    assignField: $('role-assign-field'),
    assignable: $('role-assignable'),
    badgesField: $('role-badges-field'),
    badgeList: $('role-badges'),
    error: $('role-error'),
    status: $('server-status'),
    save: $('role-save'),
    remove: $('role-delete'),
  };
  /** The role being edited: its id, or 'new'. */
  let roleSelected = null;
  /** What the editor holds, so a redraw from the server does not lose a half-typed edit. */
  let roleDraft = null;
  /** Whether this person may change the role on show: nothing is sent for one they may not. */
  let roleEditable = false;
  /** The other roles and badges the editor lists, as drawn: a redraw that would change nothing is not made. */
  let roleListed = '';
  const roleAuto = autosave(saveRole, statusLine(rl.status, rl.error));
  /** The role on show changed: it is sent in `delay` ms. Not for a new one, which waits for Create. */
  const touchRole = (delay) => {
    if (roleDraft && roleSelected !== 'new' && roleEditable) roleAuto.touch(delay);
  };

  const permLabel = (p) => t(`server_admin.perm_${p.replace('.', '_')}`);
  const permHint = (p) => t(`server_admin.perm_${p.replace('.', '_')}_hint`);

  async function reloadRoles() {
    const { roles: fresh } = await harmony.api.roles(server());
    setRoles(fresh);
  }

  function renderRoleList() {
    const actor = ctx();
    const ordered = sortRoles(roles());
    const needle = rl.filter.value.trim().toLowerCase();
    // A filtered list is a few of the roles, not the hierarchy: a role is not moved past ones that are not shown.
    const filtered = needle !== '';
    const shown = ordered.map((role, index) => ({ role, index }))
      .filter(({ role }) => !filtered || role.name.toLowerCase().includes(needle));
    const children = shown.map(({ role, index }) => {
      const move = (step) => {
        const ids = ordered.map((r) => r.id);
        [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
        return ids;
      };
      const may = (step) => {
        if (filtered) return false;
        const to = index + step;
        if (to < 0 || to >= ordered.length) return false;
        return canReorderTo(actor, ordered, move(step)) && canManageRole(actor, role)
          && canManageRole(actor, ordered[to]);
      };
      const name = document.createElement('span');
      name.className = 'admin-item-name';
      name.textContent = role.name;
      paintName(name, null, roleLook(role));
      const li = item(roleSelected === role.id, dot(role.color), name,
        iconButton('arrow-up', t('server_admin.move_up'), !may(-1), () => reorderRoles(move(-1))),
        iconButton('arrow-down', t('server_admin.move_down'), !may(1), () => reorderRoles(move(1))));
      li.dataset.roleId = String(role.id);
      li.addEventListener('click', () => selectRole(role.id));
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectRole(role.id);
        }
      });
      return li;
    });
    if (filtered && !children.length) {
      const none = document.createElement('li');
      none.className = 'admin-empty';
      none.textContent = t('server_admin.no_roles_match');
      children.push(none);
    }
    rl.list.replaceChildren(...children);
    rl.add.hidden = !actor.can('roles.hierarchy');
  }

  async function reorderRoles(ids) {
    show(rl.error, '');
    try {
      const { roles: fresh } = await harmony.api.reorderRoles(server(), ids);
      setRoles(fresh);
    } catch (err) {
      show(rl.error, err.message);
      rl.editor.hidden = false;
    }
  }

  async function selectRole(id) {
    // What was changed on the one being left is sent first: it is read from the draft this replaces.
    await roleAuto.flush();
    roleSelected = id;
    roleDraft = null;
    rl.status.textContent = '';
    show(rl.error, '');
    renderRoles();
  }

  /**
   * The look of the name: a plain colour, a gradient that moves, or the
   * rainbow, with what each needs under it and a preview drawn as it will be.
   * Changes go to the draft; Save sends them.
   */
  function renderRoleStyle(editable) {
    const draft = roleDraft;
    const mode = draft.style?.mode ?? 'solid';
    const wrap = document.createElement('div');
    wrap.className = 'role-style';

    const preview = document.createElement('div');
    preview.className = 'role-style-preview';
    const sample = document.createElement('strong');
    sample.textContent = draft.name || t('server_admin.role_name');
    paintName(sample, null, draft.style ?? draft.color);
    preview.append(sample);

    const kinds = document.createElement('div');
    kinds.className = 'font-grid';
    kinds.setAttribute('role', 'radiogroup');
    for (const kind of ['solid', 'gradient', 'rainbow']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'font-choice';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(kind === mode));
      button.disabled = !editable;
      const label = document.createElement('span');
      label.textContent = t(`profile.color_${kind}`);
      paintName(label, null, kind === 'solid' ? draft.color : startingPoint(kind, draft.style ?? { colors: [draft.color, '#00c6ff'] }));
      button.append(label);
      button.addEventListener('click', () => {
        if (kind === 'solid') draft.style = null;
        else {
          const base = draft.style ?? { colors: [HEX.test(draft.color) ? draft.color : '#8e2de2', '#00c6ff'] };
          draft.style = startingPoint(kind, base);
          if (draft.style.mode === 'gradient') draft.color = draft.style.colors[0];
        }
        renderRoleEditor({ force: true });
        touchRole(150);
      });
      kinds.append(button);
    }

    const picker = (value, label, change) => {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = HEX.test(value) ? value : '#99aab5';
      input.disabled = !editable;
      input.setAttribute('aria-label', label);
      // Straight into the draft and the preview as it is dragged, and sent when the dragging has paused: the picker is
      // not drawn again meanwhile (see renderRoleEditor), or it would close under the hand that is using it.
      input.addEventListener('input', () => {
        change(input.value);
        paintName(sample, null, draft.style ?? draft.color);
        touchRole(500);
      });
      return input;
    };

    const editor = document.createElement('div');
    editor.className = 'name-color-editor';
    const stops = document.createElement('div');
    stops.className = 'name-color-stops';

    if (mode === 'solid') {
      const row = document.createElement('span');
      row.className = 'name-color-stop';
      const hex = document.createElement('input');
      hex.type = 'text';
      hex.maxLength = 7;
      hex.spellcheck = false;
      hex.autocomplete = 'off';
      hex.value = draft.color;
      hex.disabled = !editable;
      hex.className = 'role-color-hex';
      hex.id = 'role-color-hex';
      const color = picker(draft.color, t('profile.color_stop', { n: 1 }), (v) => { draft.color = v; hex.value = v; });
      hex.addEventListener('input', () => {
        draft.color = hex.value;
        if (HEX.test(hex.value)) color.value = hex.value;
        paintName(sample, null, draft.color);
        // Half a colour is not sent: saveRole waits for one.
        touchRole(600);
      });
      row.append(color, hex);
      stops.append(row);
    } else if (mode === 'gradient') {
      draft.style.colors.forEach((color, index) => {
        const row = document.createElement('span');
        row.className = 'name-color-stop';
        row.append(picker(color, t('profile.color_stop', { n: index + 1 }), (v) => {
          draft.style.colors[index] = v;
          if (index === 0) draft.color = v;
        }));
        if (draft.style.colors.length > NAME_COLOR_STOPS.min) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'ghost small icon-only';
          remove.dataset.icon = 'x';
          remove.disabled = !editable;
          remove.title = t('profile.color_remove', { n: index + 1 });
          remove.setAttribute('aria-label', remove.title);
          remove.addEventListener('click', () => {
            draft.style.colors.splice(index, 1);
            draft.color = draft.style.colors[0];
            renderRoleEditor({ force: true });
            touchRole(150);
          });
          row.append(remove);
        }
        stops.append(row);
      });
    }
    editor.append(stops);

    if (mode === 'gradient' && draft.style.colors.length < NAME_COLOR_STOPS.max) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ghost small';
      add.textContent = t('profile.color_add');
      add.disabled = !editable;
      add.addEventListener('click', () => {
        draft.style.colors.push(draft.style.colors.at(-1));
        renderRoleEditor({ force: true });
        touchRole(150);
      });
      editor.append(add);
    }

    if (mode !== 'solid') {
      // Seconds per cycle, shown inverted so that faster is to the right.
      const toSlider = (seconds) => NAME_COLOR_SPEED.max + NAME_COLOR_SPEED.min - seconds;
      const row = document.createElement('label');
      row.className = 'name-color-speed';
      const caption = document.createElement('span');
      caption.textContent = t('profile.color_speed');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(NAME_COLOR_SPEED.min);
      range.max = String(NAME_COLOR_SPEED.max);
      range.step = String(NAME_COLOR_SPEED.step);
      range.value = String(toSlider(draft.style.speed));
      range.disabled = !editable;
      const value = document.createElement('span');
      value.textContent = t('profile.color_speed_value', { seconds: draft.style.speed });
      range.addEventListener('input', () => {
        draft.style.speed = toSlider(Number(range.value));
        value.textContent = t('profile.color_speed_value', { seconds: draft.style.speed });
        paintName(sample, null, draft.style);
        touchRole(500);
      });
      row.append(caption, range, value);
      editor.append(row);
    }

    wrap.append(preview, kinds, editor);
    rl.style.replaceChildren(wrap);
  }

  /** Whether a role, as the server has it, is what the draft says: the editor then has nothing to learn from it. */
  function roleIsDraft(role, draft) {
    if (!role) return false;
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    return role.name === draft.name
      && (role.color ?? '').toLowerCase() === (draft.style?.colors?.[0] ?? draft.color ?? '').toLowerCase()
      && JSON.stringify(role.style ?? null) === JSON.stringify(draft.style ?? null)
      && Boolean(role.admin) === draft.admin
      && same(role.permissions ?? [], draft.permissions)
      && same(role.assignable ?? [], draft.assignable)
      && same(role.assignableBadges ?? [], draft.assignableBadges);
  }

  /**
   * The editor, from the draft if there is one and from the role if not.
   *
   * Drawn again when the server says something that is not what the draft already holds -- which is not the case for
   * the echo of this editor's own change. That one is left alone: the editor is already right, and drawing it again
   * would close the colour picker the change came from, under the hand that is dragging in it.
   *
   * @param {{force?: boolean}} [options]  force: the editor's own controls changed what it shows (the kind of colour, an
   *   administrator ticked), so it is drawn whatever the server says
   */
  function renderRoleEditor({ force = false } = {}) {
    const actor = ctx();
    const isNew = roleSelected === 'new';
    const role = isNew ? null : roles().find((r) => r.id === roleSelected) ?? null;
    if (!isNew && !role) {
      rl.editor.hidden = true;
      return;
    }
    const listed = JSON.stringify([sortRoles(roles()).map((r) => [r.id, r.name, r.color]), badges().map((b) => [b.id, b.name])]);
    if (!force && !rl.editor.hidden && roleDraft && !isNew && roleIsDraft(role, roleDraft) && listed === roleListed) return;
    roleListed = listed;
    rl.editor.hidden = false;

    const draft = roleDraft ?? {
      name: role?.name ?? '',
      color: role?.color ?? '#99aab5',
      // null is a plain colour; otherwise a gradient or the rainbow.
      style: role?.style ? { ...role.style, colors: role.style.colors ? [...role.style.colors] : undefined } : null,
      admin: Boolean(role?.admin),
      permissions: [...(role?.permissions ?? [])],
      assignable: [...(role?.assignable ?? [])],
      assignableBadges: [...(role?.assignableBadges ?? [])],
    };
    roleDraft = draft;

    const editable = isNew ? actor.can('roles.hierarchy') : canManageRole(actor, role);
    roleEditable = editable;
    rl.name.value = draft.name;
    rl.admin.checked = draft.admin;
    // Nobody can make something that has more than they do.
    rl.admin.disabled = !editable || (!actor.admin && !role?.admin);
    rl.name.disabled = !editable;
    renderRoleStyle(editable);

    rl.permissions.replaceChildren(...PERMISSION_GROUPS.map((group) => {
      const box = document.createElement('div');
      box.className = 'field';
      const title = document.createElement('span');
      title.textContent = t(`server_admin.group_${group.key}`);
      box.append(title);
      for (const permission of group.permissions) {
        const was = Boolean(role?.permissions.includes(permission));
        box.append(checkRow({
          label: permLabel(permission),
          hint: permHint(permission),
          checked: draft.admin || draft.permissions.includes(permission),
          // An admin role has all of them: nothing to choose.
          disabled: !editable || draft.admin || (!actor.can(permission) && !was),
          onChange: (on) => {
            draft.permissions = draft.permissions.filter((p) => p !== permission);
            if (on) draft.permissions.push(permission);
            touchRole(150);
          },
        }));
      }
      return box;
    }));

    const others = sortRoles(roles()).filter((r) => r.id !== role?.id);
    rl.assignable.replaceChildren(...others.map((other) => {
      const was = Boolean(role?.assignable.includes(other.id));
      return checkRow({
        label: other.name,
        color: other.color,
        checked: draft.admin || draft.assignable.includes(other.id),
        disabled: !editable || draft.admin || (!canAssign(actor, other) && !was),
        onChange: (on) => {
          draft.assignable = draft.assignable.filter((id) => id !== other.id);
          if (on) draft.assignable.push(other.id);
          touchRole(150);
        },
      });
    }));
    rl.assignField.hidden = others.length === 0;

    // The badges this role can hand out. Nobody lists one they cannot award.
    rl.badgeList.replaceChildren(...badges().map((badge) => {
      const was = Boolean(role?.assignableBadges?.includes(badge.id));
      const row = checkRow({
        label: badge.name,
        checked: draft.admin || draft.assignableBadges.includes(badge.id),
        disabled: !editable || draft.admin || (!actor.canAward(badge.id) && !was),
        onChange: (on) => {
          draft.assignableBadges = draft.assignableBadges.filter((id) => id !== badge.id);
          if (on) draft.assignableBadges.push(badge.id);
          touchRole(150);
        },
      });
      row.querySelector('span').prepend(badgeEl(badge, 'small'), ' ');
      return row;
    }));
    rl.badgesField.hidden = badges().length === 0;

    // Create only for a role that is not made yet; one that is made is saved as it is changed.
    rl.save.hidden = !isNew;
    rl.save.disabled = !editable;
    rl.remove.hidden = isNew;
    rl.remove.disabled = !editable;
    if (isNew) rl.status.textContent = '';
  }

  function renderRoles() {
    renderRoleList();
    renderRoleEditor();
  }

  rl.filter.addEventListener('input', renderRoleList);
  rl.add.addEventListener('click', () => selectRole('new'));
  rl.name.addEventListener('input', () => {
    if (!roleDraft) return;
    roleDraft.name = rl.name.value;
    touchRole(600);
  });
  rl.admin.addEventListener('change', () => {
    if (!roleDraft) return;
    roleDraft.admin = rl.admin.checked;
    renderRoleEditor({ force: true });
    touchRole(150);
  });

  /** What the role editor holds, as the request that makes or changes a role. Null while the colour is not a colour yet. */
  function roleBody(draft) {
    // A gradient's plain colour -- the dot beside the name -- is its first stop.
    const color = draft.style?.colors?.[0] ?? draft.color;
    if (!HEX.test(color)) return null;
    return {
      name: draft.name,
      color,
      style: draft.style,
      admin: draft.admin,
      permissions: draft.permissions,
      assignable: draft.assignable,
      assignableBadges: draft.assignableBadges,
    };
  }

  /** Sends the role on show, as it is now: what `touch` was for. */
  async function saveRole() {
    const draft = roleDraft;
    const id = roleSelected;
    if (!draft || id === 'new' || id === null) return false;
    // Half a colour typed, or no name yet: there is nothing to send, and nothing to complain about while it is typed.
    const body = roleBody(draft);
    if (!body || !draft.name.trim()) return false;
    await harmony.api.updateRole(server(), id, body);
    await reloadRoles();
    return true;
  }

  // Making a role: the one thing on this page that waits for a button, because everybody is told of it.
  rl.save.addEventListener('click', async () => {
    show(rl.error, '');
    const draft = roleDraft;
    if (!draft || roleSelected !== 'new') return;
    const body = roleBody(draft);
    if (!body) return show(rl.error, t('server_admin.bad_color'));
    try {
      const { role } = await harmony.api.createRole(server(), body);
      await reloadRoles();
      roleSelected = role.id;
      roleDraft = null;
      renderRoles();
    } catch (err) {
      show(rl.error, err.message);
    }
  });

  rl.remove.addEventListener('click', async () => {
    const role = roles().find((r) => r.id === roleSelected);
    if (!role) return;
    // What was being changed on it is of no use now.
    roleAuto.cancel();
    if (!await deps.confirm(t('server_admin.delete_role_title', { name: role.name }), {
      text: t('server_admin.delete_role_text'),
      okLabel: t('server_admin.delete_role'),
    })) return;
    try {
      await harmony.api.deleteRole(server(), role.id);
      await reloadRoles();
      roleSelected = null;
      roleDraft = null;
      renderRoles();
    } catch (err) {
      show(rl.error, err.message);
    }
  });

  // =========================================================================================
  // Members
  // =========================================================================================

  const mb = {
    filter: $('members-filter'),
    list: $('members-list'),
    editor: $('members-editor'),
    subject: $('member-subject'),
    roles: $('member-roles'),
    badgesField: $('member-badges-field'),
    badgeList: $('member-badges'),
    note: $('member-roles-note'),
    error: $('member-error'),
    kick: $('member-kick'),
    ban: $('member-ban'),
    actions: $('member-actions'),
  };
  let memberSelected = null;

  /** What the actor outranks and what the target is: the numbers behind every button. */
  const ctxOfUser = (user) => contextOf(user, roles());

  function renderMemberList() {
    const needle = mb.filter.value.trim().toLowerCase();
    const everybody = [...users().values()]
      .filter((u) => !needle
        || displayOf(u.id, u.nickname).toLowerCase().includes(needle)
        || u.nickname.toLowerCase().includes(needle))
      // The hierarchy, top first, then by name.
      .sort((a, b) => ctxOfUser(b).rank - ctxOfUser(a).rank
        || displayOf(a.id, a.nickname).localeCompare(displayOf(b.id, b.nickname)));
    mb.list.replaceChildren(...everybody.map((user) => {
      const name = document.createElement('span');
      name.className = 'admin-item-name';
      name.textContent = displayOf(user.id, user.nickname);
      paintName(name, user.nameColor ?? null, nameLookOf(user, roles()));
      const li = item(memberSelected === user.id, avatarEl(user, 'tiny'), name);
      if (user.role === 'owner' || user.role === 'admin') {
        li.append(roleIcon(user.role, t(`roles.${user.role}`)));
      }
      li.append(roleChips(user));
      if (user.banned) li.dataset.banned = '';
      li.dataset.userId = String(user.id);
      li.addEventListener('click', () => selectMember(user.id));
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectMember(user.id);
        }
      });
      return li;
    }));
  }

  function selectMember(id) {
    memberSelected = id;
    renderMembers();
  }

  async function changeRoles(user, ids) {
    show(mb.error, '');
    try {
      const { user: fresh } = await harmony.api.setUserRoles(server(), user.id, ids);
      // At once, from the reply: the push that follows says the same thing.
      setUser(fresh);
    } catch (err) {
      show(mb.error, err.message);
    }
    renderMembers();
  }

  function renderMemberEditor() {
    const user = users().get(memberSelected);
    if (!user) {
      mb.editor.hidden = true;
      return;
    }
    mb.editor.hidden = false;
    const actor = ctx();
    const target = ctxOfUser(user);
    const mine = user.id === me()?.id;
    // The owner may edit anybody -- themselves included; everybody else only people below them.
    const above = actor.owner || outranks(actor, target);

    const name = document.createElement('strong');
    name.textContent = displayOf(user.id, user.nickname);
    paintName(name, user.nameColor ?? null, nameLookOf(user, roles()));
    mb.subject.replaceChildren(avatarEl(user, 'tiny'), name);
    if (user.role === 'owner' || user.role === 'admin') {
      mb.subject.append(roleIcon(user.role, t(`roles.${user.role}`)));
    }

    const held = new Set(user.roles ?? []);
    const rows = sortRoles(roles()).map((role) => checkRow({
      label: role.name,
      color: role.color,
      checked: held.has(role.id),
      disabled: !above || !canAssign(actor, role),
      onChange: (on, input) => {
        const next = new Set(held);
        if (on) next.add(role.id);
        else next.delete(role.id);
        input.disabled = true;
        changeRoles(user, [...next]);
      },
    }));

    // The one thing that is not a role: only the owner makes a super admin.
    if (actor.owner && user.role !== 'owner') {
      rows.unshift(checkRow({
        label: t('roles.admin'),
        hint: t('server_admin.super_admin_hint'),
        checked: user.role === 'admin',
        onChange: async (on, input) => {
          input.disabled = true;
          show(mb.error, '');
          try {
            const { user: fresh } = await deps.setAccountRole(user.id, on ? 'admin' : 'member');
            setUser(fresh);
          } catch (err) {
            show(mb.error, err.message);
          }
          renderMembers();
        },
      }));
    }
    mb.roles.replaceChildren(...rows);

    // Badges: only the ones this person may hand out are offered, and a change
    // is made at once, as a role is.
    const heldBadges = new Set(user.badges ?? []);
    const awardable = badges().filter((b) => actor.canAward(b.id) || heldBadges.has(b.id));
    mb.badgeList.replaceChildren(...awardable.map((badge) => {
      const row = checkRow({
        label: badge.name,
        checked: heldBadges.has(badge.id),
        disabled: !actor.canAward(badge.id),
        onChange: async (on, input) => {
          const next = new Set(heldBadges);
          if (on) next.add(badge.id);
          else next.delete(badge.id);
          input.disabled = true;
          show(mb.error, '');
          try {
            const { user: fresh } = await harmony.api.setUserBadges(server(), user.id, [...next]);
            setUser(fresh);
          } catch (err) {
            show(mb.error, err.message);
          }
          renderMembers();
        },
      });
      row.querySelector('span').prepend(badgeEl(badge, 'small'), ' ');
      return row;
    }));
    mb.badgesField.hidden = awardable.length === 0;
    show(mb.note, mine && !actor.owner ? t('server_admin.not_your_own_roles')
      : !above ? t('server_admin.outranks_you') : '');

    const kickable = actor.can('users.kick') && outranks(actor, target);
    const bannable = actor.can('users.ban') && outranks(actor, target);
    mb.kick.hidden = !kickable;
    mb.ban.hidden = !bannable;
    mb.ban.textContent = user.banned ? t('server_admin.unban') : t('server_admin.ban');
    mb.actions.hidden = !kickable && !bannable;
    show(mb.error, '');
  }

  function renderMembers() {
    renderMemberList();
    renderMemberEditor();
  }

  mb.filter.addEventListener('input', renderMemberList);

  mb.kick.addEventListener('click', async () => {
    const user = users().get(memberSelected);
    if (!user) return;
    if (!await deps.confirm(t('server_admin.kick_title', { name: displayOf(user.id, user.nickname) }), {
      text: t('server_admin.kick_text'),
      okLabel: t('server_admin.kick'),
    })) return;
    try {
      await harmony.api.kickUser(server(), user.id);
      show(mb.error, '');
    } catch (err) {
      show(mb.error, err.message);
    }
  });

  mb.ban.addEventListener('click', async () => {
    const user = users().get(memberSelected);
    if (!user) return;
    const lifting = Boolean(user.banned);
    if (!lifting && !await deps.confirm(t('server_admin.ban_title', { name: displayOf(user.id, user.nickname) }), {
      text: t('server_admin.ban_text'),
      okLabel: t('server_admin.ban'),
    })) return;
    try {
      const { user: fresh } = await harmony.api.banUser(server(), user.id, !lifting);
      setUser(fresh);
      renderMembers();
    } catch (err) {
      show(mb.error, err.message);
    }
  });

  // =========================================================================================
  // Channels
  // =========================================================================================

  const ch = {
    list: $('chan-list'),
    newText: $('chan-new-text'),
    newVoice: $('chan-new-voice'),
    newForum: $('chan-new-forum'),
    newGroup: $('chan-new-group'),
    editor: $('chan-editor'),
    subject: $('chan-subject'),
    name: $('chan-name'),
    groupField: $('chan-group-field'),
    group: $('chan-group'),
    follows: $('chan-follows'),
    passwordField: $('chan-password-field'),
    password: $('chan-password'),
    passwordNote: $('chan-password-note'),
    passwordOffField: $('chan-password-off-field'),
    passwordOff: $('chan-password-off'),
    rolesField: $('chan-roles-field'),
    roles: $('chan-roles'),
    usersField: $('chan-users-field'),
    users: $('chan-users'),
    userAdd: $('chan-user-add'),
    error: $('chan-error'),
    status: $('server-status'),
    save: $('chan-save'),
    remove: $('chan-delete'),
  };
  /** {kind: 'channel'|'group'|'new-text'|'new-voice'|'new-group', id?} */
  let chanSelected = null;
  let chanRoles = [];
  /** People let in by name, besides the roles. */
  let chanUsers = [];
  /** What has been typed so far, kept so that adding a person does not wipe it. */
  let chanName = null;
  let chanPassword = '';
  /** A password is sent when it has been typed and the box let go of, not as it is typed: half of one locks people out. */
  let chanPasswordReady = false;
  const chanAuto = autosave(saveChannel, statusLine(ch.status, ch.error));
  /** The channel or group on show changed: it is sent in `delay` ms. Not a new one, which waits for Create. */
  const touchChannel = (delay) => {
    if (chanSelected && !chanSelected.kind.startsWith('new')) chanAuto.touch(delay);
  };

  const bySequence = (a, b) => a.position - b.position;
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const isGroupSel = (sel) => sel.kind === 'group' || sel.kind === 'new-group';

  function renderChannelList() {
    const { list, groups } = channels();
    const grouped = (id) => list.filter((c) => c.groupId === id).sort(bySequence);
    const top = [
      ...list.filter((c) => c.groupId == null).map((c) => ({ kind: 'channel', c, position: c.position })),
      ...groups.map((g) => ({ kind: 'group', g, position: g.position })),
    ].sort(bySequence);

    const label = (text, kind) => {
      const span = document.createElement('span');
      span.className = 'admin-item-name';
      span.textContent = text;
      if (kind) span.dataset.kind = kind;
      return span;
    };
    const lock = (on) => {
      if (!on) return null;
      const icon = document.createElement('span');
      icon.dataset.icon = 'lock-simple';
      icon.className = 'admin-lock';
      icon.title = t('server_admin.has_password');
      return icon;
    };
    const restricted = (rolesList, peopleList) => {
      if (!rolesList?.length && !peopleList?.length) return null;
      const wrap = document.createElement('span');
      wrap.className = 'role-chips';
      for (const role of sortRoles(roles()).filter((r) => (rolesList ?? []).includes(r.id))) {
        const chip = document.createElement('span');
        chip.className = 'role-chip';
        chip.append(dot(role.color), role.name);
        wrap.append(chip);
      }
      if (peopleList?.length) {
        const chip = document.createElement('span');
        chip.className = 'role-chip';
        chip.textContent = t('server_admin.chan_people_count', { count: peopleList.length });
        wrap.append(chip);
      }
      return wrap;
    };
    const channelItem = (c, nested) => {
      const li = item(chanSelected?.kind === 'channel' && chanSelected.id === c.id,
        (() => {
          const icon = document.createElement('span');
          icon.dataset.icon = { voice: 'speaker-high', forum: 'chats-teardrop' }[c.kind] ?? 'hash';
          icon.className = 'admin-kind';
          return icon;
        })(),
        label(c.name), lock(c.locked), restricted(c.roles, c.users));
      li.dataset.channelId = String(c.id);
      if (nested) li.dataset.nested = '';
      li.addEventListener('click', () => selectChannel({ kind: 'channel', id: c.id }));
      return li;
    };

    const nodes = [];
    for (const entry of top) {
      if (entry.kind === 'channel') {
        nodes.push(channelItem(entry.c, false));
        continue;
      }
      const g = entry.g;
      const li = item(chanSelected?.kind === 'group' && chanSelected.id === g.id,
        label(g.name, 'group'), lock(g.locked), restricted(g.roles, g.users));
      li.dataset.groupId = String(g.id);
      li.dataset.group = '';
      li.addEventListener('click', () => selectChannel({ kind: 'group', id: g.id }));
      nodes.push(li, ...grouped(g.id).map((c) => channelItem(c, true)));
    }
    ch.list.replaceChildren(...nodes.filter(Boolean));

    const actor = ctx();
    ch.newText.hidden = !actor.can('channels.create');
    ch.newVoice.hidden = !actor.can('channels.create');
    ch.newForum.hidden = !actor.can('channels.create');
    ch.newGroup.hidden = !actor.can('channels.create');
  }

  async function selectChannel(selection) {
    // What was changed on the one being left is sent first: it is read from what this replaces.
    await chanAuto.flush();
    chanSelected = selection;
    const subject = currentSubject();
    chanRoles = [...(subject?.roles ?? [])];
    chanUsers = [...(subject?.users ?? [])];
    chanName = null;
    chanPassword = '';
    chanPasswordReady = false;
    ch.status.textContent = '';
    show(ch.error, '');
    renderChannels();
  }

  /** The channel or group being edited, or null for a new one. */
  function currentSubject() {
    if (!chanSelected) return null;
    const { list, groups } = channels();
    if (chanSelected.kind === 'channel') return list.find((c) => c.id === chanSelected.id) ?? null;
    if (chanSelected.kind === 'group') return groups.find((g) => g.id === chanSelected.id) ?? null;
    return null;
  }

  /** What the editor was last drawn against besides the channel's own fields: who and what it lists, and the door. */
  let chanListed = '';

  /**
   * @param {{force?: boolean}} [options]  force: the editor's own controls changed what it shows, so it is drawn
   *   whatever the server says
   *
   * The server saying what the editor already holds -- the echo of its own change -- draws nothing again: a switch that
   * has just been moved is not taken out from under the keyboard that moved it.
   */
  function renderChannelEditor({ force = false } = {}) {
    const actor = ctx();
    const sel = chanSelected;
    const isNew = sel?.kind?.startsWith('new');
    const subject = currentSubject();
    if (!sel || (!isNew && !subject)) {
      ch.editor.hidden = true;
      return;
    }
    const listed = JSON.stringify([
      sel.kind, sel.id ?? null, sortRoles(roles()).map((r) => [r.id, r.name, r.color]), [...users().values()].map((u) => [u.id, u.nickname]),
      channels().groups.map((g) => [g.id, g.name]), subject?.locked ?? null, subject?.groupId ?? null,
    ]);
    if (!force && !isNew && !ch.editor.hidden && listed === chanListed
      && sameSet(chanRoles, subject.roles ?? []) && sameSet(chanUsers, subject.users ?? [])) {
      // Only what is not in a box to be typed into: the title, which a rename changes.
      ch.subject.textContent = isGroupSel(sel) ? t('server_admin.group_label', { name: subject.name }) : subject.name;
      return;
    }
    chanListed = listed;
    ch.editor.hidden = false;
    const isGroup = sel.kind === 'group' || sel.kind === 'new-group';
    const canEdit = actor.can('channels.edit');
    const canPassword = actor.can('channels.password');
    const parent = !isNew && sel.kind === 'channel' && subject.groupId != null
      ? channels().groups.find((g) => g.id === subject.groupId) : null;

    ch.subject.textContent = isNew
      ? t(`server_admin.${sel.kind.replace('-', '_')}_title`)
      : (isGroup ? t('server_admin.group_label', { name: subject.name }) : subject.name);

    ch.name.value = chanName ?? (isNew ? '' : subject.name);
    ch.name.disabled = !isNew && !canEdit;
    ch.name.dataset.touched = '';

    // Which group a channel is in. A new one starts outside every group.
    const showGroup = !isGroup && !isNew;
    ch.groupField.hidden = !showGroup;
    if (showGroup) {
      ch.group.replaceChildren(
        new Option(t('server_admin.no_group'), ''),
        ...channels().groups.map((g) => new Option(g.name, String(g.id))),
      );
      ch.group.value = subject.groupId == null ? '' : String(subject.groupId);
      ch.group.disabled = !canEdit;
    }

    // A channel in a group has no password or roles of its own.
    ch.follows.hidden = !parent;
    if (parent) show(ch.follows, t('server_admin.follows_group', { name: parent.name }));
    const own = !parent;

    ch.passwordField.hidden = !own || !(isNew || canPassword);
    // Taking a password off only makes sense when there is one.
    ch.passwordOffField.hidden = ch.passwordField.hidden || isNew || !subject.locked;
    ch.password.value = chanPassword;
    ch.password.disabled = !canPassword;
    ch.passwordOff.checked = false;
    ch.passwordOff.disabled = !canPassword;
    ch.passwordNote.textContent = isNew ? '' : (subject.locked
      ? t('server_admin.has_password') : t('server_admin.no_password'));

    ch.rolesField.hidden = !own;
    ch.roles.replaceChildren(...sortRoles(roles()).map((role) => checkRow({
      label: role.name,
      color: role.color,
      checked: chanRoles.includes(role.id),
      disabled: !canEdit,
      onChange: (on) => {
        chanRoles = chanRoles.filter((id) => id !== role.id);
        if (on) chanRoles.push(role.id);
        touchChannel(150);
      },
    })));

    // People named on it, with a picker for the rest.
    ch.usersField.hidden = !own;
    const everybody = [...users().values()];
    ch.users.replaceChildren(...chanUsers.map((id) => {
      const person = users().get(id);
      const chip = document.createElement('span');
      chip.className = 'role-chip chan-person';
      chip.textContent = person ? displayOf(person.id, person.nickname) : String(id);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'profile-card-chip-x';
      x.dataset.icon = 'x';
      x.title = t('server_admin.chan_users_remove');
      x.setAttribute('aria-label', x.title);
      x.disabled = !canEdit;
      x.addEventListener('click', () => {
        chanUsers = chanUsers.filter((u) => u !== id);
        renderChannelEditor({ force: true });
        touchChannel(150);
      });
      chip.append(x);
      return chip;
    }));
    ch.userAdd.replaceChildren(
      new Option(t('server_admin.chan_users_add'), ''),
      ...everybody
        .filter((u) => !chanUsers.includes(u.id))
        .sort((a, b) => displayOf(a.id, a.nickname).localeCompare(displayOf(b.id, b.nickname)))
        .map((u) => new Option(displayOf(u.id, u.nickname), String(u.id))),
    );
    ch.userAdd.disabled = !canEdit;
    if (isGroup && !isNew) show(ch.follows, t('server_admin.group_applies'));

    // Create only for one that is not made yet; one that is made is saved as it is changed.
    ch.save.hidden = !isNew;
    ch.save.disabled = isNew ? !actor.can('channels.create') : false;
    ch.remove.hidden = isNew;
    ch.remove.disabled = !actor.can('channels.delete');
    if (isNew) {
      ch.status.textContent = '';
      show(ch.error, '');
    }
  }

  function renderChannels() {
    renderChannelList();
    renderChannelEditor();
  }

  ch.name.addEventListener('input', () => {
    chanName = ch.name.value;
    touchChannel(700);
  });
  ch.password.addEventListener('input', () => {
    chanPassword = ch.password.value;
    chanPasswordReady = false;
  });
  // A password is sent when the box is let go of (or Enter is pressed in it): that is what `change` is.
  ch.password.addEventListener('change', () => {
    if (!ch.password.value) return;
    chanPasswordReady = true;
    touchChannel(0);
  });
  ch.passwordOff.addEventListener('change', () => {
    if (ch.passwordOff.checked) touchChannel(0);
  });
  ch.group.addEventListener('change', () => touchChannel(0));
  ch.userAdd.addEventListener('change', () => {
    const id = Number(ch.userAdd.value);
    if (id && !chanUsers.includes(id)) chanUsers.push(id);
    renderChannelEditor({ force: true });
    touchChannel(150);
  });

  ch.newText.addEventListener('click', () => selectChannel({ kind: 'new-text' }));
  ch.newVoice.addEventListener('click', () => selectChannel({ kind: 'new-voice' }));
  ch.newForum.addEventListener('click', () => selectChannel({ kind: 'new-forum' }));
  ch.newGroup.addEventListener('click', () => selectChannel({ kind: 'new-group' }));


  /** Sends the channel or group on show, as it is now: what `touch` was for. */
  async function saveChannel() {
    const sel = chanSelected;
    if (!sel || sel.kind.startsWith('new')) return false;
    const subject = currentSubject();
    if (!subject) return false;
    const name = ch.name.value.trim();
    const typed = chanPasswordReady ? ch.password.value : '';
    const removePassword = ch.passwordOff.checked;
    const isGroup = sel.kind === 'group';
    const wantsGroup = ch.group.value === '' ? null : Number(ch.group.value);
    const was = subject.groupId ?? null;
    const joining = !isGroup && wantsGroup !== null && wantsGroup !== was;
    const leaving = !isGroup && wantsGroup === null && was !== null;

    // Leaving a group first: until it has, the channel follows the group
    // and the server refuses a password or roles of its own.
    if (leaving) await deps.moveToGroup(subject.id, null);

    const following = !isGroup && was !== null && !leaving;
    const body = {};
    // An empty name is not a name: the box is left to be typed into, and nothing is sent for it.
    if (name && name !== subject.name) body.name = name;
    // A channel in a group, or about to be, takes neither: they are the group's.
    if (!joining && !following) {
      if (removePassword) body.password = '';
      else if (typed) body.password = typed;
      if (!sameSet(chanRoles, subject.roles ?? [])) body.roles = chanRoles;
      if (!sameSet(chanUsers, subject.users ?? [])) body.users = chanUsers;
    }
    if (Object.keys(body).length) {
      if (isGroup) await harmony.api.updateGroup(server(), subject.id, body);
      else await harmony.api.updateChannel(server(), subject.id, body);
    }
    if (joining) await deps.moveToGroup(subject.id, wantsGroup);
    const sent = Object.keys(body).length > 0 || joining || leaving;
    // What has been sent is no longer waiting in the boxes. A name typed since is kept.
    if (chanName === name) chanName = null;
    if ('password' in body) {
      chanPassword = '';
      chanPasswordReady = false;
      ch.password.value = '';
      ch.passwordOff.checked = false;
    }
    renderChannels();
    return sent;
  }

  // Making a channel or a group: it waits for a button, because everybody is told of it. Once it is made, it is live.
  ch.save.addEventListener('click', async () => {
    show(ch.error, '');
    const sel = chanSelected;
    if (!sel || !sel.kind.startsWith('new')) return;
    const actor = ctx();
    const name = ch.name.value.trim();
    const typed = ch.password.value;
    try {
      const body = { name };
      if (typed && actor.can('channels.password')) body.password = typed;
      if (chanRoles.length) body.roles = chanRoles;
      if (chanUsers.length) body.users = chanUsers;
      let created;
      if (sel.kind === 'new-group') {
        created = (await harmony.api.createGroup(server(), name, body)).group;
        chanSelected = { kind: 'group', id: created.id };
      } else {
        body.kind = { 'new-voice': 'voice', 'new-forum': 'forum' }[sel.kind] ?? 'text';
        created = (await harmony.api.createChannel(server(), body)).channel;
        chanSelected = { kind: 'channel', id: created.id };
      }
      chanRoles = [...(created.roles ?? [])];
      chanUsers = [...(created.users ?? [])];
      chanName = null;
      chanPassword = '';
      chanPasswordReady = false;
      renderChannels();
    } catch (err) {
      show(ch.error, err.message);
    }
  });

  ch.remove.addEventListener('click', async () => {
    const subject = currentSubject();
    if (!subject) return;
    const isGroup = chanSelected.kind === 'group';
    // What was being changed on it is of no use now.
    chanAuto.cancel();
    if (!await deps.confirm(t(isGroup ? 'server_admin.delete_group_title' : 'server_admin.delete_channel_title', { name: subject.name }), {
      text: t(isGroup ? 'server_admin.delete_group_text' : 'server_admin.delete_channel_text'),
      okLabel: t('server_admin.delete'),
    })) return;
    try {
      if (isGroup) await harmony.api.deleteGroup(server(), subject.id);
      else await harmony.api.deleteChannel(server(), subject.id);
      chanSelected = null;
      renderChannels();
    } catch (err) {
      show(ch.error, err.message);
    }
  });

  // =========================================================================================
  // Badges
  // =========================================================================================

  const bd = {
    list: $('badges-list'),
    add: $('badges-new'),
    editor: $('badges-editor'),
    preview: $('badge-preview'),
    name: $('badge-name'),
    description: $('badge-description'),
    emoji: $('badge-emoji'),
    pick: $('badge-image-pick'),
    removeImage: $('badge-image-remove'),
    error: $('badge-error'),
    status: $('server-status'),
    save: $('badge-save'),
    remove: $('badge-delete'),
  };
  /** The badge being edited: its id, or 'new'. */
  let badgeSelected = null;
  /** What the editor holds; the image is a hash already uploaded, with a preview to show. */
  let badgeDraft = null;
  const badgeAuto = autosave(saveBadge, statusLine(bd.status, bd.error));
  /** The badge on show changed: it is sent in `delay` ms. Not a new one, which waits for Create. */
  const touchBadge = (delay) => {
    if (badgeDraft && badgeSelected !== 'new' && badgeSelected !== null) badgeAuto.touch(delay);
  };

  function renderBadgeList() {
    const actor = ctx();
    bd.list.replaceChildren(...badges().map((badge) => {
      const name = document.createElement('span');
      name.className = 'admin-item-name';
      name.textContent = badge.name;
      const li = item(badgeSelected === badge.id, badgeEl(badge, 'small'), name);
      li.dataset.badgeId = String(badge.id);
      li.addEventListener('click', () => selectBadge(badge.id));
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectBadge(badge.id);
        }
      });
      return li;
    }));
    bd.add.hidden = !actor.can('badges.create');
  }

  async function selectBadge(id) {
    // What was changed on the one being left is sent first: it is read from the draft this replaces.
    await badgeAuto.flush();
    badgeSelected = id;
    badgeDraft = null;
    bd.status.textContent = '';
    show(bd.error, '');
    renderBadges();
  }

  /** The big preview: exactly what the card will show. */
  function paintBadgePreview() {
    const d = badgeDraft;
    bd.preview.replaceChildren(badgeEl({
      name: d.name, emoji: d.emoji || null, imageHash: d.imageHash, previewUrl: d.previewUrl,
    }, 'large'));
  }

  function renderBadgeEditor() {
    const actor = ctx();
    const isNew = badgeSelected === 'new';
    const badge = isNew ? null : badges().find((b) => b.id === badgeSelected) ?? null;
    if (!isNew && !badge) {
      bd.editor.hidden = true;
      return;
    }
    bd.editor.hidden = false;
    badgeDraft ??= {
      name: badge?.name ?? '',
      description: badge?.description ?? '',
      emoji: badge?.emoji ?? '',
      imageHash: badge?.imageHash ?? null,
      previewUrl: null,
    };
    const d = badgeDraft;
    const editable = isNew ? actor.can('badges.create') : actor.can('badges.edit');
    bd.name.value = d.name;
    bd.description.value = d.description;
    bd.emoji.value = d.emoji;
    for (const input of [bd.name, bd.description, bd.emoji, bd.pick, bd.removeImage]) input.disabled = !editable;
    bd.removeImage.disabled = !editable || !d.imageHash;
    // Create only for a badge that is not made yet; one that is made is saved as it is changed.
    bd.save.hidden = !isNew;
    bd.save.disabled = !editable;
    bd.remove.hidden = isNew;
    bd.remove.disabled = !actor.can('badges.edit');
    paintBadgePreview();
    if (isNew) {
      bd.status.textContent = '';
      show(bd.error, '');
    }
  }

  function renderBadges() {
    renderBadgeList();
    renderBadgeEditor();
  }

  bd.add.addEventListener('click', () => selectBadge('new'));
  bd.name.addEventListener('input', () => {
    if (!badgeDraft) return;
    badgeDraft.name = bd.name.value;
    touchBadge(600);
  });
  bd.description.addEventListener('input', () => {
    if (!badgeDraft) return;
    badgeDraft.description = bd.description.value;
    touchBadge(600);
  });
  bd.emoji.addEventListener('input', () => {
    if (!badgeDraft) return;
    badgeDraft.emoji = bd.emoji.value;
    paintBadgePreview();
    touchBadge(600);
  });
  bd.pick.addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/webp,image/gif';
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file || !badgeDraft) return;
      show(bd.error, '');
      bd.pick.disabled = true;
      try {
        const { hash, preview } = await deps.uploadBadgeImage(file);
        badgeDraft.imageHash = hash;
        badgeDraft.previewUrl = preview;
        renderBadgeEditor();
        touchBadge(0);
      } catch (err) {
        show(bd.error, err.message);
      } finally {
        bd.pick.disabled = false;
      }
    });
    picker.click();
  });
  bd.removeImage.addEventListener('click', () => {
    if (!badgeDraft) return;
    badgeDraft.imageHash = null;
    badgeDraft.previewUrl = null;
    renderBadgeEditor();
    touchBadge(0);
  });

  /** What the badge editor holds, as the request that makes or changes a badge. */
  const badgeBody = (d) => ({
    name: d.name,
    description: d.description,
    emoji: d.emoji,
    imageHash: d.imageHash,
  });

  /** Sends the badge on show, as it is now: what `touch` was for. */
  async function saveBadge() {
    const d = badgeDraft;
    const id = badgeSelected;
    if (!d || id === 'new' || id === null) return false;
    // No name yet (it is being retyped): nothing to send, and nothing to complain about meanwhile.
    if (!d.name.trim()) return false;
    await harmony.api.updateBadge(server(), id, badgeBody(d));
    return true;
  }

  // Making a badge waits for a button, because everybody is told of it. Once it is made, it is live.
  bd.save.addEventListener('click', async () => {
    show(bd.error, '');
    const d = badgeDraft;
    if (!d || badgeSelected !== 'new') return;
    try {
      const { badge } = await harmony.api.createBadge(server(), badgeBody(d));
      badgeSelected = badge.id;
      badgeDraft = null;
      renderBadges();
    } catch (err) {
      show(bd.error, err.message);
    }
  });

  bd.remove.addEventListener('click', async () => {
    const badge = badges().find((b) => b.id === badgeSelected);
    if (!badge) return;
    // What was being changed on it is of no use now.
    badgeAuto.cancel();
    if (!await deps.confirm(t('server_admin.delete_badge_title', { name: badge.name }), {
      text: t('server_admin.delete_badge_text'),
      okLabel: t('server_admin.delete'),
    })) return;
    try {
      await harmony.api.deleteBadge(server(), badge.id);
      badgeSelected = null;
      badgeDraft = null;
      renderBadges();
    } catch (err) {
      show(bd.error, err.message);
    }
  });

  // =========================================================================================

  /**
   * Draw everything that is showing. Cheap enough to call on every push:
   * the editors keep their drafts, and a page nobody is on is not drawn.
   */
  function render(page) {
    if (!page || page === 'roles') renderRoles();
    if (!page || page === 'members') renderMembers();
    if (!page || page === 'channels') renderChannels();
    if (!page || page === 'badges') renderBadges();
  }

  return {
    render,
    /** Open on a channel or group, as the sidebar's "Edit" asks. */
    async focusChannel(selection) {
      await chanAuto.flush();
      chanSelected = selection;
      chanRoles = [...(currentSubject()?.roles ?? [])];
      chanUsers = [...(currentSubject()?.users ?? [])];
      chanName = null;
      chanPassword = '';
      chanPasswordReady = false;
      ch.status.textContent = '';
      renderChannels();
    },
    focusMember(id) {
      memberSelected = id;
      renderMembers();
    },
    reload: reloadRoles,
    /** Everything that has been changed and not yet sent, sent: to be awaited before the dialog goes. */
    flush: () => Promise.all([roleAuto.flush(), chanAuto.flush(), badgeAuto.flush()]),
    get pending() { return roleAuto.pending || chanAuto.pending || badgeAuto.pending; },
  };
}
