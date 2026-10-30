// One realtime connection per server.
//
// The app used to hold a single socket, for the one server it was signed in to.
// With a list of servers kept live at once there is one for each, and every frame
// they push says which server it came from, so whoever is listening can tell
// whose roster just changed.
//
// Requests name the server too: a mute sent to "the" connection would go to
// whichever server was connected last.

const { EventEmitter } = require('node:events');

const { credKey } = require('./api');
const { RealtimeClient } = require('./realtime');

class RealtimeHub extends EventEmitter {
  /** @type {Map<string, RealtimeClient>} */
  #clients = new Map();
  #Client;

  constructor(Client = RealtimeClient) {
    super();
    this.#Client = Client;
  }

  /** Connect to a server and keep connecting. Asking again for the same server and token is free. */
  connect(server, token) {
    const key = credKey(server);
    let client = this.#clients.get(key);
    if (!client) {
      client = new this.#Client();
      client.on('event', (payload) => this.emit('event', { ...payload, server: key }));
      this.#clients.set(key, client);
    }
    return client.connect(server, token);
  }

  request(server, type, payload) {
    const client = this.#clients.get(credKey(server));
    if (!client) return Promise.reject(new Error('Not connected to the server.'));
    return client.request(type, payload);
  }

  /** One server's connection, or every one when no server is named. */
  disconnect(server) {
    const keys = server === undefined || server === null ? [...this.#clients.keys()] : [credKey(server)];
    for (const key of keys) {
      this.#clients.get(key)?.disconnect();
      this.#clients.delete(key);
    }
  }

  connected(server) {
    return this.#clients.get(credKey(server))?.connected ?? false;
  }
}

module.exports = { RealtimeHub };
