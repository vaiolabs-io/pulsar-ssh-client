// Keeps one connection per host and hands it out.
//
// Opening a second connection to the same host would mean authenticating
// twice, which on a 2FA host means asking the user for a second code. So
// connections are shared, and connecting is deduplicated: ten files opened at
// once produce one connection attempt, not ten.

const { Emitter } = require('atom');

const logger = require('./logger');
const SSHDestination = require('./ssh/ssh-destination');
const { SSHConnection } = require('./ssh/connection');

class ConnectionManager {
  constructor() {
    this.connections = new Map();  // "user@host:port" -> SSHConnection
    this.pending = new Map();      // same key -> Promise, while connecting
    this.emitter = new Emitter();
  }

  keyFor(destination) {
    const dest = typeof destination === 'string'
      ? SSHDestination.parse(destination)
      : destination;
    return dest.toString();
  }

  get(destination) {
    return this.connections.get(this.keyFor(destination)) || null;
  }

  isConnected(destination) {
    const connection = this.get(destination);
    return Boolean(connection && connection.connected);
  }

  getConnections() {
    return [...this.connections.values()];
  }

  /**
   * Connect, or return the existing connection.
   *
   * Concurrent callers share one attempt -- otherwise opening a project with
   * several remote files queues several password prompts.
   */
  async connect(destination) {
    const key = this.keyFor(destination);

    const existing = this.connections.get(key);
    if (existing && existing.connected) { return existing; }

    const inFlight = this.pending.get(key);
    if (inFlight) { return inFlight; }

    const dest = typeof destination === 'string'
      ? SSHDestination.parse(destination)
      : destination;
    const connection = new SSHConnection(dest);

    const attempt = connection.connect()
      .then(() => {
        this.pending.delete(key);
        this.connections.set(key, connection);

        connection.once('closed', () => this.forget(key));
        connection.on('error', err => this.emitter.emit('did-error', { connection, error: err }));

        this.emitter.emit('did-connect', connection);
        this.emitter.emit('did-change');
        return connection;
      })
      .catch(err => {
        this.pending.delete(key);
        logger.error(`Could not connect to ${key}: ${err.message}`);
        throw err;
      });

    this.pending.set(key, attempt);
    return attempt;
  }

  forget(key) {
    const connection = this.connections.get(key);
    if (!connection) { return; }

    this.connections.delete(key);
    this.emitter.emit('did-disconnect', connection);
    this.emitter.emit('did-change');
  }

  disconnect(destination) {
    const key = this.keyFor(destination);
    const connection = this.connections.get(key);
    if (!connection) { return; }

    logger.info(`Disconnecting from ${key}`);
    connection.close();
    this.forget(key);
  }

  disconnectAll() {
    for (const key of [...this.connections.keys()]) { this.disconnect(key); }
  }

  onDidConnect(callback) { return this.emitter.on('did-connect', callback); }
  onDidDisconnect(callback) { return this.emitter.on('did-disconnect', callback); }
  onDidChange(callback) { return this.emitter.on('did-change', callback); }
  onDidError(callback) { return this.emitter.on('did-error', callback); }

  dispose() {
    this.disconnectAll();
    this.emitter.dispose();
  }
}

module.exports = new ConnectionManager();
