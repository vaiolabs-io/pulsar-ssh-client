// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// One SSH connection to one host, plus the SFTP channel we do all file work on.
//
// Two things upstream leaves out, added here because upstream leans on VS Code
// core to cover them and Pulsar has no equivalent:
//   - host keys are actually verified (upstream ships the code, never calls it)
//   - keepalives are on, so a dead NAT mapping surfaces as an error rather
//     than a permanently hung editor

const { EventEmitter } = require('events');
const ssh2 = require('ssh2');

const logger = require('../logger');
const SSHDestination = require('./ssh-destination');
const { SSHConfiguration } = require('./ssh-config');
const { resolveHostConfig } = require('./host-config');
const { gatherIdentityFiles } = require('./identity-files');
const { createAuthHandler } = require('./auth');
const { spawnProxyCommand, parseProxyJump } = require('./proxy');
const knownHosts = require('./known-hosts');
const { promptForChoice } = require('../ui/prompt');

const DEFAULT_CONNECT_TIMEOUT_MS = 60000;
const DEFAULT_KEEPALIVE_MS = 15000;
const KEEPALIVE_COUNT_MAX = 3;

// An SSH public key blob starts with its own type name, length-prefixed.
function keyTypeOf(keyBuffer) {
  try {
    const length = keyBuffer.readUInt32BE(0);
    return keyBuffer.slice(4, 4 + length).toString('ascii');
  } catch {
    return 'unknown';
  }
}

/**
 * Ask the user what to do about a host key we do not already trust.
 * Returns true to continue.
 */
async function confirmHostKey(status, { hostname, port, keyType, fingerprint, hostKey }) {
  const address = knownHosts.hostAddress(hostname, port);

  if (status === 'changed') {
    // Never offer a one-click "trust it anyway" here. A changed key is either
    // a rebuilt server or someone sitting in the middle, and the two are
    // indistinguishable from this side.
    const choice = await promptForChoice({
      message: `The host key for ${address} has CHANGED.`,
      detail: [
        `${keyType} ${fingerprint}`,
        '',
        'This is what a machine-in-the-middle attack looks like. It is also',
        'what a rebuilt or reinstalled server looks like.',
        '',
        'If you did not expect this, do not continue. To accept a key you',
        'know is genuine, remove the old entry yourself:',
        `  ssh-keygen -R '${address}'`
      ].join('\n'),
      choices: [
        { label: 'Cancel', value: false },
        { label: 'Connect once anyway', value: true, className: 'btn-error' }
      ]
    });
    return choice === true;
  }

  if (status === 'revoked') {
    atom.notifications.addError('SSH host key revoked', {
      description: `The key offered by ${address} is marked @revoked in known_hosts. Refusing to connect.`,
      dismissable: true
    });
    return false;
  }

  const choice = await promptForChoice({
    message: `${address} is not in your known_hosts.`,
    detail: `${keyType} key fingerprint is\n${fingerprint}`,
    choices: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Connect once', value: 'once' },
      { label: 'Trust and remember', value: 'remember', className: 'btn-primary' }
    ]
  });

  if (choice === 'remember') {
    await knownHosts.addHostKey(hostname, port, keyType, hostKey);
    logger.info(`Added ${address} to known_hosts`);
    return true;
  }
  return choice === 'once';
}

class SSHConnection extends EventEmitter {
  constructor(destination) {
    super();
    this.destination = typeof destination === 'string'
      ? SSHDestination.parse(destination)
      : destination;

    this.client = null;
    this.settings = null;
    this.sftpChannel = null;
    this.sftpPromise = null;
    this.homeDirectory = null;
    this.proxyChildren = [];
    this.proxyClients = [];
    this.closing = false;
    this.connected = false;
  }

  get name() { return this.destination.toString(); }

  /** Connect, resolving ssh_config and walking any ProxyJump chain first. */
  async connect() {
    if (this.connected) { return this; }

    const sshConfig = await SSHConfiguration.loadFromFS();
    const hostConfig = sshConfig.getHostConfiguration(this.destination.hostname);
    const settings = resolveHostConfig(this.destination, hostConfig);
    this.settings = settings;

    logger.info(`Connecting to ${settings.user}@${settings.hostname}:${settings.port}`);

    let socket;
    if (settings.proxyJump) {
      socket = await this.openProxyJumpChain(sshConfig, settings);
    } else if (settings.proxyCommand) {
      const { socket: proxySocket, child } = spawnProxyCommand(settings.proxyCommand, settings);
      this.proxyChildren.push(child);
      socket = proxySocket;
    }

    this.client = await this.openClient(settings, socket);
    this.connected = true;

    // The tree opens here when no directory is configured. Resolving it needs
    // the connection, so it happens now rather than at every listing.
    this.homeDirectory = await this.resolveHomeDirectory();

    this.emit('connected');
    logger.info(`Connected to ${this.name}, home is ${this.homeDirectory}`);
    return this;
  }

  /**
   * Walk "ProxyJump a,b" -- connect to a, forward through it to b, and hand
   * the last forwarded stream back as the socket for the real target.
   */
  async openProxyJumpChain(sshConfig, targetSettings) {
    const hops = parseProxyJump(targetSettings.proxyJump);
    let socket;

    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const hopSettings = resolveHostConfig(
        hop,
        sshConfig.getHostConfiguration(hop.hostname),
        // ssh applies the target's user and port to a hop that names neither.
        { user: targetSettings.user, port: targetSettings.port }
      );

      logger.info(`Jump host ${i + 1}/${hops.length}: ${hopSettings.user}@${hopSettings.hostname}:${hopSettings.port}`);

      const client = await this.openClient(hopSettings, socket);
      this.proxyClients.push(client);

      // The next link in the chain, or the real target if this is the last hop.
      const next = hops[i + 1];
      const nextSettings = next
        ? resolveHostConfig(next, sshConfig.getHostConfiguration(next.hostname),
          { user: targetSettings.user, port: targetSettings.port })
        : targetSettings;

      socket = await new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, nextSettings.hostname, nextSettings.port,
          (err, stream) => err ? reject(err) : resolve(stream));
      });
    }

    return socket;
  }

  /** Open one ssh2.Client with our auth handler and host verification. */
  async openClient(settings, socket) {
    const identityKeys = await gatherIdentityFiles(
      settings.identityFiles, settings.agentSock, settings.identitiesOnly);

    const authHandler = createAuthHandler({
      user: settings.user,
      hostname: settings.hostname,
      identityKeys,
      preferredAuthentications: settings.preferredAuthentications,
      agentSock: settings.agentSock
    });

    const connectTimeout = settings.connectTimeout
      || (atom.config.get('pulsar-ssh-client.connectTimeout') || 60) * 1000
      || DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const client = new ssh2.Client();

      const onError = (err) => {
        client.removeListener('ready', onReady);
        reject(err);
      };
      const onReady = () => {
        client.removeListener('error', onError);
        client.on('error', err => this.handleClientError(err));
        client.on('close', () => this.handleClientClose());
        resolve(client);
      };

      client.once('error', onError);
      client.once('ready', onReady);

      client.connect({
        host: socket ? undefined : settings.hostname,
        port: socket ? undefined : settings.port,
        sock: socket,
        username: settings.user,
        readyTimeout: connectTimeout,
        // Without these a dropped link looks like a hang, not an error.
        keepaliveInterval: DEFAULT_KEEPALIVE_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        // ssh2 auto-accepts every host key when this is absent.
        hostVerifier: (keyBuffer, verify) => {
          this.verifyHostKey(settings, keyBuffer).then(verify, err => {
            logger.error(`Host key check failed: ${err.message}`);
            verify(false);
          });
          return undefined; // answered asynchronously
        },
        agentForward: settings.forwardAgent,
        agent: settings.forwardAgent && settings.agentSock
          ? ssh2.createAgent(settings.agentSock)
          : undefined,
        authHandler: (methodsLeft, partialSuccess, callback) => {
          authHandler(methodsLeft, partialSuccess, callback);
          return undefined; // answered asynchronously
        }
      });
    });
  }

  async verifyHostKey(settings, keyBuffer) {
    const keyType = keyTypeOf(keyBuffer);
    const status = await knownHosts.checkHostKey(
      settings.originalHost, settings.port, keyType, keyBuffer);

    if (status === 'match') { return true; }

    // StrictHostKeyChecking no is the user telling us not to ask. Honour it
    // for an unknown host, but never for a key that has changed.
    if (status === 'unknown' && settings.strictHostKeyChecking === 'no') {
      logger.warn(`Accepting unknown host key for ${settings.originalHost} (StrictHostKeyChecking no)`);
      return true;
    }
    if (settings.strictHostKeyChecking === 'yes') {
      logger.error(`Refusing ${settings.originalHost}: host key ${status} and StrictHostKeyChecking is yes`);
      return false;
    }

    return confirmHostKey(status, {
      hostname: settings.originalHost,
      port: settings.port,
      keyType,
      hostKey: keyBuffer,
      fingerprint: knownHosts.fingerprint(keyBuffer)
    });
  }

  handleClientError(err) {
    logger.error(`${this.name}: ${err.message}`);
    this.emit('error', err);
  }

  handleClientClose() {
    if (this.closing) { return; }
    this.connected = false;
    this.sftpChannel = null;
    this.sftpPromise = null;
    logger.warn(`${this.name}: connection closed`);
    this.emit('closed');
  }

  /**
   * The SFTP channel, opened once and reused.
   *
   * sshd's MaxSessions caps channels per connection at 10 by default, and
   * every file operation would otherwise cost a channel setup round trip.
   */
  sftp() {
    if (this.sftpChannel) { return Promise.resolve(this.sftpChannel); }
    if (this.sftpPromise) { return this.sftpPromise; }

    this.sftpPromise = new Promise((resolve, reject) => {
      if (!this.client) { return reject(new Error(`Not connected to ${this.name}`)); }

      this.client.sftp((err, sftp) => {
        this.sftpPromise = null;
        if (err) { return reject(err); }

        this.sftpChannel = sftp;
        sftp.once('close', () => { this.sftpChannel = null; });
        resolve(sftp);
      });
    });

    return this.sftpPromise;
  }

  /**
   * The login directory, as an absolute path.
   *
   * SFTP resolves "." relative to wherever the server starts the session,
   * which is the user's home. Falls back to / rather than failing the
   * connection over it.
   */
  async resolveHomeDirectory() {
    try {
      const sftp = await this.sftp();
      return await new Promise((resolve, reject) => {
        sftp.realpath('.', (err, absolutePath) =>
          err ? reject(err) : resolve(absolutePath));
      });
    } catch (err) {
      logger.warn(`Could not resolve the home directory on ${this.name}: ${err.message}`);
      return '/';
    }
  }

  /** Open an interactive shell channel, for the terminal. */
  shell(options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) { return reject(new Error(`Not connected to ${this.name}`)); }
      this.client.shell(options, (err, stream) => err ? reject(err) : resolve(stream));
    });
  }

  /** Run one command and collect its output. */
  exec(command) {
    return new Promise((resolve, reject) => {
      if (!this.client) { return reject(new Error(`Not connected to ${this.name}`)); }

      this.client.exec(command, (err, stream) => {
        if (err) { return reject(err); }

        let stdout = '';
        let stderr = '';
        stream.on('data', data => { stdout += data; });
        stream.stderr.on('data', data => { stderr += data; });
        stream.on('close', code => resolve({ code, stdout, stderr }));
      });
    });
  }

  close() {
    this.closing = true;
    this.connected = false;

    if (this.sftpChannel) {
      try { this.sftpChannel.end(); } catch { /* already gone */ }
      this.sftpChannel = null;
    }
    if (this.client) {
      try { this.client.end(); } catch { /* already gone */ }
      this.client = null;
    }
    // Close the chain from the outside in; each hop carries the next.
    for (const client of this.proxyClients.reverse()) {
      try { client.end(); } catch { /* already gone */ }
    }
    this.proxyClients = [];

    for (const child of this.proxyChildren) {
      try { child.kill(); } catch { /* already gone */ }
    }
    this.proxyChildren = [];

    this.emit('closed');
    this.removeAllListeners();
  }
}

module.exports = { SSHConnection, keyTypeOf, confirmHostKey };
