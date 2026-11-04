// Forum channels: posts with a title, the answers under them, the listing and the search of a post.
//
//   node --test server/test/forum.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { liveServer } from './helpers/live-server.js';

const s = liveServer({ port: 18173, mtxPort: 20073 });
const { api, tokens, ids } = s;
let forum;
let text;
let ann;
let bob;
let post;
let posts;

before(async () => {
  await s.start(['boss', 'ann', 'bob']);
  const made = await api('/api/channels', { method: 'POST', token: tokens.boss, body: { kind: 'forum', name: 'questions' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  forum = made.body.channel.id;
  assert.equal(made.body.channel.kind, 'forum');
  text = (await api('/api/channels', { token: tokens.boss })).body.channels.find((c) => c.kind === 'text').id;
  ann = s.connect(tokens.ann);
  await ann.hello();
  bob = s.connect(tokens.bob);
  await bob.hello();
  post = (token, channel, body) => api(`/api/channels/${channel}/messages`, { method: 'POST', token, body });
  posts = (token, query = '') => api(`/api/channels/${forum}/posts${query}`, { token });
});
after(async () => {
  ann.ws.close();
  bob.ws.close();
  await s.stop();
});

describe('what a forum takes', () => {
  it('is a channel of its own kind', async () => {
    const list = (await api('/api/channels', { token: tokens.ann })).body.channels;
    assert.equal(list.find((c) => c.id === forum).kind, 'forum');
  });

  it('takes a post: a title and words, and says so to everybody who reads it', async () => {
    const r = await post(tokens.ann, forum, { title: '  Sobre   sugestões ', body: 'Is this the rule?' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.message.title, 'Sobre sugestões');
    assert.equal(r.body.message.threadId, null);
    const heard = await bob.next((m) => m.type === 'message' && m.message.id === r.body.message.id);
    assert.equal(heard.message.title, 'Sobre sugestões');
  });

  it('refuses a message that belongs to no post, a post without a title, and a title anywhere else', async () => {
    assert.equal((await post(tokens.ann, forum, { body: 'loose' })).body.error, 'forum_needs_post');
    assert.equal((await post(tokens.ann, forum, { title: '   ', body: 'x' })).body.error, 'post_needs_title');
    assert.equal((await post(tokens.ann, text, { title: 'A title', body: 'x' })).body.error, 'not_a_forum');
    assert.equal((await post(tokens.ann, text, { threadId: 1, body: 'x' })).body.error, 'not_a_forum');
    assert.equal((await post(tokens.ann, forum, { title: 'Only a title' })).body.error, 'empty_message');
  });

  it('takes a poll as an answer, and not as a post', async () => {
    const root = (await post(tokens.ann, forum, { title: 'Lunch', body: 'Where?' })).body.message;
    const poll = await post(tokens.bob, forum, { threadId: root.id, poll: { title: 'Pizza?', options: ['yes', 'no'] } });
    assert.equal(poll.status, 201, JSON.stringify(poll.body));
    assert.equal(poll.body.message.poll.title, 'Pizza?');
    assert.equal((await post(tokens.bob, forum, { title: 'A poll post', poll: { title: 'x', options: ['a', 'b'] } })).status, 400);
  });
});

describe('the answers under a post', () => {
  let root;
  before(async () => {
    root = (await post(tokens.ann, forum, { title: 'Thread one', body: 'The question' })).body.message;
  });

  it('are messages with the post\'s id, in the post\'s thread and nowhere else', async () => {
    const reply = await post(tokens.bob, forum, { threadId: root.id, body: 'An answer' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.message.threadId, root.id);
    assert.equal(reply.body.message.title, null);
    const thread = await api(`/api/channels/${forum}/messages?thread=${root.id}`, { token: tokens.ann });
    assert.deepEqual(thread.body.messages.map((m) => m.body), ['The question', 'An answer']);
    assert.equal(thread.body.messages[0].id, root.id, 'the post is the first of its thread');
    const other = (await post(tokens.ann, forum, { title: 'Thread two', body: 'Something else' })).body.message;
    const second = await api(`/api/channels/${forum}/messages?thread=${other.id}`, { token: tokens.ann });
    assert.deepEqual(second.body.messages.map((m) => m.body), ['Something else']);
  });

  it('must be written under a post of this forum', async () => {
    const reply = (await post(tokens.bob, forum, { threadId: root.id, body: 'x' })).body.message;
    assert.equal((await post(tokens.bob, forum, { threadId: reply.id, body: 'under an answer' })).body.error, 'no_such_post');
    assert.equal((await post(tokens.bob, forum, { threadId: 999999, body: 'under nothing' })).body.error, 'no_such_post');
    const textMessage = (await post(tokens.ann, text, { body: 'in a text channel' })).body.message;
    assert.equal((await post(tokens.bob, forum, { threadId: textMessage.id, body: 'across channels' })).body.error, 'no_such_post');
  });

  it('are read from a thread, never from the forum as a log', async () => {
    assert.equal((await api(`/api/channels/${forum}/messages`, { token: tokens.ann })).status, 404);
    assert.equal((await api(`/api/channels/${forum}/messages?thread=${root.id + 9999}`, { token: tokens.ann })).status, 404);
  });

  it('keep what a thread pins to the thread, and reactions and votes work as anywhere', async () => {
    const reply = (await post(tokens.bob, forum, { threadId: root.id, body: 'pin me' })).body.message;
    assert.equal((await api(`/api/messages/${reply.id}/pin`, { method: 'POST', token: tokens.boss, body: { pinned: true } })).status, 200);
    const here = await api(`/api/channels/${forum}/messages?thread=${root.id}`, { token: tokens.ann });
    assert.deepEqual(here.body.pinned.map((m) => m.id), [reply.id]);
    const other = (await post(tokens.ann, forum, { title: 'Thread three', body: 'No pins here' })).body.message;
    const there = await api(`/api/channels/${forum}/messages?thread=${other.id}`, { token: tokens.ann });
    assert.deepEqual(there.body.pinned, []);
    assert.equal((await api(`/api/messages/${reply.id}/react`, { method: 'POST', token: tokens.ann, body: { emoji: '\u{1F44D}' } })).status, 200);
  });

  it('are found by a search of the post, and only of that post', async () => {
    const a = (await post(tokens.ann, forum, { title: 'Alpha', body: 'zebra stripes here' })).body.message;
    await post(tokens.bob, forum, { threadId: a.id, body: 'more about the zebra' });
    const b = (await post(tokens.ann, forum, { title: 'Beta', body: 'a zebra too' })).body.message;
    const everywhere = await api('/api/search?q=zebra', { token: tokens.ann });
    assert.equal(everywhere.body.total, 3, 'the whole server, forums included');
    const inA = await api(`/api/search?q=zebra&thread=${a.id}`, { token: tokens.ann });
    assert.equal(inA.body.total, 2);
    assert.ok(inA.body.results.every((m) => m.id === a.id || m.threadId === a.id));
    const inB = await api(`/api/search?q=zebra&thread=${b.id}`, { token: tokens.ann });
    assert.equal(inB.body.total, 1);
    assert.equal((await api('/api/search?thread=abc', { token: tokens.ann })).status, 400);
  });

  it('find a post by its title too', async () => {
    await post(tokens.ann, forum, { title: 'Quokkas', body: 'nothing in the words' });
    const found = await api('/api/search?q=Quokkas', { token: tokens.ann });
    assert.equal(found.body.total, 1);
    assert.equal(found.body.results[0].title, 'Quokkas');
  });

  it('say whose thread somebody is typing in', async () => {
    ann.ws.send(JSON.stringify({ type: 'typing', scope: 'channel', id: forum, thread: root.id }));
    const told = await bob.next((m) => m.type === 'typing' && m.id === forum && m.userId === ids.ann);
    assert.equal(told.thread, root.id);
  });
});

describe('the listing of posts', () => {
  let a;
  let b;
  let c;
  before(async () => {
    // A forum of its own, so that what is counted is only what is made here.
    forum = (await api('/api/channels', { method: 'POST', token: tokens.boss, body: { kind: 'forum', name: 'listing' } })).body.channel.id;
    a = (await post(tokens.ann, forum, { title: 'First post', body: 'about apples' })).body.message;
    await new Promise((done) => { setTimeout(done, 15); });
    b = (await post(tokens.bob, forum, { title: 'Second post', body: 'about bananas' })).body.message;
    await new Promise((done) => { setTimeout(done, 15); });
    c = (await post(tokens.ann, forum, { title: 'Third post', body: 'about cherries' })).body.message;
    // The oldest is answered last, and twice; the newest not at all.
    await post(tokens.bob, forum, { threadId: b.id, body: 'one' });
    await new Promise((done) => { setTimeout(done, 15); });
    await post(tokens.ann, forum, { threadId: a.id, body: 'two about durians' });
    await post(tokens.bob, forum, { threadId: a.id, body: 'three' });
    await api(`/api/messages/${a.id}/react`, { method: 'POST', token: tokens.bob, body: { emoji: '\u{2705}' } });
  });

  const titles = (r) => r.body.posts.map((p) => p.message.title);

  it('puts the post that was written in last first, with its answers counted', async () => {
    const r = await posts(tokens.ann);
    assert.deepEqual(titles(r), ['First post', 'Second post', 'Third post']);
    assert.deepEqual(r.body.posts.map((p) => p.replyCount), [2, 1, 0]);
    assert.ok(r.body.posts[0].lastActivityAt > r.body.posts[0].message.createdAt);
    assert.equal(r.body.posts[2].lastActivityAt, r.body.posts[2].message.createdAt, 'no answers: when it was made');
    assert.equal(r.body.more, false);
  });

  it('can be put in the order they were made, or by how many answers they have', async () => {
    assert.deepEqual(titles(await posts(tokens.ann, '?sort=new')), ['Third post', 'Second post', 'First post']);
    assert.deepEqual(titles(await posts(tokens.ann, '?sort=replies')), ['First post', 'Second post', 'Third post']);
  });

  it('shows what was reacted to the post, and its first file', async () => {
    const first = (await posts(tokens.ann)).body.posts.find((p) => p.message.title === 'First post').message;
    assert.deepEqual(first.reactions.map((r) => [r.emoji, r.count]), [['\u{2705}', 1]]);
    assert.equal(first.attachmentHash, null);
  });

  it('is searched in the title, the words and what is written under a post', async () => {
    assert.deepEqual(titles(await posts(tokens.ann, '?q=bananas')), ['Second post']);
    assert.deepEqual(titles(await posts(tokens.ann, '?q=SECOND')), ['Second post']);
    assert.deepEqual(titles(await posts(tokens.ann, '?q=durians')), ['First post'], 'found through an answer');
    assert.deepEqual(titles(await posts(tokens.ann, '?q=nothing-like-this')), []);
    assert.deepEqual(titles(await posts(tokens.ann, '?q=%25')), [], 'a % is a character, not a wildcard');
  });

  it('is paged', async () => {
    for (let i = 0; i < 31; i += 1) await post(tokens.ann, forum, { title: `Bulk ${i}`, body: 'x' });
    const first = await posts(tokens.ann, '?sort=new');
    assert.equal(first.body.posts.length, 30);
    assert.equal(first.body.more, true);
    const rest = await posts(tokens.ann, '?sort=new&offset=30');
    assert.equal(rest.body.posts.length, 4);
    assert.equal(rest.body.more, false);
  });

  it('is only for a forum', async () => {
    assert.equal((await api(`/api/channels/${text}/posts`, { token: tokens.ann })).status, 404);
  });
});

describe('deleting', () => {
  it('a post takes its answers with it, and tells the readers which', async () => {
    const root = (await post(tokens.ann, forum, { title: 'Doomed', body: 'soon gone' })).body.message;
    const one = (await post(tokens.bob, forum, { threadId: root.id, body: 'an answer' })).body.message;
    const two = (await post(tokens.boss, forum, { threadId: root.id, body: 'another' })).body.message;
    assert.equal((await api(`/api/messages/${root.id}/delete`, { method: 'POST', token: tokens.ann })).status, 200);
    const told = await bob.next((m) => m.type === 'message:deleted' && m.id === root.id);
    assert.deepEqual([told.post, [...told.answers].sort()], [true, [one.id, two.id].sort()]);
    for (const id of [one.id, two.id]) assert.equal((await api(`/api/messages/${id}/react`, { method: 'POST', token: tokens.bob, body: { emoji: 'x' } })).status, 404);
    const found = await api('/api/search?q=another', { token: tokens.ann });
    assert.equal(found.body.total, 0, 'and the search index let them go');
  });

  it('an answer goes alone, and says whose it was', async () => {
    const root = (await post(tokens.ann, forum, { title: 'Stays', body: 'stays' })).body.message;
    const reply = (await post(tokens.bob, forum, { threadId: root.id, body: 'goes' })).body.message;
    assert.equal((await api(`/api/messages/${reply.id}/delete`, { method: 'POST', token: tokens.bob })).status, 200);
    const told = await ann.next((m) => m.type === 'message:deleted' && m.id === reply.id);
    assert.equal(told.threadId, root.id);
    const thread = await api(`/api/channels/${forum}/messages?thread=${root.id}`, { token: tokens.ann });
    assert.deepEqual(thread.body.messages.map((m) => m.body), ['stays']);
  });
});

describe('pinning posts', () => {
  let pinForum;
  let one;
  let two;
  let three;
  let pinner;
  before(async () => {
    pinForum = (await api('/api/channels', { method: 'POST', token: tokens.boss, body: { kind: 'forum', name: 'pins' } })).body.channel.id;
    const make = async (title) => (await post(tokens.ann, pinForum, { title, body: `about ${title}` })).body.message;
    one = await make('One');
    two = await make('Two');
    three = await make('Three');
    // A role that may pin posts, and one that may delete them, held by two people.
    const role = (await api('/api/roles', { method: 'POST', token: tokens.boss, body: { name: 'Keeper', permissions: ['posts.pin'] } })).body.role;
    await api(`/api/accounts/${ids.bob}/roles`, { method: 'POST', token: tokens.boss, body: { roles: [role.id] } });
    pinner = tokens.bob;
  });
  const order = async (query = '?sort=new') => (await api(`/api/channels/${pinForum}/posts${query}`, { token: tokens.ann })).body.posts.map((p) => p.message.title);
  const pin = (token, id, pinned = true) => api(`/api/messages/${id}/post-pin`, { method: 'POST', token, body: { pinned } });

  it('is for admins and people whose role says so, and nobody else -- not even the post\'s author', async () => {
    assert.equal((await pin(tokens.ann, one.id)).status, 403, 'the author');
    assert.equal((await pin(tokens.boss, one.id)).status, 200, 'the owner');
    assert.equal((await pin(pinner, two.id)).status, 200, 'a role with posts.pin');
    assert.equal((await pin(tokens.ann, one.id, false)).status, 403, 'unpinning is the same act');
  });

  it('puts the one pinned last first, and the rest below in the order they follow', async () => {
    // one was pinned before two: two is on top; three (made last) follows the pinned.
    assert.deepEqual(await order(), ['Two', 'One', 'Three']);
    assert.deepEqual(await order('?sort=activity'), ['Two', 'One', 'Three']);
    await pin(tokens.boss, three.id);
    assert.deepEqual(await order(), ['Three', 'Two', 'One']);
    await pin(tokens.boss, one.id, false);
    assert.deepEqual(await order(), ['Three', 'Two', 'One'], 'one is unpinned, and is the oldest of what is below');
    await pin(tokens.boss, three.id, false);
    await pin(tokens.boss, two.id, false);
    assert.deepEqual(await order(), ['Three', 'Two', 'One'], 'nothing pinned: newest first');
  });

  it('is told to everybody as an update, with when it was pinned', async () => {
    await pin(tokens.boss, one.id);
    const told = await bob.next((m) => m.type === 'message:updated' && m.message.id === one.id && m.message.postPinnedAt);
    assert.equal(typeof told.message.postPinnedAt, 'number');
    assert.equal((await api(`/api/channels/${pinForum}/posts`, { token: tokens.ann })).body.posts[0].message.postPinnedAt > 0, true);
  });

  it('is only for a post, and a message pinned in a thread is another pin', async () => {
    const reply = (await post(tokens.bob, pinForum, { threadId: one.id, body: 'an answer' })).body.message;
    assert.equal((await pin(tokens.boss, reply.id)).status, 404);
    assert.equal((await api(`/api/messages/${one.id}/pin`, { method: 'POST', token: tokens.boss, body: { pinned: true } })).status, 200);
    const thread = await api(`/api/channels/${pinForum}/messages?thread=${one.id}`, { token: tokens.ann });
    assert.deepEqual(thread.body.pinned.map((m) => m.id), [one.id]);
    await api(`/api/messages/${one.id}/pin`, { method: 'POST', token: tokens.boss, body: { pinned: false } });
    assert.equal((await order('?sort=new'))[0], 'One', 'still pinned to the top');
  });
});

describe('who can delete a post, and what goes with it', () => {
  let keeper;
  const upload = async (token, bytes) => {
    const res = await fetch(`${s.BASE}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` }, body: bytes,
    });
    return (await res.json()).hash;
  };
  const stored = (hash) => {
    const db = new DatabaseSync(resolve(s.dataDir, 'harmony.db'), { readOnly: true });
    try { return db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE hash = ?').get(hash).n; } finally { db.close(); }
  };
  const del = (token, id) => api(`/api/messages/${id}/delete`, { method: 'POST', token });
  before(async () => {
    const role = (await api('/api/roles', { method: 'POST', token: tokens.boss, body: { name: 'Janitor', permissions: ['posts.delete'] } })).body.role;
    keeper = (await api('/api/accounts/register', { method: 'POST', body: { nickname: 'dee', password: 'hunter22' } })).body;
    await api(`/api/accounts/${keeper.user.id}/roles`, { method: 'POST', token: tokens.boss, body: { roles: [role.id] } });
  });

  it('is the author\'s to delete, an admin\'s, or that of a role with the permission; nobody else\'s', async () => {
    const mine = (await post(tokens.ann, forum, { title: 'Mine', body: 'x' })).body.message;
    assert.equal((await del(tokens.bob, mine.id)).status, 403, 'another member');
    assert.equal((await del(keeper.token, mine.id)).status, 200, 'a role with posts.delete');
    const own = (await post(tokens.bob, forum, { title: 'Own', body: 'x' })).body.message;
    assert.equal((await del(tokens.bob, own.id)).status, 200, 'the author');
    const other = (await post(tokens.ann, forum, { title: 'Other', body: 'x' })).body.message;
    assert.equal((await del(tokens.boss, other.id)).status, 200, 'the owner');
  });

  it('is not made deletable by the permission to delete messages', async () => {
    const role = (await api('/api/roles', { method: 'POST', token: tokens.boss, body: { name: 'Tidy', permissions: ['messages.delete'] } })).body.role;
    const tidy = (await api('/api/accounts/register', { method: 'POST', body: { nickname: 'fay', password: 'hunter22' } })).body;
    await api(`/api/accounts/${tidy.user.id}/roles`, { method: 'POST', token: tokens.boss, body: { roles: [role.id] } });
    const mine = (await post(tokens.ann, forum, { title: 'Thread', body: 'x' })).body.message;
    const answer = (await post(tokens.bob, forum, { threadId: mine.id, body: 'an answer' })).body.message;
    assert.equal((await del(tidy.token, mine.id)).status, 403, 'a post needs posts.delete');
    assert.equal((await del(tidy.token, answer.id)).status, 200, 'an answer is a message');
  });

  it('takes every answer, vote, reaction and file with it, and the files are gone from the disk', async () => {
    const cover = await upload(tokens.ann, Buffer.from('cover of the post'));
    const extra = await upload(tokens.bob, Buffer.from('a picture in an answer'));
    const shared = await upload(tokens.bob, Buffer.from('a picture sent twice'));
    const root = (await post(tokens.ann, forum, { title: 'With files', body: 'look', attachmentHash: cover, attachmentName: 'cover.png' })).body.message;
    await post(tokens.bob, forum, { threadId: root.id, body: 'mine', attachmentHash: extra, attachmentName: 'extra.png' });
    await post(tokens.bob, forum, { threadId: root.id, body: 'same file', attachmentHash: shared, attachmentName: 'shared.png' });
    // The same file is also in a text channel: that message still needs it.
    await post(tokens.bob, text, { body: 'elsewhere', attachmentHash: shared, attachmentName: 'shared.png' });
    const poll = (await post(tokens.bob, forum, { threadId: root.id, poll: { title: 'ok?', options: ['y', 'n'] } })).body.message;
    await api(`/api/messages/${poll.id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [0] } });
    await api(`/api/messages/${root.id}/react`, { method: 'POST', token: tokens.bob, body: { emoji: '\u{1F44D}' } });
    assert.deepEqual([stored(cover), stored(extra), stored(shared)], [1, 1, 1]);
    assert.equal((await del(tokens.ann, root.id)).status, 200);
    assert.deepEqual([stored(cover), stored(extra)], [0, 0], 'the files of the post and its answers are gone');
    assert.equal(stored(shared), 1, 'one that another message still holds is kept');
    const db = new DatabaseSync(resolve(s.dataDir, 'harmony.db'), { readOnly: true });
    try {
      const left = (table, column, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;
      assert.equal(left('messages', 'thread_id', root.id), 0);
      assert.equal(left('poll_votes', 'message_id', poll.id), 0);
      assert.equal(left('message_reactions', 'message_id', root.id), 0);
    } finally {
      db.close();
    }
  });
});

describe('mentions in a forum', () => {
  let mentionForum;
  let mentionRole;
  const list = async (token, query = '') => (await api(`/api/channels/${mentionForum}/posts${query}`, { token })).body.posts;
  before(async () => {
    mentionForum = (await api('/api/channels', { method: 'POST', token: tokens.boss, body: { kind: 'forum', name: 'mentions' } })).body.channel.id;
    mentionRole = (await api('/api/roles', { method: 'POST', token: tokens.boss, body: { name: 'Translators', permissions: [] } })).body.role;
    await api(`/api/accounts/${ids.bob}/roles`, { method: 'POST', token: tokens.boss, body: { roles: [mentionRole.id] } });
    const p = (title, body, token = tokens.boss) => post(token, mentionForum, { title, body });
    await p('By name', 'hello @bob, a question for you');
    await p('By role', 'attention @translators please');
    await p('For everybody', '@everyone read this');
    await p('For ann', 'only @ann here');
    await p('Nobody', 'no mentions, an email@example.com is not one');
    const quiet = (await p('Answered', 'plain words')).body.message;
    await post(tokens.ann, mentionForum, { threadId: quiet.id, body: 'hey @bob, over here' });
    await post(tokens.ann, mentionForum, { threadId: quiet.id, body: 'and again @bob' });
  });
  const titles = (posts) => posts.map((p) => p.message.title).sort();

  it('says how many messages in each post mention the person asking, the post\'s own and its answers', async () => {
    const posts = await list(tokens.bob);
    const counts = Object.fromEntries(posts.map((p) => [p.message.title, p.mentionCount]));
    assert.deepEqual(counts, {
      'By name': 1, 'By role': 1, 'For everybody': 1, 'For ann': 0, Nobody: 0, Answered: 2,
    }, 'by name, through a role they hold, with @everyone, and in answers');
  });

  it('is different for each person: the role is only bob\'s', async () => {
    const counts = Object.fromEntries((await list(tokens.ann)).map((p) => [p.message.title, p.mentionCount]));
    assert.deepEqual(counts, {
      'By name': 0, 'By role': 0, 'For everybody': 1, 'For ann': 1, Nobody: 0, Answered: 0,
    });
  });

  it('is not counted for what somebody wrote themselves', async () => {
    const own = (await post(tokens.bob, mentionForum, { title: 'Self', body: 'note to @bob' })).body.message;
    assert.equal((await list(tokens.bob)).find((p) => p.message.id === own.id).mentionCount, 0);
  });

  it('can be asked for alone: only the posts that mention the person', async () => {
    assert.deepEqual(titles(await list(tokens.bob, '?mentions=1')), ['Answered', 'By name', 'By role', 'For everybody']);
    assert.deepEqual(titles(await list(tokens.ann, '?mentions=1')), ['For ann', 'For everybody'].sort());
    assert.deepEqual(titles(await list(tokens.bob, '?mentions=1&q=role')), ['By role']);
  });

  it('is nothing for a person nobody mentioned, and the filter is empty then', async () => {
    assert.deepEqual(await list(tokens.boss, '?mentions=1'), []);
  });
});
