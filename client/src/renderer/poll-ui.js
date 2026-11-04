// A poll, on the screen: the dialog it is made in, the card it is shown as in a channel or a conversation, and the
// list of who voted for what. What a poll is, and how a private one is counted, is poll.js.
//
// The card is told what to show and what to do about a click, and knows nothing else: a channel's poll gets its
// votes from the server and a private one's from its reactions, and both hand it the same shape (see
// resultsFromReactions). It draws itself again at the moment the poll closes, so a poll left on the screen
// stops taking votes when it should, without anybody scrolling.

import {
  POLL_LIMITS, cleanPoll, isClosed, afterClick, timeLeft,
} from './poll.js';

/** The longest a timer may be set for: a poll that closes in a year is checked again when it is looked at. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How many faces are stacked beside an option. */
const FACES = 3;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A moment as a <input type="datetime-local"> wants it: the local clock, to the minute. */
function localInput(ms) {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * @param {object} deps
 * @param {(key: string, vars?: object) => string} deps.t
 * @param {(userId: number) => object} deps.faceOf  what avatarEl draws a person from
 * @param {(face: object, className?: string) => HTMLElement} deps.avatarEl
 * @param {(userId: number, fallback?: string) => string} deps.displayOf
 */
export function createPollUi({
  t, faceOf, avatarEl, displayOf,
}) {
  const plural = (key, count) => t(key, { count });

  /** "Select one or more", "Anonymous poll", "Final results": the line under the title. */
  function subtitle(poll, closed) {
    const parts = [];
    if (closed) parts.push(t('poll.final'));
    else parts.push(poll.multiple ? t('poll.select_many') : t('poll.select_one'));
    if (poll.anonymous) parts.unshift(t('poll.anonymous'));
    return parts.join(' · ');
  }

  /** The end, as words: how long is left, or that it is over. */
  function endText(poll, now = Date.now()) {
    if (poll.endsAt === null || poll.endsAt === undefined) return '';
    const left = timeLeft(poll.endsAt, now);
    if (!left) return t('poll.closed');
    return plural(`poll.left_${left[1]}`, left[0]);
  }

  /**
   * The poll as a card.
   *
   * @param {object} opts
   * @param {object} opts.poll
   * @param {() => {counts: number[], total: number, voters: number[][]|null, mine: number[]}} opts.results
   *   asked again at every drawing, so the card is always as current as what it was given
   * @param {string|null} [opts.imageUrl]
   * @param {(options: number[]) => Promise<void>|void} opts.onVote  everything chosen, after the click
   * @param {() => void} [opts.onImage]  the picture was clicked
   */
  function card({
    poll, results, imageUrl = null, onVote, onImage,
  }) {
    const root = el('div', 'poll-card');
    root.dataset.testid = 'poll-card';
    let timer = null;
    let busy = false;
    let cover = imageUrl;

    function paint() {
      clearTimeout(timer);
      const closed = isClosed(poll);
      const r = results();
      const max = Math.max(1, r.total);
      root.toggleAttribute('data-closed', closed);
      root.toggleAttribute('aria-busy', busy);

      const title = el('div', 'poll-title', poll.title);
      const sub = el('div', 'poll-sub', subtitle(poll, closed));
      const parts = [title, sub];
      if (poll.description) parts.push(el('div', 'poll-desc', poll.description));
      if (cover) {
        const img = el('img', 'poll-cover');
        img.src = cover;
        img.alt = '';
        img.loading = 'lazy';
        if (onImage) img.addEventListener('click', onImage);
        parts.push(img);
      }

      const list = el('ul', 'poll-options');
      poll.options.forEach((text, option) => {
        const chosen = r.mine.includes(option);
        const count = r.counts[option] ?? 0;
        const li = el('li', 'poll-option');
        li.toggleAttribute('data-mine', chosen);

        const choice = el('button', 'poll-choice');
        choice.type = 'button';
        choice.setAttribute('role', poll.multiple ? 'checkbox' : 'radio');
        choice.setAttribute('aria-checked', String(chosen));
        choice.disabled = closed || busy;
        const check = el('span', 'poll-check');
        check.dataset.kind = poll.multiple ? 'box' : 'dot';
        check.toggleAttribute('data-on', chosen);
        const label = el('span', 'poll-text', text);
        choice.append(check, label);
        choice.addEventListener('click', async () => {
          if (busy || isClosed(poll)) return;
          busy = true;
          paint();
          try {
            await onVote(afterClick(poll, results().mine, option));
          } finally {
            busy = false;
            paint();
          }
        });

        const side = el('span', 'poll-side');
        const who = r.voters?.[option] ?? [];
        if (who.length) {
          const faces = el('span', 'poll-faces');
          for (const id of who.slice(-FACES)) faces.append(avatarEl(faceOf(id), 'tiny'));
          side.append(faces);
        }
        const number = el('span', 'poll-count', String(count));
        number.title = plural('poll.votes', count);
        side.append(number);

        const bar = el('div', 'poll-bar');
        const fill = el('div', 'poll-fill');
        fill.style.width = `${Math.round((count / max) * 100)}%`;
        bar.append(fill);
        li.append(choice, side, bar);
        list.append(li);
      });
      parts.push(list);

      if (poll.footer) parts.push(el('div', 'poll-footer', poll.footer));

      const meta = el('div', 'poll-meta');
      meta.append(el('span', 'poll-total', plural('poll.votes', r.total)));
      const ends = endText(poll);
      if (ends) meta.append(el('span', 'poll-ends', ends));
      parts.push(meta);

      const view = el('button', 'poll-view', t('poll.view_votes'));
      view.type = 'button';
      view.addEventListener('click', () => showVotes(poll, results()));
      parts.push(view);

      root.replaceChildren(...parts);

      // At the moment it closes, drawn again; a poll further off than a timer can count is drawn when looked at.
      if (!closed && poll.endsAt) {
        const wait = poll.endsAt - Date.now();
        if (wait > 0 && wait <= MAX_TIMER_MS) {
          timer = setTimeout(() => { if (root.isConnected) paint(); }, wait + 50);
        }
      }
    }

    paint();
    // A picture that has to be fetched and opened first (a private conversation's) is put in when it is ready.
    root.setCover = (url) => { cover = url; paint(); };
    return root;
  }

  // ---------------------------------------------------------------- who voted

  /** Everybody who voted, under what they chose. A poll that hides its voters shows the counts and says so. */
  function showVotes(poll, results) {
    const dialog = el('dialog', 'ask poll-votes');
    dialog.dataset.testid = 'poll-votes';
    dialog.append(el('h2', '', poll.title));
    dialog.append(el('p', 'muted', plural('poll.votes', results.total)));
    if (poll.anonymous) dialog.append(el('p', 'poll-hidden', t('poll.voters_hidden')));

    const groups = el('div', 'poll-voters');
    poll.options.forEach((text, option) => {
      const group = el('section', 'poll-voter-group');
      const head = el('header', 'poll-voter-head');
      head.append(el('span', 'poll-voter-option', text), el('span', 'poll-count', String(results.counts[option] ?? 0)));
      group.append(head);
      const who = results.voters?.[option];
      if (who?.length) {
        const list = el('ul', 'poll-voter-list');
        for (const id of who) {
          const li = el('li', 'poll-voter');
          li.append(avatarEl(faceOf(id), 'tiny'), el('span', '', displayOf(id, t('poll.someone'))));
          list.append(li);
        }
        group.append(list);
      } else if (!poll.anonymous) {
        group.append(el('p', 'muted poll-nobody', t('poll.nobody')));
      }
      groups.append(group);
    });
    dialog.append(groups);

    const buttons = el('div', 'ask-buttons');
    const close = el('button', 'ghost', t('poll.close'));
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    buttons.append(close);
    dialog.append(buttons);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // -------------------------------------------------------------- making one

  /**
   * The dialog a poll is made in. Resolves with what to send, or null when it was left.
   *
   * @param {{inPrivate?: boolean}} [opts]  true in a private conversation, where hiding the voters is a
   *   courtesy of the app and not something nobody can get around (the note under the switch says so)
   * @returns {Promise<{poll: object, image: File|null}|null>}
   */
  function compose({ inPrivate = false } = {}) {
    return new Promise((resolve) => {
      const dialog = el('dialog', 'ask poll-dialog');
      dialog.dataset.testid = 'poll-dialog';
      let result = null;
      let image = null;
      let imageUrl = null;

      const field = (label, input) => {
        const wrap = el('label', 'field');
        wrap.append(el('span', '', label), input);
        return wrap;
      };
      const input = (placeholder, max, testid) => {
        const i = el('input');
        i.type = 'text';
        i.placeholder = placeholder;
        i.maxLength = max;
        i.autocomplete = 'off';
        if (testid) i.dataset.testid = testid;
        return i;
      };

      const title = input(t('poll.question_placeholder'), POLL_LIMITS.title, 'poll-title');
      const description = el('textarea');
      description.placeholder = t('poll.description_placeholder');
      description.maxLength = POLL_LIMITS.description;
      description.rows = 2;
      description.dataset.testid = 'poll-description';
      const footer = input(t('poll.footer_placeholder'), POLL_LIMITS.footer, 'poll-footer');

      // The picture, if there is one.
      const picture = el('div', 'poll-picture');
      const pickPicture = el('button', 'ghost small', t('poll.add_picture'));
      pickPicture.type = 'button';
      const file = el('input');
      file.type = 'file';
      file.accept = 'image/*';
      file.hidden = true;
      const preview = el('img', 'poll-picture-preview');
      preview.alt = '';
      preview.hidden = true;
      const dropPicture = el('button', 'ghost small', t('poll.remove_picture'));
      dropPicture.type = 'button';
      dropPicture.hidden = true;
      const setImage = (next) => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        image = next;
        imageUrl = next ? URL.createObjectURL(next) : null;
        preview.hidden = !next;
        dropPicture.hidden = !next;
        pickPicture.hidden = Boolean(next);
        if (next) preview.src = imageUrl;
        else preview.removeAttribute('src');
      };
      pickPicture.addEventListener('click', () => file.click());
      dropPicture.addEventListener('click', () => setImage(null));
      file.addEventListener('change', () => {
        const chosen = file.files?.[0];
        file.value = '';
        if (chosen?.type.startsWith('image/')) setImage(chosen);
      });
      picture.append(pickPicture, preview, dropPicture, file);

      // The options. Writing in the last one makes another, so there is always an empty one to write in.
      const options = el('div', 'poll-option-list');
      const counter = el('span', 'poll-option-count');
      const rows = [];
      function refresh() {
        const filled = rows.filter((r) => r.input.value.trim()).length;
        counter.textContent = `${rows.length}/${POLL_LIMITS.maxOptions}`;
        // Kept in the row and only not shown, so that the options all have one width.
        rows.forEach((r, i) => {
          const off = !(rows.length > POLL_LIMITS.minOptions && i < rows.length - 1);
          r.drop.toggleAttribute('data-off', off);
          r.drop.tabIndex = off ? -1 : 0;
        });
        return filled;
      }
      function addOption(focus = false) {
        if (rows.length >= POLL_LIMITS.maxOptions) return;
        const row = el('div', 'poll-option-row');
        const text = input(t('poll.option_placeholder'), POLL_LIMITS.option, 'poll-option');
        const drop = el('button', 'composer-btn poll-option-drop', t('poll.remove_option'));
        drop.type = 'button';
        drop.dataset.icon = 'x';
        drop.title = t('poll.remove_option');
        const entry = { row, input: text, drop };
        text.addEventListener('input', () => {
          if (rows[rows.length - 1] === entry && text.value.trim()) addOption();
          refresh();
          validate();
        });
        text.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          rows[rows.indexOf(entry) + 1]?.input.focus();
        });
        drop.addEventListener('click', () => {
          rows.splice(rows.indexOf(entry), 1);
          row.remove();
          refresh();
          validate();
        });
        row.append(text, drop);
        rows.push(entry);
        options.append(row);
        refresh();
        if (focus) text.focus();
      }
      addOption();
      addOption();

      // The switches.
      const toggle = (label, hint, testid) => {
        const wrap = el('label', 'check');
        const box = el('input', 'switch');
        box.type = 'checkbox';
        box.setAttribute('role', 'switch');
        box.dataset.testid = testid;
        const words = el('span');
        words.append(el('span', '', label));
        if (hint) words.append(el('small', '', hint));
        wrap.append(box, words);
        return { wrap, box };
      };
      const multiple = toggle(t('poll.multiple'), '', 'poll-multiple');
      const anonymous = toggle(t('poll.anonymous_switch'), inPrivate ? t('poll.anonymous_private_hint') : '', 'poll-anonymous');
      const timed = toggle(t('poll.set_end'), '', 'poll-timed');
      const endsAt = el('input');
      endsAt.type = 'datetime-local';
      endsAt.dataset.testid = 'poll-ends';
      endsAt.hidden = true;
      timed.box.addEventListener('change', () => {
        endsAt.hidden = !timed.box.checked;
        if (timed.box.checked && !endsAt.value) endsAt.value = localInput(Date.now() + 24 * 60 * 60 * 1000);
        endsAt.min = localInput(Date.now());
        validate();
      });
      endsAt.addEventListener('input', validate);

      const send = el('button', 'primary', t('poll.send'));
      send.type = 'button';
      send.dataset.testid = 'poll-send';
      const cancel = el('button', 'ghost', t('poll.cancel'));
      cancel.type = 'button';
      const problem = el('p', 'poll-problem');
      problem.setAttribute('aria-live', 'polite');

      /** What the form says, as cleanPoll takes it; null with a message for a time that is not in the future. */
      function read() {
        let end = null;
        if (timed.box.checked) {
          end = new Date(endsAt.value).getTime();
          if (!Number.isFinite(end)) end = NaN;
        }
        return cleanPoll({
          title: title.value,
          description: description.value,
          footer: footer.value,
          options: rows.map((r) => r.input.value),
          multiple: multiple.box.checked,
          anonymous: anonymous.box.checked,
          endsAt: end,
        });
      }
      function validate() {
        const r = read();
        send.disabled = !r.ok;
        // Only what is worth telling while somebody is still filling it in: the end that has already passed.
        problem.textContent = !r.ok && r.error === 'poll_bad_end' ? t('poll.bad_end') : '';
        return r;
      }
      title.addEventListener('input', validate);

      send.addEventListener('click', () => {
        const r = validate();
        if (!r.ok) return;
        result = { poll: r.poll, image };
        dialog.close();
      });
      cancel.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        dialog.remove();
        resolve(result);
      });

      const buttons = el('div', 'ask-buttons');
      buttons.append(cancel, send);
      const optionsHead = el('div', 'poll-section');
      optionsHead.append(el('h3', '', t('poll.options')), counter);
      dialog.append(
        el('h2', '', t('poll.create')),
        field(t('poll.question'), title),
        field(t('poll.description'), description),
        picture,
        optionsHead,
        options,
        field(t('poll.footer'), footer),
        multiple.wrap,
        anonymous.wrap,
        timed.wrap,
        endsAt,
        problem,
        buttons,
      );
      document.body.append(dialog);
      validate();
      dialog.showModal();
      title.focus();
    });
  }

  return { card, compose, showVotes };
}
