// Music Buddy's screen: the strip in the call panel that everybody in the channel has, and the panel behind it where
// people who may play music add songs and control them.
//
// It is nothing of the soundpad's. The soundpad is a grid of clips that fire once; this is a queue of tracks that
// play one after another, with a position, shuffle and repeat. It has its own button, its own panel and its own
// volume, and shares no markup with them.
//
// What is drawn is always a snapshot (music-player.js `view()`): the track, the queue, where it has got to. Nothing
// here changes it. A press sends a request over the socket, the server changes the state and tells everybody, and
// the snapshot that comes back is what is drawn -- so every screen in the channel shows the same thing, including
// the one that pressed.

const $ = (id) => document.getElementById(id);

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 3:07, or 1:02:03. */
export function clockText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** What the repeat button goes to next: off, then the whole queue, then the one track. */
const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' };

/** The phone layout's own test, the one the stylesheet's phone rules use. */
const PHONE = '(max-width: 720px), (pointer: coarse) and (max-height: 500px)';

/**
 * @param {object} config
 * @param {(key: string, params?: object) => string} config.t
 * @param {(hash: string) => string} config.mediaUrl
 * @param {(input: string) => Promise<{kind: string, playlist: string|null, items: object[]}>} config.resolve
 * @param {(type: string, payload: object) => Promise<object>} config.send  a request over the call's socket
 * @param {() => boolean} config.canControl  whether this person holds the permission, and the owner has it on
 * @param {() => object|null} config.view  the player's snapshot
 * @param {() => number} config.position  where the music ought to be, in ms, now
 * @param {() => number|null} config.channelId  the voice channel, or null outside a call
 * @param {(open: boolean) => void} [config.onOpen]
 */
export function createMusicUi(config) {
  const {
    t, mediaUrl, resolve, send, canControl, view, position, channelId,
  } = config;

  const strip = $('music-strip');
  const pop = $('music-pop');
  const button = $('voice-music');
  const note = $('music-note');
  const results = $('music-results');
  const queue = $('music-queue');
  const seek = $('music-seek');

  let resultsFor = null;
  let seeking = false;

  // ------------------------------------------------------------------------------------------------------ helpers

  /** A track's picture, or nothing: the file is the server's own copy of what YouTube showed. */
  function cover(node, hash) {
    node.replaceChildren();
    node.toggleAttribute('data-empty', !hash);
    if (!hash) return;
    const img = make('img');
    img.alt = '';
    img.src = mediaUrl(hash);
    node.append(img);
  }

  function say(text) {
    note.textContent = text ?? '';
    note.hidden = !text;
  }

  /** What went wrong, from a reply over the socket or a rejected request, in words. */
  const reason = (error) => {
    const code = typeof error === 'string' ? error : error?.error;
    const known = ['music_off', 'not_in_channel', 'forbidden', 'slow_down', 'queue_full', 'nothing_to_add', 'no_such_track', 'bad_mode', 'nothing_to_mix'];
    return known.includes(code) ? t(`music.err_${code}`) : (error?.message || t('music.err_failed'));
  };

  /** A request for the call's music; an answer that says no is shown, not thrown. */
  async function ask(type, payload) {
    const id = channelId();
    if (id == null) return false;
    try {
      const reply = await send(type, { channelId: id, ...payload });
      if (reply?.type === 'voice:error') {
        say(reason(reply.error));
        return false;
      }
      say('');
      return true;
    } catch (err) {
      say(reason(err));
      return false;
    }
  }

  // ----------------------------------------------------------------------------------------------------- the strip

  function paintStrip(v) {
    const track = v?.track;
    const live = Boolean(track) && ['loading', 'playing', 'paused'].includes(v.status);
    strip.hidden = !live || channelId() == null;
    if (strip.hidden) return;
    $('music-title').textContent = track.title || t('music.untitled');
    $('music-artist').textContent = v.status === 'loading' ? t('music.loading') : track.artist;
    cover($('music-cover'), track.thumbHash);
    strip.toggleAttribute('data-paused', v.status === 'paused');
    // How long the server's pushes take to get here, as measured: what the sync is working with.
    strip.dataset.latency = String(Math.round(v.latencyMs));
    $('music-flag-shuffle').hidden = !v.shuffle;
    $('music-flag-repeat').hidden = v.repeat === 'off';
    $('music-flag-repeat').dataset.icon = v.repeat === 'one' ? 'repeat-once' : 'repeat';

    // The people who may steer it get the transport here, so a skip does not need the panel. Everybody else sees the
    // flags above and nothing to press.
    const may = canControl();
    $('music-strip-transport').hidden = !may;
    $('music-flags').hidden = may;
    if (!may) return;
    const playing = v.status === 'playing';
    const play = $('music-s-play');
    play.dataset.icon = playing ? 'pause' : 'play';
    play.title = play.ariaLabel = playing ? t('music.pause') : t('music.play');
    $('music-s-shuffle').toggleAttribute('data-on', v.shuffle);
    const repeat = $('music-s-repeat');
    repeat.toggleAttribute('data-on', v.repeat !== 'off');
    repeat.dataset.icon = v.repeat === 'one' ? 'repeat-once' : 'repeat';
    repeat.title = repeat.ariaLabel = t(`music.repeat_${v.repeat}`);
  }

  // ----------------------------------------------------------------------------------------------------- the panel

  function paintNow(v) {
    const track = v?.track;
    const live = Boolean(track) && ['loading', 'playing', 'paused'].includes(v.status);
    $('music-now').hidden = !live;
    if (!live) return;
    $('music-now-title').textContent = track.title || t('music.untitled');
    $('music-now-artist').textContent = v.status === 'loading' ? t('music.loading') : track.artist;
    cover($('music-now-cover'), track.thumbHash);
    const play = $('music-play');
    const playing = v.status === 'playing';
    play.dataset.icon = playing ? 'pause' : 'play';
    play.title = play.ariaLabel = playing ? t('music.pause') : t('music.play');
    $('music-shuffle').toggleAttribute('data-on', v.shuffle);
    const repeat = $('music-repeat');
    repeat.toggleAttribute('data-on', v.repeat !== 'off');
    repeat.dataset.icon = v.repeat === 'one' ? 'repeat-once' : 'repeat';
    repeat.title = repeat.ariaLabel = t(`music.repeat_${v.repeat}`);

    const may = canControl();
    for (const id of ['music-shuffle', 'music-prev', 'music-play', 'music-next', 'music-repeat', 'music-mix']) $(id).hidden = !may;
    seek.disabled = !may || !track.durationMs;
  }

  /**
   * A row that can be dragged to a new place in the queue, the same edit as the arrows make but in one move. The drop
   * says where: above the row it was dropped on, or below it, by which half of the row the pointer was in. Everybody's
   * queue follows, like every other edit: the order shown is always the server's.
   */
  let dragging = null;
  function makeDraggable(row, track, tracks) {
    row.draggable = true;
    const clearMarks = () => {
      for (const marked of queue.querySelectorAll('[data-drop]')) marked.removeAttribute('data-drop');
    };
    const half = (event) => {
      const box = row.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    };
    row.addEventListener('dragstart', (event) => {
      dragging = track.id;
      row.setAttribute('data-dragging', '');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', track.id);
      }
    });
    row.addEventListener('dragend', () => {
      dragging = null;
      row.removeAttribute('data-dragging');
      clearMarks();
    });
    row.addEventListener('dragover', (event) => {
      if (!dragging || dragging === track.id) return;
      event.preventDefault();
      clearMarks();
      row.setAttribute('data-drop', half(event));
    });
    row.addEventListener('dragleave', () => row.removeAttribute('data-drop'));
    row.addEventListener('drop', (event) => {
      if (!dragging) return;
      event.preventDefault();
      const id = dragging;
      const side = half(event);
      dragging = null;
      clearMarks();
      const from = tracks.findIndex((x) => x.id === id);
      let to = tracks.findIndex((x) => x.id === track.id) + (side === 'after' ? 1 : 0);
      // Taking it out first shifts everything after it up by one.
      if (from < to) to -= 1;
      if (from >= 0 && to !== from) ask('music:control', { action: 'move', id, index: to });
    });
  }

  function paintQueue(v) {
    const may = canControl();
    const tracks = v?.queue ?? [];
    queue.replaceChildren();
    $('music-queue-head').hidden = tracks.length === 0;
    $('music-queue-count').textContent = t('music.queue_count', { count: tracks.length });
    $('music-clear').hidden = !may || tracks.length === 0;
    $('music-empty').hidden = tracks.length > 0;
    $('music-empty').textContent = may ? t('music.nothing_playing') : t('music.nothing_playing_listener');

    tracks.forEach((track, index) => {
      const row = make('li', 'music-track');
      row.dataset.id = track.id;
      row.toggleAttribute('data-current', track.id === v.current);
      row.toggleAttribute('data-failed', Boolean(track.error));
      const art = make('span', 'music-cover');
      cover(art, track.thumbHash);
      const text = make('span', 'music-track-text');
      text.append(
        make('strong', '', track.title || t('music.untitled')),
        make('span', 'muted', [track.artist, track.error ? t('music.unavailable') : null].filter(Boolean).join(' · ')),
      );
      const length = make('span', 'music-track-length muted', track.durationMs ? clockText(track.durationMs) : '');
      const who = make('span', 'music-track-by muted', track.addedBy ? t('music.added_by', { name: track.addedBy }) : '');
      row.append(art, text, who, length);

      if (may) {
        const tools = make('span', 'music-track-tools');
        const tool = (icon, label, run, disabled = false) => {
          const b = make('button', 'ghost tiny icon-only');
          b.type = 'button';
          b.dataset.icon = icon;
          b.title = b.ariaLabel = label;
          b.disabled = disabled;
          b.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
          });
          return b;
        };
        const at = tracks.findIndex((x) => x.id === v.current);
        tools.append(
          tool('arrow-up', t('music.move_up'), () => ask('music:control', { action: 'move', id: track.id, index: index - 1 }), index === 0),
          tool('arrow-down', t('music.move_down'), () => ask('music:control', { action: 'move', id: track.id, index: index + 1 }), index === tracks.length - 1),
          // Right after the one playing, from wherever it is in the queue.
          tool('skip-forward', t('music.play_next'), () => ask('music:control', { action: 'next-up', id: track.id }), track.id === v.current || index === at + 1),
          tool('x', t('music.remove'), () => ask('music:control', { action: 'remove', id: track.id })),
        );
        row.append(tools);
        row.title = t('music.reorder_hint');
        // Pressing a row plays it from the start.
        row.addEventListener('click', () => ask('music:control', { action: 'play', id: track.id }));
        row.dataset.clickable = '';
        makeDraggable(row, track, tracks);
      }
      queue.append(row);
    });
  }

  function paintFind() {
    $('music-find').hidden = !canControl();
    if (!canControl()) {
      results.hidden = true;
      results.replaceChildren();
    }
  }

  /** Where the music is, drawn again: the strip always, the panel when it is open. */
  function render() {
    const v = view();
    paintStrip(v);
    button.hidden = !canControl();
    if (!pop.hidden) {
      paintFind();
      paintNow(v);
      paintQueue(v);
      tick();
      placePop();
    }
  }

  /** The bars and the clock, between snapshots. Cheap, and called twice a second while anything is showing. */
  function tick() {
    const v = view();
    const track = v?.track;
    if (!track) return;
    const at = Math.min(position(), track.durationMs ?? Number.MAX_SAFE_INTEGER);
    const ratio = track.durationMs ? Math.min(1, at / track.durationMs) : 0;
    if (!strip.hidden) {
      $('music-bar-fill').style.width = `${(ratio * 100).toFixed(1)}%`;
      $('music-bar').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }
    if (!pop.hidden && !$('music-now').hidden) {
      $('music-time').textContent = `${clockText(at)} / ${track.durationMs ? clockText(track.durationMs) : '--:--'}`;
      if (!seeking) seek.value = String(Math.round(ratio * 1000));
    }
  }
  setInterval(tick, 500);

  // ------------------------------------------------------------------------------------------------- finding music

  /** The results of a search, a link or a playlist, with what can be done to each. */
  function paintResults(found) {
    results.replaceChildren();
    resultsFor = found;
    results.hidden = !found?.items?.length;
    if (results.hidden) {
      placePop();
      return;
    }

    const head = make('div', 'music-results-head');
    if (found.items.length > 1) {
      const all = make('button', 'primary small', t('music.add_all', { count: found.items.length }));
      all.type = 'button';
      all.addEventListener('click', () => add(found.items, { all: true }));
      head.append(make('span', 'muted', t('music.results', { count: found.items.length })), all);
    }
    // A video opened from inside a playlist: the whole of it is one press away.
    if (found.playlist) {
      const list = make('button', 'ghost small', t('music.whole_playlist'));
      list.type = 'button';
      list.addEventListener('click', () => find(`https://www.youtube.com/playlist?list=${found.playlist}`));
      head.append(list);
    }
    if (head.childNodes.length) results.append(head);

    for (const item of found.items) {
      const row = make('div', 'music-result');
      const art = make('span', 'music-cover');
      cover(art, item.thumbHash);
      const text = make('span', 'music-track-text');
      text.append(make('strong', '', item.title), make('span', 'muted', item.artist));
      const length = make('span', 'music-track-length muted', item.durationMs ? clockText(item.durationMs) : '');
      const next = make('button', 'ghost small', t('music.play_next'));
      next.type = 'button';
      next.addEventListener('click', () => add([item], { next: true }));
      const end = make('button', 'primary small', t('music.add'));
      end.type = 'button';
      end.addEventListener('click', () => add([item]));
      row.append(art, text, length, next, end);
      results.append(row);
    }
    placePop();
  }

  async function add(items, { next = false, all = false } = {}) {
    // A playlist is added in the order it is listed, each right after the one before it when "next".
    const ok = await ask('music:add', { items: items.map(({ source, title, artist, durationMs, thumbHash }) => ({ source, title, artist, durationMs, thumbHash })), next });
    if (ok && all) {
      results.replaceChildren();
      results.hidden = true;
      $('music-input').value = '';
    }
  }

  async function find(input) {
    const text = String(input ?? '').trim();
    if (!text) return;
    const go = $('music-go');
    go.disabled = true;
    say('');
    try {
      paintResults(await resolve(text));
      if (resultsFor && !resultsFor.items.length) say(t('music.no_results'));
    } catch (err) {
      results.hidden = true;
      say(reason(err));
    } finally {
      go.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------------------------------- opening

  function open() {
    if (channelId() == null) return;
    pop.hidden = false;
    say('');
    render();
    placePop();
    if (canControl()) $('music-input').focus();
    config.onOpen?.(true);
  }

  function close() {
    pop.hidden = true;
    config.onOpen?.(false);
  }

  /**
   * Above the button where there is room, below it where there is not -- and never taller than the window. Called again
   * whenever what is in the panel changes (results arrive, the queue grows), because its height is what decides where
   * it can go; placed once on opening it ran off the bottom of the window as soon as there was something in it.
   */
  function placePop(anchorEl = config.anchor?.() ?? (button.hidden ? $('music-open') : button)) {
    // A phone: a sheet along the bottom, drawn by the stylesheet (styles.css, "A phone"), not placed beside a button.
    if (window.matchMedia(PHONE).matches) {
      for (const property of ['left', 'top', 'max-height']) pop.style.removeProperty(property);
      return;
    }
    const room = window.innerHeight - 16;
    pop.style.maxHeight = `${room}px`;
    const anchor = anchorEl.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - box.width - 8));
    const above = anchor.top - box.height - 8;
    const below = anchor.bottom + 8;
    let top = above >= 8 ? above : below + box.height <= window.innerHeight - 8 ? below : window.innerHeight - box.height - 8;
    top = Math.max(8, top);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  $('music-open').addEventListener('click', () => (pop.hidden ? open() : close()));
  $('music-close').addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden) close();
  });
  // Dismissed like the other popovers: a press outside, but not on what opens it (it would close here and reopen there).
  document.addEventListener('pointerdown', (event) => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || button.contains(event.target) || $('music-open').contains(event.target)) return;
    // Its button on the call screen opens it too.
    if (event.target.closest?.('[data-music-opener]')) return;
    close();
  }, true);

  $('music-find').addEventListener('submit', (event) => {
    event.preventDefault();
    find($('music-input').value);
  });

  // ------------------------------------------------------------------------------------------------------ controls

  // The panel's buttons and the strip's (music-s-*) make the same moves.
  const moves = {
    play: () => ask('music:control', { action: view()?.status === 'playing' ? 'pause' : 'resume' }),
    prev: () => ask('music:control', { action: 'prev' }),
    next: () => ask('music:control', { action: 'next' }),
    shuffle: () => ask('music:control', { action: 'shuffle', on: !view()?.shuffle }),
    repeat: () => ask('music:control', { action: 'repeat', mode: NEXT_REPEAT[view()?.repeat ?? 'off'] }),
    mix: () => ask('music:control', { action: 'reshuffle' }),
  };
  for (const [name, move] of Object.entries(moves)) {
    $(`music-${name}`).addEventListener('click', move);
    $(`music-s-${name}`).addEventListener('click', move);
  }
  $('music-clear').addEventListener('click', () => ask('music:control', { action: 'clear' }));
  seek.addEventListener('pointerdown', () => { seeking = true; });
  seek.addEventListener('input', () => {
    const track = view()?.track;
    if (track?.durationMs) $('music-time').textContent = `${clockText((Number(seek.value) / 1000) * track.durationMs)} / ${clockText(track.durationMs)}`;
  });
  seek.addEventListener('change', async () => {
    const track = view()?.track;
    if (track?.durationMs) await ask('music:control', { action: 'seek', positionMs: Math.round((Number(seek.value) / 1000) * track.durationMs) });
    seeking = false;
  });

  return {
    render,
    open,
    close,
    get isOpen() { return !pop.hidden; },
    /** The call is over (or the feature was switched off): everything put away. */
    reset() {
      close();
      strip.hidden = true;
      button.hidden = true;
      results.replaceChildren();
      results.hidden = true;
      $('music-input').value = '';
      say('');
    },
  };
}
