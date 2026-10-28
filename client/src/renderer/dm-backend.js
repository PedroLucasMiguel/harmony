// Where a key file is kept: the settings, with the two secrets in it sealed by
// the system's keychain.
//
// One record per server and account, under `dmKeys` in the settings, so signing
// in as somebody else (or on another server) never reads or overwrites these.
// `harmony.secrets` seals a string with the operating system's keychain on a
// desktop, and with a plain marker where a page has none (the browser and
// Android builds, whose storage no other app can read); `reveal` answers an
// empty string for anything it cannot open this run, which is how a keychain
// that did not answer is told from a key that was never there.

/** The record's name: the server as the app keeps it, and the account's id on it. */
export const recordName = (server, userId) => `${String(server ?? '').trim().replace(/\/+$/, '').toLowerCase()}#${userId}`;

/**
 * @param {object} harmony  the bridge: settings and secrets
 * @param {string} server
 * @param {number} userId
 */
export function settingsBackend(harmony, server, userId) {
  const name = recordName(server, userId);
  return {
    async load() {
      const settings = await harmony.settings.get();
      return settings?.dmKeys?.[name] ?? null;
    },
    async save(record) {
      const settings = await harmony.settings.get();
      await harmony.settings.set({ dmKeys: { ...(settings?.dmKeys ?? {}), [name]: record } });
    },
    seal: (text) => harmony.secrets.protect(text),
    unseal: (sealed) => harmony.secrets.reveal(sealed),
  };
}
