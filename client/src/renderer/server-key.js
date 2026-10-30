// One name for one server, however it was typed.
//
// The same address is written with and without the scheme, with a trailing
// slash, in any case. Everything that is kept per server -- credentials, the
// connection, the media route -- is keyed by this, and main/api.js has the same
// function (credKey) so both sides agree on which server a key means.

/** 'Harmony.Example:8080/' -> 'http://harmony.example:8080' */
export function serverKeyOf(address) {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '').toLowerCase();
}

/** The segment of a media URL that names a server: the key, as base64url. */
export function serverSegment(address) {
  const bytes = new TextEncoder().encode(serverKeyOf(address));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
