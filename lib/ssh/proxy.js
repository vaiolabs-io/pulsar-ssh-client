// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Reaching a host through another host: ProxyJump and ProxyCommand.
//
// Both end in the same place. ssh2 accepts a `sock` option -- any duplex
// stream carrying the TCP connection to the target -- so a jump host's
// forwarded channel and a proxy process's stdio are interchangeable.

const cp = require('child_process');
const stream = require('stream');

const logger = require('../logger');

/**
 * Split a ProxyCommand string into argv the way OpenSSH does:
 * whitespace separates tokens, double quotes group one token, backslash
 * escapes the next character.
 *
 * ssh-config has returned ProxyCommand as a single string since v5, and
 * `[].concat(str)` wraps rather than splits -- so spawn() would get the whole
 * command line as the executable and fail with ENOENT.
 * (upstream issues #271 and #273)
 */
function splitProxyCommand(value) {
  if (Array.isArray(value)) { return value.slice(); }

  const argv = [];
  let current = '';
  let quoted = false;
  let hasToken = false;
  let i = 0;

  while (i < value.length) {
    const ch = value[i];

    if (ch === '\\' && i + 1 < value.length) {
      current += value[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      hasToken = true;
      i += 1;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (hasToken) { argv.push(current); current = ''; hasToken = false; }
      i += 1;
      continue;
    }

    current += ch;
    hasToken = true;
    i += 1;
  }

  if (hasToken) { argv.push(current); }
  return argv;
}

// OpenSSH's ProxyCommand tokens: %h target host, %n host as typed,
// %p port, %r remote username. See ssh_config(5) TOKENS.
function substituteTokens(arg, { hostname, originalHost, port, user }) {
  return arg
    .replace(/%h/g, hostname)
    .replace(/%n/g, originalHost)
    .replace(/%p/g, String(port))
    .replace(/%r/g, user || '')
    .replace(/%%/g, '%');
}

/**
 * Run a ProxyCommand and return its stdio as a duplex stream, plus the child
 * so the caller can kill it when the connection closes.
 */
function spawnProxyCommand(proxyCommand, tokens) {
  let argv = splitProxyCommand(proxyCommand).map(arg => substituteTokens(arg, tokens));
  let command = argv.shift();
  let options = {};

  // cmd.exe cannot run a .bat directly from spawn without a shell, and a
  // shell then re-parses the arguments -- so quote them back up.
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
    command = `"${command}"`;
    argv = argv.map(arg => arg.includes(' ') ? `"${arg}"` : arg);
    options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
  }

  logger.trace(`Spawning ProxyCommand: ${command} ${argv.join(' ')}`);

  const child = cp.spawn(command, argv, options);

  child.on('error', err => {
    logger.error(`ProxyCommand failed to start: ${err.message}`);
  });
  if (child.stderr) {
    child.stderr.on('data', data => {
      const text = String(data).trim();
      if (text) { logger.trace(`ProxyCommand: ${text}`); }
    });
  }

  return {
    socket: stream.Duplex.from({ readable: child.stdout, writable: child.stdin }),
    child
  };
}

/** Parse "ProxyJump a,b,c" into an ordered list of destinations. */
function parseProxyJump(value) {
  const SSHDestination = require('./ssh-destination');
  return String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => SSHDestination.parse(part));
}

module.exports = { splitProxyCommand, substituteTokens, spawnProxyCommand, parseProxyJump };
