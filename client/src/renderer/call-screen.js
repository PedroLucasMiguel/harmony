// The call, as a page of its own over a private conversation: everybody who is in it as a tile, the streams (cameras
// and screen shares) on the same stage a voice channel has -- the big picture and the thumbnails along it -- the music
// that is playing, and the controls -- camera, screen, music, microphone, headphones, hang up -- in one bar under them.
// What Discord's call screen is.
//
// It draws; it does not run the call. The microphone, the cameras, the share and the music are the voice machinery's
// (app.js, voice.js), the same as a voice channel's, and every button here presses the button that machinery already
// has and follows its state, so there is one set of behaviour and nothing to keep in step. What it is handed is a
// `view()` that says what there is to draw.

const $ = (id) => document.getElementById(id);

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The controls, in order: this screen's button, the one it presses, and what it looks like to start with. */
const CONTROLS = [
  { id: 'cs-camera', from: 'voice-cam' },
  { id: 'cs-screen', from: 'voice-screen' },
  { id: 'cs-music', from: 'voice-music' },
  { id: 'cs-mute', from: 'voice-mute' },
  { id: 'cs-deafen', from: 'voice-deafen' },
];
/** What of a pressed button is followed: its picture, whether it is on, and whether it can be pressed. */
const FOLLOWED = ['data-icon', 'data-on', 'disabled', 'hidden', 'title', 'aria-label'];

const clock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/**
 * @param {object} deps
 * @param {(key: string, values?: object) => string} deps.t
 * @param {(face: object, className?: string) => HTMLElement} deps.avatarEl
 * @param {(userId: number, fallback?: string) => object} deps.faceOf
 * @param {(userId: number, fallback?: string) => string} deps.displayOf
 * @param {(container: HTMLElement, member: object, only?: string[]) => void} deps.renderStatus  the flags of a member
 * @param {() => ({
 *   title: string, since: number|null, ringing: boolean, connected: boolean, meMid: number,
 *   roster: object[], streams: {key: string, mid: number, kind: string, stream: MediaStream, own: boolean}[],
 * }|null)} deps.view  what the call is, or null when there is no call to show here
 * @param {() => void} deps.hangUp
 * @param {(mid: number, event: MouseEvent) => void} deps.peerMenu  somebody's menu (volume for you, mute for you), as a voice channel's
 * @param {(userId: number) => boolean} deps.peerMuted  whether you have muted them
 */
export function createCallScreen({
  t, avatarEl, faceOf, displayOf, renderStatus, view, hangUp, peerMenu, peerMuted,
}) {
  const root = $('call-screen');
  const stage = $('call-stage');
  const heading = $('call-title');
  const status = $('call-status');
  const bar = $('call-controls');
  const hang = $('cs-hangup');

  /** What is on the stage, by key: a tile is kept from one drawing to the next, so a picture does not restart. */
  const tiles = new Map();
  let timer = null;

  // ------------------------------------------------------------------------------------------------- the controls

  for (const control of CONTROLS) {
    const mine = $(control.id);
    const theirs = $(control.from);
    if (!mine || !theirs) continue;
    const follow = () => {
      for (const name of FOLLOWED) {
        if (name === 'hidden' || name === 'disabled' || name === 'data-on') {
          mine.toggleAttribute(name, theirs.hasAttribute(name));
        } else if (theirs.hasAttribute(name)) mine.setAttribute(name, theirs.getAttribute(name));
        else mine.removeAttribute(name);
      }
      // A muted microphone is a struck one: the original draws that in its stylesheet, by id, and this is not that id.
      if (control.id === 'cs-mute') mine.dataset.icon = theirs.hasAttribute('data-on') ? 'microphone-slash' : 'microphone';
    };
    follow();
    new MutationObserver(follow).observe(theirs, { attributes: true, attributeFilter: FOLLOWED });
    mine.addEventListener('click', () => theirs.click());
    // The music panel opens beside the button that was pressed.
    if (control.id === 'cs-music') mine.dataset.musicOpener = '';
  }
  hang.addEventListener('click', () => hangUp());
  // Music playing: its button says so.
  const strip = $('music-strip');
  if (strip) {
    const playing = () => $('cs-music')?.toggleAttribute('data-playing', !strip.hidden);
    playing();
    new MutationObserver(playing).observe(strip, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ------------------------------------------------------------------------------------------------------ tiles

  function participant(member) {
    const key = `p:${member.mid}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = make('figure', 'call-tile');
      tile.dataset.key = key;
      tile.dataset.kind = 'person';
      const face = make('div', 'call-face');
      const caption = make('figcaption', 'call-caption');
      caption.append(make('span', 'call-name'), make('span', 'status call-flags'));
      tile.append(face, caption);
      // Everything you can do to somebody is behind a right-click, as in a voice channel: how loudly you hear them,
      // and muting them for yourself.
      tile.title = t('app.right_click_for_volume_and');
      tile.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        peerMenu(Number(tile.dataset.mid), event);
      });
      tiles.set(key, tile);
    }
    tile.dataset.mid = String(member.mid);
    tile.dataset.userId = String(member.userId);
    const picture = avatarEl(faceOf(member.userId, member.nickname), 'call-avatar');
    tile.querySelector('.call-face').replaceChildren(picture);
    tile.querySelector('.call-name').textContent = displayOf(member.userId, member.nickname);
    renderStatus(tile.querySelector('.call-flags'), member);
    // Muted for you: still shown talking, but greyed, so it does not look like audio that is failing.
    tile.toggleAttribute('data-local-muted', peerMuted(member.userId));
    return tile;
  }

  // ------------------------------------------------------------------------------------ what is lent to this screen

  /*
   * The stage of cameras and shares, and the strip of what is playing, are the page's own (a voice channel's stage and
   * its voice panel's strip: their layouts, their buttons on a tile, their volume). While the call is on this screen
   * they are shown here, and when it is not they go back where they were.
   */
  const lent = ['channel-video', 'music-strip'].map((id) => {
    const node = $(id);
    return node && { node, home: node.parentNode, next: node.nextSibling, host: $(id === 'channel-video' ? 'call-video-host' : 'call-music') };
  }).filter(Boolean);

  const sync = () => {
    for (const { node, host } of lent) host.hidden = root.hidden || node.hidden || node.parentNode !== host;
  };
  for (const { node } of lent) new MutationObserver(sync).observe(node, { attributes: true, attributeFilter: ['hidden'] });

  function borrow(on) {
    for (const { node, home, next, host } of lent) {
      if (on && node.parentNode !== host) host.append(node);
      else if (!on && node.parentNode === host) home.insertBefore(node, next && next.parentNode === home ? next : null);
    }
    sync();
  }

  // ------------------------------------------------------------------------------------------------------ drawing

  /** @param {object} [forced]  something to draw in place of what the page says (a test's stand-in) */
  function render(forced) {
    const v = forced ?? view();
    root.hidden = !v;
    borrow(Boolean(v));
    if (!v) {
      stopTimer();
      return;
    }
    heading.textContent = v.title;
    paintStatus(v);

    const roster = v.roster ?? [];
    const people = roster.map((member) => {
      const tile = participant(member);
      tile.toggleAttribute('data-own', member.mid === v.meMid);
      return tile;
    });
    // Whatever is gone from the call is gone from the stage.
    const keep = new Set(people.map((tile) => tile.dataset.key));
    for (const [key, tile] of tiles) {
      if (keep.has(key)) continue;
      tile.remove();
      tiles.delete(key);
    }
    stage.dataset.count = String(Math.min(people.length, 9));
    // With cameras or shares the people are a row under the stage; without, they are the stage.
    root.toggleAttribute('data-streams', (v.streams ?? []).length > 0);
    stage.replaceChildren(...people);
    // A speaking ring that is already on keeps its place across a redraw.
    renderSpeaking(v.speaking);
    startTimer();
  }

  /** Who is talking: a ring round their tile. Called as often as the page polls it, and touches an attribute each. */
  function renderSpeaking(speaking) {
    if (root.hidden) return;
    const live = speaking ?? view()?.speaking ?? new Set();
    for (const tile of tiles.values()) {
      if (tile.dataset.kind !== 'person') continue;
      tile.toggleAttribute('data-speaking', live.has(Number(tile.dataset.mid)));
    }
  }

  function paintStatus(v) {
    if (v.ringing) status.textContent = t('call.ringing');
    else if (!v.connected) status.textContent = t('app.reconnecting');
    else status.textContent = v.since ? clock(Date.now() - v.since) : t('app.voice_connected');
    status.toggleAttribute('data-ringing', Boolean(v.ringing));
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
      const v = view();
      if (v) paintStatus(v);
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  return {
    render,
    renderSpeaking,
    get visible() { return !root.hidden; },
    /** The button the music panel opens beside. */
    get musicAnchor() { return $('cs-music'); },
  };
}
