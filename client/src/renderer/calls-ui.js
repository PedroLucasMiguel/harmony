// Private calls, from the page's side: who is ringing, what the conversations say about the calls going on in
// them, and which call is yours.
//
// The call itself -- the microphone, the cameras, the screen shares -- is the same machinery as a voice channel's
// and lives where that does (app.js, voice.js); a call is joined there as a room whose id is a conversation's.
// What is here is what is only a call's: the card that rings, the sound it makes, and the book-keeping of which
// conversation has a call and who is in it.
//
// Calls are kept per server, because a conversation's id means something only on the server it is on.

import { serverKeyOf } from './server-key.js';

/** A call's room id is this plus its conversation's id: see the server's calls.js. */
export const CALL_BASE = 100_000_000;

/** Whether a room id is a private call's and not a channel's. */
export const isCallRoom = (id) => Number.isSafeInteger(id) && id > CALL_BASE;

/** How often the ring is played again while a call is ringing. */
const RING_EVERY_MS = 2600;

/** A ring that nobody stopped is taken down after this: the server rings for 45 seconds, and a lost push must not ring for ever. */
const RING_GIVE_UP_MS = 60_000;

/**
 * @param {object} deps
 * @param {object} deps.state
 * @param {(key: string, vars?: object) => string} deps.t
 * @param {(name: string) => void} deps.playCue
 * @param {(server: string, userId: number) => string} deps.nameOf  a person's name on a server
 * @param {(server: string, userId: number) => Node|null} deps.faceFor  their picture, where it is known
 * @param {(server: string) => string} deps.serverLabel  what a server goes by
 * @param {(server: string) => boolean} deps.isOpen  whether it is the server on screen
 * @param {(ring: object) => void} deps.answer  join the call a card is ringing for
 * @param {(ring: object) => Promise<void>} deps.decline  turn it down
 * @param {() => void} deps.changed  something about the calls changed: draw what shows them
 * @param {(msg: object) => void} deps.hangUp  the call you are in is over
 */
export function createCalls(deps) {
  const {
    state, t, playCue, nameOf, faceFor, serverLabel, isOpen, answer, decline, changed, hangUp,
  } = deps;

  /** "<server key>:<conversation id>" -> the call, as the server describes it. */
  const calls = new Map();
  /** The same key -> a call that is ringing for you: {server, conversationId, from, title, group, startedAt, gaveUp}. */
  const rings = new Map();
  /** The call you are in: {key, server, conversationId}. */
  let mine = null;
  let ringTimer = null;

  const keyOf = (server, conversationId) => `${serverKeyOf(server)}:${conversationId}`;
  const serverOf = (msg) => msg.server ?? state.server;

  // ------------------------------------------------------------------- the card

  const tray = document.createElement('div');
  tray.id = 'incoming-calls';
  tray.setAttribute('role', 'region');
  tray.setAttribute('aria-live', 'assertive');
  tray.hidden = true;
  document.body.append(tray);

  function card(ring) {
    const box = document.createElement('div');
    box.className = 'incoming-call';
    box.dataset.conversation = String(ring.conversationId);
    const name = ring.from.nickname ?? nameOf(ring.server, ring.from.id);
    const face = faceFor(ring.server, ring.from.id);
    // The person's own picture where it is known (it is an avatar already), initials where it is not.
    const avatar = face ?? document.createElement('span');
    avatar.classList.add('avatar', 'incoming-call-avatar');
    if (!face) avatar.textContent = [...name][0]?.toUpperCase() ?? '?';

    const text = document.createElement('div');
    text.className = 'incoming-call-text';
    const line = document.createElement('strong');
    line.textContent = ring.group
      ? t('call.incoming_group', { name, title: ring.title ?? '' })
      : t('call.incoming', { name });
    text.append(line);
    // Which server it is on, when it is not the one on screen.
    if (!isOpen(ring.server)) {
      const where = document.createElement('small');
      where.className = 'muted';
      where.textContent = serverLabel(ring.server);
      text.append(where);
    }

    const take = document.createElement('button');
    take.type = 'button';
    take.className = 'primary incoming-call-answer';
    take.dataset.icon = 'phone';
    take.textContent = t('call.answer');
    take.addEventListener('click', () => {
      drop(ring);
      answer(ring);
    });

    const refuse = document.createElement('button');
    refuse.type = 'button';
    refuse.className = 'ghost danger incoming-call-decline';
    refuse.dataset.icon = 'phone-disconnect';
    refuse.textContent = t('call.decline');
    refuse.addEventListener('click', () => {
      drop(ring);
      decline(ring).catch(() => { /* it stops ringing by itself */ });
    });

    const buttons = document.createElement('div');
    buttons.className = 'incoming-call-buttons';
    buttons.append(refuse, take);
    box.append(avatar, text, buttons);
    return box;
  }

  function drawRings() {
    tray.replaceChildren(...[...rings.values()].map(card));
    tray.hidden = rings.size === 0;
    if (rings.size && !ringTimer) {
      ringOnce();
      ringTimer = setInterval(ringOnce, RING_EVERY_MS);
    } else if (!rings.size && ringTimer) {
      clearInterval(ringTimer);
      ringTimer = null;
    }
  }

  function ringOnce() {
    const now = Date.now();
    for (const [key, ring] of rings) {
      if (now - ring.gaveUpAt > 0) rings.delete(key);
    }
    if (!rings.size) {
      drawRings();
      return;
    }
    if (state.settings?.callRing !== false) playCue('ring');
  }

  function drop(ring) {
    rings.delete(keyOf(ring.server, ring.conversationId));
    drawRings();
  }

  function addRing(ring) {
    const key = keyOf(ring.server, ring.conversationId);
    // In that very call already (another window answered, or it is yours): nothing to ring for.
    if (mine?.key === key) return;
    rings.set(key, { ...ring, gaveUpAt: Date.now() + RING_GIVE_UP_MS });
    drawRings();
  }

  // ----------------------------------------------------------------------- state

  /** A call in a conversation: what the server last said of it, or null. */
  const stateOf = (serverKey, conversationId) => calls.get(`${serverKeyOf(serverKey)}:${conversationId}`) ?? null;

  /** Whether the call you are in is this conversation's. */
  const mineIs = (serverKey, conversationId) => mine?.key === `${serverKeyOf(serverKey)}:${conversationId}`;

  function setMine(server, conversationId) {
    mine = conversationId == null ? null : { key: keyOf(server, conversationId), server, conversationId };
    if (mine) drop({ server, conversationId });
    changed();
  }

  function setCall(server, conversationId, call) {
    const key = keyOf(server, conversationId);
    if (call) calls.set(key, call);
    else calls.delete(key);
    // Not ringing for anybody who is in it, or who has turned it down: it is told in the state.
    if (!call || !call.ringing.includes(state.auth.user?.id)) {
      if (rings.delete(key)) drawRings();
    }
    changed();
  }

  /** What `hello-ok` says about calls already going on when this connection was made. */
  function seed(server, list) {
    for (const key of [...calls.keys()]) if (key.startsWith(`${serverKeyOf(server)}:`)) calls.delete(key);
    const me = state.auth.user?.id;
    for (const call of list ?? []) {
      calls.set(keyOf(server, call.conversationId), call);
      if (me != null && call.ringing.includes(me)) {
        addRing({
          server,
          conversationId: call.conversationId,
          from: { id: call.startedBy, nickname: nameOf(server, call.startedBy) },
          title: null,
          group: false,
          startedAt: call.startedAt,
        });
      }
    }
    changed();
  }

  /**
   * The server's pushes about calls. Returns whether this was one.
   * @param {object} msg
   */
  function handleEvent(msg) {
    switch (msg.type) {
      case 'call:ring':
        addRing({
          server: serverOf(msg),
          conversationId: msg.conversationId,
          from: msg.from,
          title: msg.title,
          group: msg.group,
          startedAt: msg.startedAt,
        });
        return true;
      case 'call:ring-stopped':
        drop({ server: serverOf(msg), conversationId: msg.conversationId });
        return true;
      case 'call:state':
        setCall(serverOf(msg), msg.conversationId, msg.call);
        return true;
      case 'call:ended':
        // Hung up on: the call you were in is over (nobody else was left, or you were taken out of its group).
        if (mine?.key === keyOf(serverOf(msg), msg.conversationId)) hangUp(msg);
        return true;
      default:
        return false;
    }
  }

  /** A server was signed out of or forgotten: nothing of it rings, and no call of it is going on. */
  function forget(server) {
    const prefix = `${serverKeyOf(server)}:`;
    for (const key of [...calls.keys()]) if (key.startsWith(prefix)) calls.delete(key);
    for (const key of [...rings.keys()]) if (key.startsWith(prefix)) rings.delete(key);
    drawRings();
    changed();
  }

  return {
    handleEvent, seed, forget, stateOf, mineIs, setMine,
    get current() { return mine; },
  };
}
