// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Reads ~/.ssh/config and /etc/ssh/ssh_config, resolves Include, and answers
// "what settings apply to this host?".

const os = require('os');
const fs = require('fs');
const path = require('path');
// ssh-config v5 ships as ESM with a CommonJS wrapper: the class is the
// default export, and DIRECTIVE is a static on it, not on the namespace.
const sshConfigModule = require('ssh-config');
const SSHConfig = sshConfigModule.default || sshConfigModule;
const { glob } = require('./glob');

const isWindows = process.platform === 'win32';

const systemSSHConfig = isWindows
  ? path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh', 'ssh_config')
  : '/etc/ssh/ssh_config';

const defaultSSHConfigPath = path.resolve(os.homedir(), '.ssh', 'config');

function untildify(value) {
  return value.replace(/^~(?=$|\/|\\)/, os.homedir());
}

function getSSHConfigPath() {
  const configured = atom.config.get('pulsar-ssh-client.configFile');
  return configured ? untildify(configured) : defaultSSHConfigPath;
}

const isDirective = line => line.type === SSHConfig.DIRECTIVE;
const isHostSection = line => isDirective(line) && line.param === 'Host' && !!line.value && !!line.config;
const isIncludeDirective = line => isDirective(line) && line.param === 'Include' && !!line.value;

// ssh_config directives are case-insensitive; ssh-config's compute() is not.
const SSH_CONFIG_PROPERTIES = {
  host: 'Host',
  hostname: 'HostName',
  user: 'User',
  port: 'Port',
  identityagent: 'IdentityAgent',
  identitiesonly: 'IdentitiesOnly',
  identityfile: 'IdentityFile',
  forwardagent: 'ForwardAgent',
  preferredauthentications: 'PreferredAuthentications',
  proxyjump: 'ProxyJump',
  proxycommand: 'ProxyCommand',
  connecttimeout: 'ConnectTimeout',
  serveraliveinterval: 'ServerAliveInterval',
  stricthostkeychecking: 'StrictHostKeyChecking',
  userknownhostsfile: 'UserKnownHostsFile',
  include: 'Include'
};

function normalizeSSHConfig(config) {
  for (const line of config) {
    if (isDirective(line)) {
      line.param = SSH_CONFIG_PROPERTIES[line.param.toLowerCase()] || line.param;
    }
    if (isHostSection(line)) { normalizeSSHConfig(line.config); }
  }
  return config;
}

async function fileExists(filePath) {
  try { await fs.promises.access(filePath); return true; }
  catch { return false; }
}

async function resolveInclude(line, userConfig) {
  const baseDir = path.dirname(userConfig ? defaultSSHConfigPath : systemSSHConfig);
  const configs = [];

  for (const value of String(line.value).split(',').map(s => s.trim())) {
    for (const includePath of await glob(untildify(value), baseDir)) {
      configs.push(await parseSSHConfigFromFile(includePath, userConfig));
    }
  }
  return configs;
}

async function parseSSHConfigFromFile(filePath, userConfig) {
  let content = '';
  if (await fileExists(filePath)) {
    content = (await fs.promises.readFile(filePath, 'utf8')).trim();
  }
  const config = normalizeSSHConfig(SSHConfig.parse(content));

  const includedConfigs = [];
  for (let i = 0; i < config.length; i++) {
    const line = config[i];

    if (isIncludeDirective(line)) {
      includedConfigs.push([i, await resolveInclude(line, userConfig)]);
    } else if (isHostSection(line)) {
      // ssh config has no block terminator, so an `Include` written after a
      // `Host` block parses as a child of that block. ssh itself reads the file
      // linearly, so the included lines are siblings of the block, not children.
      // Without this, hosts declared in an included file are unreachable.
      const hoisted = [];
      for (let j = line.config.length - 1; j >= 0; j--) {
        const child = line.config[j];
        if (isIncludeDirective(child)) {
          hoisted.unshift(...await resolveInclude(child, userConfig));
          line.config.splice(j, 1);
        }
      }
      if (hoisted.length) { includedConfigs.push([i + 1, hoisted]); }
    }
  }

  // Reversed so earlier splices do not shift the indexes of later ones.
  for (const [index, configs] of includedConfigs.reverse()) {
    const deleteCount = index < config.length && isIncludeDirective(config[index]) ? 1 : 0;
    config.splice(index, deleteCount, ...configs.flat());
  }

  return config;
}

class SSHConfiguration {
  // Paths are injectable so specs can run against fixtures instead of the
  // machine's real ssh_config, which on a systemd host declares its own hosts.
  static async loadFromFS({ userConfigPath, systemConfigPath } = {}) {
    const config = await parseSSHConfigFromFile(userConfigPath || getSSHConfigPath(), true);
    config.push(...await parseSSHConfigFromFile(
      systemConfigPath === undefined ? systemSSHConfig : systemConfigPath, false));
    return new SSHConfiguration(config);
  }

  constructor(sshConfig) {
    this.sshConfig = sshConfig;
  }

  // Every concrete host name the user could connect to. Patterns such as
  // `Host *` or `Host !bad` configure other hosts; they are not destinations.
  getAllConfiguredHosts() {
    const hosts = new Set();
    for (const line of this.sshConfig) {
      if (!isHostSection(line)) { continue; }

      // One `Host` line may declare several names sharing the block.
      const values = Array.isArray(line.value) ? line.value.map(v => v.val) : [line.value];
      for (const value of values) {
        if (!/^!/.test(value) && !/[?*]/.test(value)) { hosts.add(value); }
      }
    }
    return [...hosts];
  }

  getHostConfiguration(host) {
    return this.sshConfig.compute(host) || {};
  }
}

module.exports = { SSHConfiguration, getSSHConfigPath, untildify, defaultSSHConfigPath, systemSSHConfig };
