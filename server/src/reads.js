// How far each person has read each channel, and what is new since.
//
// Only a high-water mark is kept (channel_reads, one row per person and
// channel), and "unread" is everything of somebody else's newer than it. That
// stays true as messages are deleted and needs nothing written per message.
//
// A person who has no row for a channel has never been counted there. The first
// time they are asked, everything already in it counts as read: a server's
// whole history is not news to somebody who has just arrived, or to everybody
// the day this was added.

/** How many unread messages are looked through for mentions. The count is exact; this only bounds the scan. */
const MENTION_SCAN = 200;

export class ChannelReads {
  #q;

  constructor(db) {
    this.#q = {
      get: db.prepare('SELECT last_read_id AS lastReadId FROM channel_reads WHERE user_id = ? AND channel_id = ?'),
      // MAX, never a plain overwrite: a late or repeated report must not move the mark back.
      set: db.prepare(`
        INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
        ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)
      `),
      newest: db.prepare('SELECT IFNULL(MAX(id), 0) AS id FROM messages WHERE channel_id = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND id > ? AND user_id != ?'),
      unread: db.prepare(
        'SELECT body FROM messages WHERE channel_id = ? AND id > ? AND user_id != ? ORDER BY id DESC LIMIT ?',
      ),
    };
  }

  newestId(channelId) {
    return this.#q.newest.get(channelId).id;
  }

  /**
   * Say a person has read a channel up to a message. Never past the newest one
   * that exists, and never backwards.
   *
   * @returns {number} where the mark now is
   */
  markRead(userId, channelId, upTo) {
    const wanted = Number.isFinite(upTo) ? Math.floor(upTo) : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(wanted, this.newestId(channelId)));
    this.#q.set.run(userId, channelId, target);
    return this.#q.get.get(userId, channelId).lastReadId;
  }

  /**
   * What is new to a person in some channels.
   *
   * @param {number} userId
   * @param {number[]} channelIds  the channels they may read
   * @param {(body: string) => boolean} mentionsThem  whether a message's text is addressed to them
   * @returns {{channelId: number, unread: number, mentions: number, lastId: number, lastReadId: number}[]}
   */
  summary(userId, channelIds, mentionsThem = () => false) {
    return channelIds.map((channelId) => {
      const lastId = this.newestId(channelId);
      let mark = this.#q.get.get(userId, channelId)?.lastReadId;
      if (mark === undefined) {
        this.#q.set.run(userId, channelId, lastId);
        mark = lastId;
      }
      const unread = this.#q.count.get(channelId, mark, userId).n;
      const mentions = unread
        ? this.#q.unread.all(channelId, mark, userId, MENTION_SCAN).filter((m) => mentionsThem(m.body)).length
        : 0;
      return { channelId, unread, mentions, lastId, lastReadId: mark };
    });
  }
}
