// Private calls: a call inside a conversation, between its two people or its whole group.
//
// A call is a voice room that belongs to a conversation instead of a channel. It is the same machine -- slots on
// join, WHIP/WHEP paths on the relay, mute and deafen, a camera and a screen share each on a path of their own --
// kept in a VoiceRooms of its own, so that none of what lists and counts channels ever sees it. Its id in the
// path namespace is CALL_BASE + the conversation's id, which no channel will ever reach: the same token that lets
// somebody into a channel's paths is therefore useless on a call's, and the other way round.
//
// This file keeps the part that is only a call's: who is being rung and for how long, that it started and ended,
// and the line written into the conversation when it does ("call, 5 minutes", "missed call"). A conversation has
// at most one call at a time; somebody calling while one is going on joins it.
//
// What the relay carries is not end-to-end encrypted, as a voice channel's is not: the people of the conversation
// are the only ones let in, and the client says so.

import { VoiceRooms, VOICE_HARD_CAP } from './channels.js';

/** A call's room id is this plus its conversation's id. A channel's id is a small number. */
export const CALL_BASE = 100_000_000;

export const roomOf = (conversationId) => CALL_BASE + conversationId;
export const isCallRoom = (roomId) => Number.isSafeInteger(roomId) && roomId > CALL_BASE;
export const conversationOf = (roomId) => (isCallRoom(roomId) ? roomId - CALL_BASE : null);

/** How long somebody is rung, and how long a call waits for anybody at all to answer, in milliseconds. */
export const RING_MS = 45_000;

export class PrivateCalls {
  #dms;
  #rooms = new VoiceRooms();
  #ringMs;
  #onChange;
  #onEnded;
  /**
   * @type {Map<number, {
   *   conversationId: number, startedBy: number, startedAt: number, answeredAt: number|null,
   *   ringing: Set<number>, everJoined: Set<number>, timer: NodeJS.Timeout|null,
   * }>}
   */
  #calls = new Map();

  /**
   * @param {object} deps
   * @param {import('./dms.js').DirectMessages} deps.dms
   * @param {(conversationId: number) => void} deps.onChange  something about the call changed: tell the conversation
   * @param {(conversation: object, line: object) => void} deps.onEnded  the call is over, and this is the line it left
   * @param {number} [deps.ringMs]
   */
  constructor({ dms, onChange, onEnded, ringMs = RING_MS }) {
    this.#dms = dms;
    this.#onChange = onChange;
    this.#onEnded = onEnded;
    this.#ringMs = ringMs;
  }

  /** The live rooms, for the code that already knows how to read a roster, mute and so on. */
  get rooms() {
    return this.#rooms;
  }

  /** What anybody in the conversation is told about its call, or null when there is none. */
  state(conversationId) {
    const call = this.#calls.get(conversationId);
    if (!call) return null;
    return {
      conversationId,
      roomId: roomOf(conversationId),
      startedBy: call.startedBy,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      // A duration, as the voice rosters send theirs: a client's clock may be a minute off.
      runningFor: Date.now() - call.startedAt,
      participants: this.#rooms.roster(roomOf(conversationId)).map((m) => m.userId),
      ringing: [...call.ringing],
    };
  }

  /** The calls going on in the conversations `userId` is in. */
  activeFor(userId) {
    const out = [];
    for (const conversationId of this.#calls.keys()) {
      const conversation = this.#dms.forUser(userId, conversationId);
      if (conversation) out.push(this.state(conversationId));
    }
    return out;
  }

  /** Whether somebody is being rung, or is on a call: what the background poll reports. */
  ringingFor(userId) {
    return this.activeFor(userId).some((s) => s.ringing.includes(userId));
  }

  inCall(userId) {
    return Boolean(this.#find(userId));
  }

  /** The room `userId` is in, if any. */
  #find(userId) {
    for (const conversationId of this.#calls.keys()) {
      if (this.#rooms.find(roomOf(conversationId), userId)) return conversationId;
    }
    return null;
  }

  /**
   * Begin a call -- or, in a conversation that has one, join it.
   * @param {object} conversation  as DirectMessages.forUser gave it
   * @param {{id: number, nickname: string}} user
   */
  start(conversation, user) {
    if (this.#calls.has(conversation.id)) return this.join(conversation, user);
    const members = this.#dms.members(conversation);
    // Two people who have blocked one another do not ring each other.
    if (conversation.kind !== 'group' && this.#dms.isBlocked(members[0], members[1])) {
      return { ok: false, error: 'blocked' };
    }
    const call = {
      conversationId: conversation.id,
      startedBy: user.id,
      startedAt: Date.now(),
      answeredAt: null,
      ringing: new Set(members.filter((id) => id !== user.id)),
      everJoined: new Set([user.id]),
      timer: null,
    };
    this.#calls.set(conversation.id, call);
    const joined = this.#rooms.join(roomOf(conversation.id), user);
    // Nobody has answered by the time the ringing stops: the call is over, as if it had been hung up on.
    call.timer = setTimeout(() => this.#unanswered(conversation.id), this.#ringMs);
    call.timer.unref?.();
    this.#onChange(conversation.id);
    return { ok: true, started: true, roomId: roomOf(conversation.id), ...joined };
  }

  join(conversation, user) {
    const call = this.#calls.get(conversation.id);
    if (!call) return { ok: false, error: 'no_call' };
    const joined = this.#rooms.join(roomOf(conversation.id), user);
    if (!joined.ok) return joined;
    call.ringing.delete(user.id);
    call.everJoined.add(user.id);
    if (call.answeredAt === null && user.id !== call.startedBy) {
      call.answeredAt = Date.now();
      clearTimeout(call.timer);
      call.timer = null;
    }
    this.#onChange(conversation.id);
    return { ok: true, started: false, roomId: roomOf(conversation.id), ...joined };
  }

  /** Turn a call down. In a pair that is the end of it; in a group the others carry on and are rung no more for you. */
  decline(conversation, userId) {
    const call = this.#calls.get(conversation.id);
    if (!call || !call.ringing.delete(userId)) return { ok: true };
    if (conversation.kind !== 'group') {
      this.#end(conversation.id, 'declined');
    } else {
      this.#onChange(conversation.id);
    }
    return { ok: true };
  }

  /** Leave a call; it ends with the last one out, or when only one is left of those who answered. @returns {number|false} the slot they had */
  leave(roomId, userId) {
    const mid = this.#rooms.leave(roomId, userId);
    const conversationId = conversationOf(roomId);
    const call = this.#calls.get(conversationId);
    if (mid === false || !call) return mid;
    const left = this.#rooms.roster(roomId).length;
    // Over when nobody is left -- and when one is left alone after the others had come in: a call is for talking to
    // somebody, and the one who stays is not waiting for anybody who has not yet picked up.
    if (left === 0 || (call.answeredAt !== null && left <= 1)) this.#end(conversationId, null);
    else this.#onChange(conversationId);
    return mid;
  }

  /**
   * Every call this person is in, left: their socket closed, or they joined something else. `except` is a room
   * they are about to be in, which must not be left (and ended, if they were the only one there) on the way.
   */
  leaveAll(userId, except = null) {
    const left = [];
    for (const conversationId of [...this.#calls.keys()]) {
      const roomId = roomOf(conversationId);
      if (roomId !== except && this.leave(roomId, userId) !== false) left.push(roomId);
    }
    return left;
  }

  /** The conversation was removed from under the call (a group ended): there is nobody to ring and no line to write. */
  forget(conversationId) {
    const call = this.#calls.get(conversationId);
    if (!call) return;
    clearTimeout(call.timer);
    this.#calls.delete(conversationId);
    for (const { userId } of this.#rooms.roster(roomOf(conversationId))) this.#rooms.leave(roomOf(conversationId), userId);
  }

  #unanswered(conversationId) {
    const call = this.#calls.get(conversationId);
    if (!call || call.answeredAt !== null) return;
    this.#end(conversationId, 'missed');
  }

  /**
   * The call is over. `outcome` says how when it did not simply end: otherwise it is "ended" if anybody
   * answered and "missed" if nobody did.
   */
  #end(conversationId, outcome) {
    const call = this.#calls.get(conversationId);
    if (!call) return;
    clearTimeout(call.timer);
    this.#calls.delete(conversationId);
    const roomId = roomOf(conversationId);
    const stillIn = this.#rooms.roster(roomId).map((m) => m.userId);
    for (const userId of stillIn) this.#rooms.leave(roomId, userId);

    const conversation = this.#dms.get(conversationId);
    if (!conversation) return;
    const answered = call.answeredAt !== null;
    const line = this.#dms.record(conversationId, call.startedBy, {
      outcome: outcome ?? (answered ? 'ended' : 'missed'),
      startedAt: call.startedAt,
      durationMs: answered ? Date.now() - call.answeredAt : 0,
      participants: [...call.everJoined],
    });
    // The people still in it are told it is over by the same push that tells everybody.
    this.#onEnded(conversation, line, stillIn);
  }
}

export { VOICE_HARD_CAP };
