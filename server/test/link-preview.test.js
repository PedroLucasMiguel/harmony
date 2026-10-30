import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  LinkPreviews, fetchLimited, isBlockedAddress, normalise, parseMeta, sniffImage, youtubeVideo,
} from '../src/link-preview.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('which addresses may be read', () => {
  it('refuses what is inside a network', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::7f00:1',
    ]) assert.equal(isBlockedAddress(address), true, address);
  });

  it('allows what is on the internet', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isBlockedAddress(address), false, address);
    }
  });

  it('refuses what is not an address at all', () => {
    assert.equal(isBlockedAddress('not an address'), true);
  });
});

describe('the address in a message', () => {
  it('is an http or https address, without a password, and without its fragment', () => {
    assert.equal(normalise('https://example.com/a?b=1#top'), 'https://example.com/a?b=1');
    assert.equal(normalise('ftp://example.com/'), null);
    assert.equal(normalise('javascript:alert(1)'), null);
    assert.equal(normalise('https://user:secret@example.com/'), null);
    assert.equal(normalise('not a url'), null);
    assert.equal(normalise(`https://example.com/${'a'.repeat(3000)}`), null);
  });
});

describe('reading a page', () => {
  it('takes the open graph tags, and decodes what they say', () => {
    const html = `<html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Guia LORD KNIGHT &amp; mais &#233; &#x41;">
      <meta property="og:description" content='Line one
        and two'>
      <meta property="og:site_name" content="YouTube">
      <meta property="og:image" content="/img/thumb.jpg?x=1&amp;y=2">
      <meta name="theme-color" content="#FF0000">
      <meta property="og:type" content="video.other">
    </head></html>`;
    const meta = parseMeta(html, 'https://www.example.com/watch?v=1');
    assert.equal(meta.title, 'Guia LORD KNIGHT & mais é A');
    assert.equal(meta.description, 'Line one and two');
    assert.equal(meta.site, 'YouTube');
    assert.equal(meta.image, 'https://www.example.com/img/thumb.jpg?x=1&y=2');
    assert.equal(meta.color, '#ff0000');
    assert.equal(meta.kind, 'video.other');
  });

  it('falls back to twitter tags, then to the title and the host', () => {
    const meta = parseMeta('<meta name="twitter:title" content="T"><meta name="twitter:image" content="https://cdn.example.org/a.png">', 'https://www.news.example.org/x');
    assert.equal(meta.title, 'T');
    assert.equal(meta.image, 'https://cdn.example.org/a.png');
    assert.equal(meta.site, 'news.example.org');
    const plain = parseMeta('<title> Just a title </title>', 'https://example.com/');
    assert.equal(plain.title, 'Just a title');
    assert.equal(plain.image, null);
  });

  it('says nothing for a page that says nothing, and ignores scripts and comments', () => {
    assert.equal(parseMeta('<html><body>hello</body></html>', 'https://example.com/'), null);
    const tricky = parseMeta('<!-- <meta property="og:title" content="in a comment"> --><script>var a = \'<meta property="og:title" content="in a script">\';</script><meta property="og:title" content="real">', 'https://example.com/');
    assert.equal(tricky.title, 'real');
  });

  it('keeps only addresses that can be opened for the picture, and colours that are colours', () => {
    const meta = parseMeta('<meta property="og:title" content="x"><meta property="og:image" content="javascript:alert(1)"><meta name="theme-color" content="red; background:url(x)">', 'https://example.com/');
    assert.equal(meta.image, null);
    assert.equal(meta.color, null);
  });

  it('cuts what is too long', () => {
    const meta = parseMeta(`<meta property="og:title" content="${'a'.repeat(500)}">`, 'https://example.com/');
    assert.ok(meta.title.length <= 200 && meta.title.endsWith('…'));
  });
});

describe('a YouTube address', () => {
  it('is known in all its spellings, and nothing else is', () => {
    const id = 'naNpAAdfmzs';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=30s`, `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}`, `https://www.youtube.com/embed/${id}`,
    ]) assert.equal(youtubeVideo(url), id, url);
    for (const url of [
      'https://www.youtube.com/', 'https://www.youtube.com/@someone', 'https://www.youtube.com/watch?v=short',
      'https://notyoutube.com/watch?v=naNpAAdfmzs', 'https://youtube.com.evil.example/watch?v=naNpAAdfmzs', 'not a url',
    ]) assert.equal(youtubeVideo(url), null, url);
  });
});

describe('what a picture is', () => {
  it('is known by its first bytes, not by what a server says', () => {
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg');
    assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
    assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(sniffImage(Buffer.from('<html></html>')), null);
  });
});

describe('fetching, and the service built on it', () => {
  let server;
  let base;
  const hits = new Map();
  const count = (path) => hits.set(path, (hits.get(path) ?? 0) + 1);

  before(async () => {
    server = http.createServer((req, res) => {
      count(req.url);
      const send = (status, type, body, headers = {}) => {
        res.writeHead(status, { 'Content-Type': type, ...headers });
        res.end(body);
      };
      switch (req.url) {
        case '/page':
          return send(200, 'text/html; charset=utf-8', `<meta property="og:title" content="A page"><meta property="og:description" content="About it"><meta property="og:image" content="${base}/pic.png">`);
        case '/pic.png':
          return send(200, 'image/png', PNG);
        case '/fake-pic.png':
          return send(200, 'image/png', '<html>not a picture</html>');
        case '/page-fake-pic':
          return send(200, 'text/html', `<meta property="og:title" content="Fake"><meta property="og:image" content="${base}/fake-pic.png">`);
        case '/late-head':
          // What YouTube does: a megabyte of script before the tags, and a long page after them.
          return send(200, 'text/html', `<head><script>${'x'.repeat(1_200_000)}</script><meta property="og:title" content="Late tags"></head><body>${'y'.repeat(1_500_000)}</body>`);
        case '/gzip':
          return send(200, 'text/html', zlib.gzipSync('<meta property="og:title" content="Zipped">'), { 'Content-Encoding': 'gzip' });
        case '/bomb':
          return send(200, 'text/html', zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20)), { 'Content-Encoding': 'gzip' });
        case '/huge':
          return send(200, 'text/html', `<meta property="og:title" content="Head">${' '.repeat(2 * 1024 * 1024)}`);
        case '/redirect':
          return send(302, 'text/plain', '', { Location: '/page' });
        case '/loop':
          return send(302, 'text/plain', '', { Location: '/loop' });
        case '/json':
          return send(200, 'application/json', '{"og:title":"x"}');
        case '/missing':
          return send(404, 'text/html', '<meta property="og:title" content="Not found page">');
        case '/direct.png':
          return send(200, 'image/png', PNG);
        case '/slow':
          return undefined;
        default:
          return send(404, 'text/plain', 'no');
      }
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const fakeChat = () => {
    const files = new Map();
    return {
      files,
      store(bytes, type) {
        const hash = createHash('sha256').update(bytes).digest('hex');
        files.set(hash, { hash, content_type: type, bytes: bytes.length });
        return { ok: true, upload: files.get(hash) };
      },
      fileInfo: (hash) => files.get(hash) ?? null,
    };
  };

  it('will not read an address on this computer unless told to', async () => {
    await assert.rejects(fetchLimited(`${base}/page`), /not allowed/);
    await assert.rejects(fetchLimited('http://localhost:1/'), /not allowed|ECONNREFUSED|ENOTFOUND/);
    await assert.rejects(fetchLimited('http://[::1]:1/'), /not allowed/);
    await assert.rejects(fetchLimited('http://user:pw@example.com/'), /password/);
    await assert.rejects(fetchLimited('file:///etc/passwd'), /not a web address/);
    assert.equal(await new LinkPreviews(fakeChat()).get(`${base}/page`), null);
  });

  it('follows a few redirects and not forever', async () => {
    const page = await fetchLimited(`${base}/redirect`, { allowPrivate: true });
    assert.equal(page.status, 200);
    assert.equal(page.url, `${base}/page`);
    await assert.rejects(fetchLimited(`${base}/loop`, { allowPrivate: true }), /too many redirects/);
  });

  it('unpacks what is compressed, and stops at the size it was given', async () => {
    assert.match((await fetchLimited(`${base}/gzip`, { allowPrivate: true })).body.toString(), /Zipped/);
    const bomb = await fetchLimited(`${base}/bomb`, { allowPrivate: true, maxBytes: 100_000 });
    assert.equal(bomb.truncated, true);
    assert.ok(bomb.body.length <= 100_000);
    const huge = await fetchLimited(`${base}/huge`, { allowPrivate: true, maxBytes: 64 * 1024 });
    assert.equal(huge.body.length, 64 * 1024);
  });

  it('finds the tags of a page that puts a megabyte of script before them, and stops at the end of the head', async () => {
    const page = await fetchLimited(`${base}/late-head`, { allowPrivate: true, stopAt: '</head>' });
    assert.equal(page.truncated, false);
    assert.ok(page.body.length < 1_500_000, `read only the head: ${page.body.length}`);
    assert.equal(parseMeta(page.body.toString('utf8'), page.url).title, 'Late tags');
    const card = await new LinkPreviews(fakeChat(), { allowPrivate: true }).get(`${base}/late-head`);
    assert.equal(card.title, 'Late tags');
  });

  it('makes a card of a page, keeping its picture as a file', async () => {
    const chat = fakeChat();
    const previews = new LinkPreviews(chat, { allowPrivate: true });
    const card = await previews.get(`${base}/page`);
    assert.equal(card.title, 'A page');
    assert.equal(card.description, 'About it');
    assert.ok(card.imageHash && chat.files.get(card.imageHash).content_type === 'image/png');
    assert.equal(card.url, `${base}/page`);
  });

  it('asks a page once, however many times it is shown', async () => {
    const chat = fakeChat();
    const previews = new LinkPreviews(chat, { allowPrivate: true });
    hits.clear();
    const all = await Promise.all([1, 2, 3, 4].map(() => previews.get(`${base}/page#a`)));
    await previews.get(`${base}/page`);
    assert.equal(hits.get('/page'), 1);
    assert.ok(all.every((c) => c.title === 'A page'));
  });

  it('makes the card again when its picture has been swept to make room', async () => {
    const chat = fakeChat();
    const previews = new LinkPreviews(chat, { allowPrivate: true });
    const first = await previews.get(`${base}/page`);
    chat.files.delete(first.imageHash);
    hits.clear();
    const again = await previews.get(`${base}/page`);
    assert.equal(again.imageHash, first.imageHash);
    assert.equal(hits.get('/page'), 1);
    assert.ok(chat.files.has(again.imageHash));
  });

  it('shows a card without the picture when the picture is not one', async () => {
    const chat = fakeChat();
    const card = await new LinkPreviews(chat, { allowPrivate: true }).get(`${base}/page-fake-pic`);
    assert.equal(card.title, 'Fake');
    assert.equal(card.imageHash, null);
    assert.equal(chat.files.size, 0);
  });

  it('shows nothing for what is not a page', async () => {
    const previews = new LinkPreviews(fakeChat(), { allowPrivate: true });
    assert.equal(await previews.get(`${base}/json`), null);
    assert.equal(await previews.get(`${base}/missing`), null);
    assert.equal(await previews.get(`${base}/nothing-here`), null);
    assert.equal(await previews.get('ftp://example.com/'), null);
  });

  it('does not ask a dead link again straight away', async () => {
    const previews = new LinkPreviews(fakeChat(), { allowPrivate: true });
    hits.clear();
    await previews.get(`${base}/missing`);
    await previews.get(`${base}/missing`);
    assert.equal(hits.get('/missing'), 1);
  });

  it('shows a link to a picture as the picture', async () => {
    const chat = fakeChat();
    const card = await new LinkPreviews(chat, { allowPrivate: true }).get(`${base}/direct.png`);
    assert.equal(card.kind, 'image');
    assert.ok(chat.files.has(card.imageHash));
  });
});
