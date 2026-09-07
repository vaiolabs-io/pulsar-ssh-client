// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Turns "what the user typed" plus "what ssh_config says" into the concrete
// settings one connection needs.

const os = require('os');

const { untildify } = require('./ssh-config');

const isWindows = process.platform === 'win32';
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

const DEFAULT_PREFERRED_AUTHENTICATIONS = ['publickey', 'password', 'keyboard-interactive'];

function isYes(value) {
  return String(value || 'no').toLowerCase() === 'yes';
}

function asArray(value) {
  if (value === undefined || value === null) { return []; }
  return Array.isArray(value) ? value : [value];
}

/** Where to find the ssh-agent, honouring IdentityAgent. */
function resolveAgentSock(hostConfig) {
  const configured = hostConfig.IdentityAgent
    || process.env.SSH_AUTH_SOCK
    || (isWindows ? WINDOWS_AGENT_PIPE : undefined);

  if (!configured) { return undefined; }
  // "IdentityAgent none" explicitly disables the agent.
  if (String(configured).toLowerCase() === 'none') { return undefined; }

  return untildify(String(configured));
}

/**
 * Resolve one hop.
 *
 * `destination` is what the user typed; `hostConfig` is the computed
 * ssh_config block for it. Command-line style wins over config for user and
 * port, matching ssh(1); HostName always comes from config when set.
 *
 * `defaults` carries values inherited down a ProxyJump chain -- ssh applies
 * the final target's user and port to a jump host that does not name its own.
 */
function resolveHostConfig(destination, hostConfig, defaults = {}) {
  const config = hostConfig || {};

  // HostName may reference the name as typed via %h.
  const hostname = config.HostName
    ? String(config.HostName).replace(/%h/g, destination.hostname)
    : destination.hostname;

  // OpenSSH falls back to the local username.
  // sshconnect.c: options.user = xstrdup(pw->pw_name)
  const user = config.User
    || destination.user
    || defaults.user
    || os.userInfo().username
    || '';

  const port = config.Port
    ? parseInt(config.Port, 10)
    : (destination.port || defaults.port || 22);

  const preferredAuthentications = config.PreferredAuthentications
    ? String(config.PreferredAuthentications).split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_PREFERRED_AUTHENTICATIONS;

  return {
    // The name as typed, kept for known_hosts and for %n in a ProxyCommand.
    originalHost: destination.hostname,
    hostname,
    user,
    port,
    identityFiles: asArray(config.IdentityFile).map(String),
    identitiesOnly: isYes(config.IdentitiesOnly),
    forwardAgent: isYes(config.ForwardAgent),
    agentSock: resolveAgentSock(config),
    preferredAuthentications,
    proxyJump: config.ProxyJump ? String(config.ProxyJump) : undefined,
    proxyCommand: config.ProxyCommand,
    strictHostKeyChecking: config.StrictHostKeyChecking
      ? String(config.StrictHostKeyChecking).toLowerCase()
      : 'ask',
    connectTimeout: config.ConnectTimeout
      ? parseInt(config.ConnectTimeout, 10) * 1000
      : undefined
  };
}

module.exports = { resolveHostConfig, isYes, asArray, DEFAULT_PREFERRED_AUTHENTICATIONS };
