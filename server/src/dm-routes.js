// The HTTP side of private conversations: keys, conversations, messages,
// reactions, read marks, blocking and sealed files.
//
// Every route that names a conversation or a message resolves it through
// DirectMessages.forUser() first and answers 404 when that is null. There is
// no admin exception anywhere in this file -- not for reading, not for
// deleting -- because there is nothing an admin could usefully do with a
// sealed blob except destroy somebody else's conversation, and that is not a
// moderation tool, it is a way to make people distrust the feature.

import express from 'express';

import {
  DirectMessages, ownKey, publicConversation, publicDmMessage, publicKey,
} from './dms.js';
import { Throttle } from './throttle.js';

/**
 * Mount the routes.
 *
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.requireLogin
 * @param {DirectMessages} deps.dms
 * @param {import('./chat.js').Chat} deps.chat
 * @param {import('./accounts.js').Accounts} deps.accounts
 * @param {(userIds: number[], payload: object) => void} deps.push
 * @param {(payload: object) => void} deps.broadcast
 */
export function mountDirectMessages(app, { requireLogin, dms, chat, accounts, push, broadcast }) {
  // Generous for a person, tight for a script. Separate buckets, so a burst
  // of reactions does not stop somebody replying.
  const sending = new Throttle({ burst: 20, perSecond: 2 });
  const reacting = new Throttle({ burst: 30, perSecond: 3 });
  const uploading = new Throttle({ burst: 10, perSecond: 0.2 });
  const rekeying = new Throttle({ burst: 5, perSecond: 1 / 60 });

  const slowDown = (res, gate) => {
    res.set('Retry-After', String(gate.retryAfterSec));
    return res.status(429).json({
      error: 'slow_down',
      retryAfterSec: gate.retryAfterSec,
      message: 'Too much at once. Wait a moment and try again.',
    });
  };

  const throttled = (bucket) => (req, res, next) => {
    const gate = bucket.take(req.user.id);
    return gate.allowed ? next() : slowDown(res, gate);
  };

  /** The conversation in :id, if the caller is in it. Attaches it as req.conversation. */
  const conversation = (req, res, next) => {
    const c = dms.forUser(req.user.id, Number.parseInt(req.params.id, 10));
    if (!c) return res.status(404).json({ error: 'no_such_conversation' });
    req.conversation = c;
    return next();
  };

  /** The message in :id and its conversation, if the caller is in it and has not deleted it. */
  const dmMessage = (req, res, next) => {
    const m = dms.message(Number.parseInt(req.params.id, 10));
    const c = m && dms.forUser(req.user.id, m.conversation_id);
    if (!m || !c || !dms.visibleTo(m, req.user.id)) return res.status(404).json({ error: 'no_such_message' });
    req.dmMessage = m;
    req.conversation = c;
    return next();
  };

  /** A refusal from DirectMessages as an HTTP answer. */
  const refuse = (res, result) => {
    const status = {
      stale_key: 409,
      no_key: 409,
      peer_has_no_key: 409,
      blocked: 403,
      no_such_message: 404,
    }[result.error] ?? 400;
    const messages = {
      stale_key: 'A key changed. Seal it again with the current keys.',
      no_key: 'Set up your private messages first.',
      peer_has_no_key: 'They have not set up private messages yet.',
      blocked: 'You cannot send messages in this conversation.',
      bad_message: 'That is not a sealed message.',
      bad_key: 'That is not a key.',
      no_such_message: 'No such message.',
    };
    return res.status(status).json({
      error: result.error,
      message: messages[result.error],
      ...(result.keys ? { keys: result.keys.map(publicKey) } : {}),
    });
  };

  /** Messages for a client, with their reactions and every key needed to open them. */
  const forClient = (messages) => {
    const list = [].concat(messages).filter(Boolean);
    const reactions = dms.reactionsFor(list.map((m) => m.id));
    const out = list.map((m) => publicDmMessage(m, reactions.get(m.id) ?? []));
    const keyIds = new Set();
    for (const m of out) {
      if (m.senderKey) keyIds.add(m.senderKey);
      if (m.recipientKey) keyIds.add(m.recipientKey);
      for (const r of m.reactions) keyIds.add(r.senderKey).add(r.recipientKey);
    }
    return { messages: out, keys: dms.keysByIds([...keyIds]).map(publicKey) };
  };

  const members = (c) => DirectMessages.members(c);
  /** Who is told about a change to `m`: not somebody who deleted it for themselves. */
  const seeing = (c, m) => members(c).filter((id) => dms.visibleTo(m, id));

  // ------------------------------------------------------------------ keys

  /**
   * Every account's current public key, and your own key with its wrapped
   * private half. One request on sign-in tells a client whether it can open
   * your messages, whether it has to ask for your recovery key, and who it
   * can write to.
   */
  app.get('/api/keys', requireLogin, (req, res) => {
    res.json({
      keys: dms.currentKeys().map(publicKey),
      mine: ownKey(dms.currentKey(req.user.id)),
    });
  });

  /** Public keys by id, for history sealed to keys since replaced. */
  app.get('/api/keys/lookup', requireLogin, (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').map((s) => Number.parseInt(s, 10));
    res.json({ keys: dms.keysByIds(ids).map(publicKey) });
  });

  /**
   * Publish a new identity key -- the first, or a fresh start.
   *
   * Everybody is told, because everybody who talks to you has to stop
   * sealing to the old one, and because a key that changes is something the
   * other person deserves to see: it is also what an impersonation would
   * look like.
   */
  app.post('/api/keys', requireLogin, throttled(rekeying), (req, res) => {
    const result = dms.addKey(req.user.id, req.body?.publicKey, req.body?.wrapped);
    if (!result.ok) return refuse(res, result);
    broadcast({ type: 'keys:changed', key: publicKey(result.key) });
    return res.status(201).json({ key: ownKey(result.key) });
  });

  /** Seal your current key under a new recovery key. Nothing anybody else sees changes. */
  app.post('/api/keys/wrap', requireLogin, throttled(rekeying), (req, res) => {
    const result = dms.rewrap(req.user.id, req.body?.keyId, req.body?.wrapped);
    if (!result.ok) return refuse(res, result);
    return res.json({ key: ownKey(result.key) });
  });

  // ---------------------------------------------------------- conversations

  app.get('/api/dms', requireLogin, (req, res) => {
    const rows = dms.list(req.user.id);
    const keyIds = new Set();
    for (const { last } of rows) {
      if (last?.senderKey) keyIds.add(last.senderKey).add(last.recipientKey);
    }
    res.json({
      conversations: rows.map((r) => ({
        ...publicConversation(r.conversation),
        unread: r.unread,
        lastReadId: r.lastReadId,
        last: r.last,
      })),
      keys: dms.keysByIds([...keyIds]).map(publicKey),
      blocked: dms.blocked(req.user.id),
    });
  });

  /** Open the conversation with somebody, making it if it does not exist. */
  app.post('/api/dms', requireLogin, (req, res) => {
    const peerId = Number.parseInt(req.body?.userId, 10);
    if (peerId === req.user.id) {
      return res.status(400).json({ error: 'not_yourself', message: 'That is you.' });
    }
    if (!accounts.byId(peerId)) return res.status(404).json({ error: 'no_such_user' });
    const { conversation: c, created } = dms.open(req.user.id, peerId);
    return res.status(created ? 201 : 200).json({ conversation: publicConversation(c) });
  });

  /** Block or unblock somebody. Either way round, nothing passes between you while it holds. */
  app.post('/api/dms/blocks', requireLogin, (req, res) => {
    const userId = Number.parseInt(req.body?.userId, 10);
    if (userId === req.user.id || !accounts.byId(userId)) {
      return res.status(404).json({ error: 'no_such_user' });
    }
    const blocked = dms.setBlocked(req.user.id, userId, req.body?.blocked !== false);
    push([req.user.id], { type: 'dm:blocks', blocked });
    return res.json({ blocked });
  });

  app.get('/api/dms/:id', requireLogin, conversation, (req, res) => {
    res.json({ conversation: publicConversation(req.conversation) });
  });

  app.get('/api/dms/:id/messages', requireLogin, conversation, (req, res) => {
    const before = Number.parseInt(req.query.before ?? '', 10);
    res.json(forClient(dms.history(req.conversation.id, req.user.id, {
      before: Number.isFinite(before) ? before : undefined,
    })));
  });

  /**
   * Delete the conversation for yourself: what is in it now goes from your
   * list and your history, and stays for the other person, who is not told.
   * Your other windows are, so it goes from them too.
   */
  app.post('/api/dms/:id/clear', requireLogin, conversation, (req, res) => {
    const clearedId = dms.clear(req.conversation, req.user.id);
    push([req.user.id], { type: 'dm:cleared', conversationId: req.conversation.id, clearedId });
    res.json({ clearedId });
  });

  app.post('/api/dms/:id/messages', requireLogin, conversation, throttled(sending), (req, res) => {
    const c = req.conversation;
    if (dms.isBlocked(req.user.id, DirectMessages.peerOf(c, req.user.id))) {
      return refuse(res, { error: 'blocked' });
    }

    const hash = req.body?.attachmentHash ?? null;
    if (hash !== null && !(/^[0-9a-f]{64}$/.test(String(hash)) && chat.isSealed(String(hash)))) {
      return res.status(400).json({ error: 'no_such_upload', message: 'Upload the file first.' });
    }

    const result = dms.post({
      conversation: c,
      userId: req.user.id,
      sealed: req.body?.sealed,
      senderKey: req.body?.senderKey,
      recipientKey: req.body?.recipientKey,
      attachmentHash: hash,
    });
    if (!result.ok) return refuse(res, result);

    // Writing is reading: your own message moves your mark past everything before it.
    dms.markRead(c.id, req.user.id, result.message.id);
    const message = publicDmMessage(result.message);
    push(members(c), { type: 'dm:message', message, conversation: publicConversation(dms.get(c.id)) });
    return res.status(201).json({ message });
  });

  /**
   * Move your read mark. Told to your own other windows -- so reading on one
   * computer clears the badge on the other -- and to nobody else.
   */
  app.post('/api/dms/:id/read', requireLogin, conversation, (req, res) => {
    const lastReadId = dms.markRead(req.conversation.id, req.user.id, req.body?.upTo);
    push([req.user.id], { type: 'dm:read', conversationId: req.conversation.id, lastReadId });
    res.json({ lastReadId });
  });

  /**
   * Upload a sealed file. Raw bytes, any content type: the client encrypted
   * them, so there is nothing to check but the size. The quota and the
   * eviction of files nobody sent apply exactly as to any other upload.
   *
   * Buffered, as POST /api/uploads is: the one-request cap keeps that small.
   * express.raw sits AFTER the person and the conversation are known and the
   * rate is checked, so a stranger's body is never read at all.
   */
  app.post(
    '/api/dms/:id/uploads',
    requireLogin,
    conversation,
    throttled(uploading),
    (req, res, next) => {
      // A refusal before the body is all read hangs up after answering, rather
      // than have Node read the rest only to throw it away.
      const tooLarge = () => {
        if (!req.complete) res.set('Connection', 'close');
        return res.status(413).json({
          error: 'file_too_large',
          message: `Files are limited to ${Math.round(chat.requestLimit() / 1024 / 1024)} MB.`,
        });
      };
      if (Number(req.get('content-length')) > chat.requestLimit({ sealed: true })) return tooLarge();
      return express.raw({ type: () => true, limit: chat.requestLimit({ sealed: true }) })(req, res, (err) => {
        if (err?.type === 'entity.too.large') return tooLarge();
        return next(err);
      });
    },
    (req, res) => {
      if ((req.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity') {
        return res.status(415).json({ error: 'unsupported_encoding', message: 'Send the file uncompressed.' });
      }
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!body?.length) {
        return res.status(400).json({ error: 'empty_file', message: 'Send the file as the raw request body.' });
      }
      const result = chat.store(body, null, { sealed: true });
      if (!result.ok) {
        if (result.error === 'file_too_large') {
          return res.status(413).json({
            error: 'file_too_large',
            message: `Files are limited to ${Math.round(chat.requestLimit() / 1024 / 1024)} MB.`,
          });
        }
        return res.status(result.error === 'server_full' ? 507 : 400).json({ error: result.error });
      }
      return res.status(201).json({ hash: result.upload.hash, bytes: result.upload.bytes });
    },
  );

  /** A sealed file, to the two people of the conversation it was sent in, and only them. */
  app.get('/api/dms/:id/uploads/:hash', requireLogin, conversation, (req, res) => {
    const hash = String(req.params.hash);
    if (!/^[0-9a-f]{64}$/.test(hash) || !dms.hasAttachment(req.conversation.id, req.user.id, hash)) {
      return res.status(404).json({ error: 'no_such_file' });
    }
    const info = chat.fileInfo(hash);
    if (!info) return res.status(404).json({ error: 'no_such_file' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    // Content-addressed and sealed: it never changes, and no shared cache has
    // any business keeping a copy.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    return res.sendFile(info.path, { dotfiles: 'allow' });
  });

  // ------------------------------------------------------- one message

  /** Your own messages only. Nobody else's words can be changed, by anybody. */
  app.post('/api/dm-messages/:id/edit', requireLogin, dmMessage, throttled(sending), (req, res) => {
    const m = req.dmMessage;
    if (m.user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden', message: 'You can only edit your own messages.' });
    }
    const result = dms.edit(m, req.conversation, {
      sealed: req.body?.sealed,
      senderKey: req.body?.senderKey,
      recipientKey: req.body?.recipientKey,
    });
    if (!result.ok) return refuse(res, result);
    const { messages: [message] } = forClient(result.message);
    push(seeing(req.conversation, m), { type: 'dm:updated', message });
    return res.json({ message });
  });

  /** What a message said before each edit, sealed as it was; the client opens them. */
  app.get('/api/dm-messages/:id/edits', requireLogin, dmMessage, (req, res) => {
    res.json({ versions: dms.versions(req.dmMessage) });
  });

  /** Your own only -- unlike a channel, an admin has no say over somebody's private words. */
  app.post('/api/dm-messages/:id/delete', requireLogin, dmMessage, (req, res) => {
    const m = req.dmMessage;
    if (m.user_id !== req.user.id || m.kind !== 'text') {
      return res.status(403).json({ error: 'forbidden', message: 'Not your message.' });
    }
    dms.remove(m);
    push(seeing(req.conversation, m), {
      type: 'dm:deleted', id: m.id, conversationId: req.conversation.id,
    });
    return res.json({ ok: true });
  });

  /**
   * Set your reactions to a message, sealed; `sealed: null` clears them.
   * Blocking stops reactions too: they are a way of saying something.
   */
  app.post('/api/dm-messages/:id/react', requireLogin, dmMessage, throttled(reacting), (req, res) => {
    const c = req.conversation;
    const sealed = req.body?.sealed ?? null;
    if (sealed !== null && dms.isBlocked(req.user.id, DirectMessages.peerOf(c, req.user.id))) {
      return refuse(res, { error: 'blocked' });
    }
    const result = dms.setReaction({
      message: req.dmMessage,
      conversation: c,
      userId: req.user.id,
      sealed,
      senderKey: req.body?.senderKey,
      recipientKey: req.body?.recipientKey,
    });
    if (!result.ok) return refuse(res, result);
    const reactions = dms.reactionsFor([req.dmMessage.id]).get(req.dmMessage.id) ?? [];
    push(seeing(c, req.dmMessage), {
      type: 'dm:reactions', id: req.dmMessage.id, conversationId: c.id, reactions,
    });
    return res.json({ reactions });
  });
}
