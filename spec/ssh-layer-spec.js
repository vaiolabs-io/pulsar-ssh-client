const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SSHDestination = require('../lib/ssh/ssh-destination');
const { glob } = require('../lib/ssh/glob');
const { SSHConfiguration } = require('../lib/ssh/ssh-config');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-ssh-spec-'));
}

describe('SSHDestination', () => {
  it('parses user, host and port', () => {
    const dest = SSHDestination.parse('root@box:2222');
    expect(dest.user).toBe('root');
    expect(dest.hostname).toBe('box');
    expect(dest.port).toBe(2222);
  });

  it('parses a bare hostname', () => {
    const dest = SSHDestination.parse('box');
    expect(dest.hostname).toBe('box');
    expect(dest.user).toBeUndefined();
    expect(dest.port).toBeUndefined();
  });

  it('keeps an @ inside a username', () => {
    const dest = SSHDestination.parse('alex@vaiolabs.com@gateway');
    expect(dest.user).toBe('alex@vaiolabs.com');
    expect(dest.hostname).toBe('gateway');
  });

  it('round-trips through toString', () => {
    expect(SSHDestination.parse('root@box:2222').toString()).toBe('root@box:2222');
    expect(SSHDestination.parse('box').toString()).toBe('box');
  });

  it('builds and reparses an ssh:// URI', () => {
    const dest = SSHDestination.parse('root@box:2222');
    const uri = dest.toURI('/etc/hosts');
    expect(uri).toBe('ssh://root@box:2222/etc/hosts');

    const parsed = SSHDestination.fromURI(uri);
    expect(parsed.destination.hostname).toBe('box');
    expect(parsed.destination.user).toBe('root');
    expect(parsed.destination.port).toBe(2222);
    expect(parsed.path).toBe('/etc/hosts');
  });

  it('recognises remote URIs', () => {
    expect(SSHDestination.isRemoteURI('ssh://box/tmp')).toBe(true);
    expect(SSHDestination.isRemoteURI('/tmp/local')).toBe(false);
    expect(SSHDestination.fromURI('/tmp/local')).toBe(null);
  });
});

describe('glob', () => {
  let dir;

  beforeEach(() => {
    dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'config.d'));
    fs.writeFileSync(path.join(dir, 'config.d', 'work.conf'), '');
    fs.writeFileSync(path.join(dir, 'config.d', 'home.conf'), '');
    fs.writeFileSync(path.join(dir, 'config.d', 'notes.txt'), '');
    fs.writeFileSync(path.join(dir, 'config.d', '.hidden'), '');
  });

  it('matches a star in the final segment', () => {
    waitsForPromise(async () => {
      const found = await glob('config.d/*.conf', dir);
      expect(found.map(p => path.basename(p))).toEqual(['home.conf', 'work.conf']);
    });
  });

  it('skips dotfiles unless the pattern asks for them', () => {
    waitsForPromise(async () => {
      const all = await glob('config.d/*', dir);
      expect(all.map(p => path.basename(p))).toEqual(['home.conf', 'notes.txt', 'work.conf']);
    });
  });

  it('returns nothing for a pattern that matches no file', () => {
    waitsForPromise(async () => {
      expect(await glob('config.d/*.missing', dir)).toEqual([]);
    });
  });

  it('handles an absolute pattern', () => {
    waitsForPromise(async () => {
      const found = await glob(path.join(dir, 'config.d', 'work.*'), '/');
      expect(found.length).toBe(1);
      expect(path.basename(found[0])).toBe('work.conf');
    });
  });
});

describe('SSHConfiguration', () => {
  let dir, configPath;

  beforeEach(() => {
    dir = tmpdir();
    configPath = path.join(dir, 'config');
    atom.config.set('pulsar-ssh-client.configFile', configPath);
  });

  it('lists concrete hosts and ignores patterns', () => {
    fs.writeFileSync(configPath, [
      'Host *',
      '  ServerAliveInterval 60',
      '',
      'Host build',
      '  HostName build.internal',
      '  User ci',
      '',
      'Host !staging',
      '  User nobody'
    ].join('\n'));

    waitsForPromise(async () => {
      const config = await SSHConfiguration.loadFromFS({ systemConfigPath: path.join(dir, 'no-system-config') });
      expect(config.getAllConfiguredHosts()).toEqual(['build']);
    });
  });

  it('lists every name on a multi-name Host line', () => {
    fs.writeFileSync(configPath, 'Host alpha beta gamma\n  User shared\n');

    waitsForPromise(async () => {
      const config = await SSHConfiguration.loadFromFS({ systemConfigPath: path.join(dir, 'no-system-config') });
      expect(config.getAllConfiguredHosts()).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  it('computes a host configuration, normalising directive case', () => {
    fs.writeFileSync(configPath, [
      'Host build',
      '  hostname build.internal',
      '  USER ci',
      '  port 2222'
    ].join('\n'));

    waitsForPromise(async () => {
      const config = await SSHConfiguration.loadFromFS({ systemConfigPath: path.join(dir, 'no-system-config') });
      const host = config.getHostConfiguration('build');
      expect(host.HostName).toBe('build.internal');
      expect(host.User).toBe('ci');
      expect(host.Port).toBe('2222');
    });
  });

  it('resolves an Include glob', () => {
    fs.mkdirSync(path.join(dir, 'conf.d'));
    fs.writeFileSync(path.join(dir, 'conf.d', 'extra'), 'Host included\n  HostName included.internal\n');
    fs.writeFileSync(configPath, `Include ${path.join(dir, 'conf.d', '*')}\n\nHost direct\n  HostName direct.internal\n`);

    waitsForPromise(async () => {
      const config = await SSHConfiguration.loadFromFS({ systemConfigPath: path.join(dir, 'no-system-config') });
      expect(config.getAllConfiguredHosts()).toContain('included');
      expect(config.getAllConfiguredHosts()).toContain('direct');
      expect(config.getHostConfiguration('included').HostName).toBe('included.internal');
    });
  });

  it('hoists an Include written after a Host block', () => {
    // ssh has no block terminator, so this Include parses as a child of
    // `Host direct`. It must still be treated as a sibling.
    fs.mkdirSync(path.join(dir, 'conf.d'));
    fs.writeFileSync(path.join(dir, 'conf.d', 'extra'), 'Host hoisted\n  HostName hoisted.internal\n');
    fs.writeFileSync(configPath, [
      'Host direct',
      '  HostName direct.internal',
      `Include ${path.join(dir, 'conf.d', '*')}`
    ].join('\n'));

    waitsForPromise(async () => {
      const config = await SSHConfiguration.loadFromFS({ systemConfigPath: path.join(dir, 'no-system-config') });
      expect(config.getAllConfiguredHosts()).toContain('hoisted');
      expect(config.getHostConfiguration('hoisted').HostName).toBe('hoisted.internal');
    });
  });

  it('survives a missing config file', () => {
    atom.config.set('pulsar-ssh-client.configFile', path.join(dir, 'does-not-exist'));

    waitsForPromise(async () => {
      const config = await SSHConfiguration.loadFromFS({ systemConfigPath: path.join(dir, 'no-system-config') });
      expect(config.getAllConfiguredHosts()).toEqual([]);
    });
  });
});

describe('known-hosts', () => {
  let dir, knownHosts, hostKey;

  // The module resolves ~/.ssh/known_hosts at require time, so point HOME at a
  // scratch directory and load it fresh for each spec.
  function loadModule(homeDir) {
    const realHome = os.homedir;
    os.homedir = () => homeDir;
    delete require.cache[require.resolve('../lib/ssh/known-hosts')];
    const mod = require('../lib/ssh/known-hosts');
    os.homedir = realHome;
    return mod;
  }

  beforeEach(() => {
    dir = tmpdir();
    fs.mkdirSync(path.join(dir, '.ssh'), { mode: 0o700 });
    knownHosts = path.join(dir, '.ssh', 'known_hosts');
    hostKey = crypto.randomBytes(32);
  });

  it('reports an unknown host', () => {
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', hostKey)).toBe('unknown');
    });
  });

  it('adds a host and then matches it', () => {
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      await mod.addHostKey('box', 22, 'ssh-ed25519', hostKey);
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', hostKey)).toBe('match');
    });
  });

  it('detects a changed key', () => {
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      await mod.addHostKey('box', 22, 'ssh-ed25519', hostKey);
      const different = crypto.randomBytes(32);
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', different)).toBe('changed');
    });
  });

  it('matches a plaintext entry, which upstream ignores', () => {
    fs.writeFileSync(knownHosts, `box ssh-ed25519 ${hostKey.toString('base64')}\n`);
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', hostKey)).toBe('match');
    });
  });

  it('matches one name in a comma-separated plaintext entry', () => {
    fs.writeFileSync(knownHosts, `alpha,beta,10.0.0.1 ssh-ed25519 ${hostKey.toString('base64')}\n`);
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      expect(await mod.checkHostKey('beta', 22, 'ssh-ed25519', hostKey)).toBe('match');
    });
  });

  it('uses the [host]:port form for a non-default port', () => {
    const mod = loadModule(dir);
    expect(mod.hostAddress('box', 22)).toBe('box');
    expect(mod.hostAddress('box', 2222)).toBe('[box]:2222');

    waitsForPromise(async () => {
      await mod.addHostKey('box', 2222, 'ssh-ed25519', hostKey);
      expect(await mod.checkHostKey('box', 2222, 'ssh-ed25519', hostKey)).toBe('match');
      // The same host on the default port is a different entry.
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', hostKey)).toBe('unknown');
    });
  });

  it('honours a @revoked marker', () => {
    fs.writeFileSync(knownHosts, `@revoked box ssh-ed25519 ${hostKey.toString('base64')}\n`);
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', hostKey)).toBe('revoked');
    });
  });

  it('ignores comments and blank lines', () => {
    fs.writeFileSync(knownHosts, `# a comment\n\n   \nbox ssh-ed25519 ${hostKey.toString('base64')}\n`);
    const mod = loadModule(dir);
    waitsForPromise(async () => {
      expect(await mod.checkHostKey('box', 22, 'ssh-ed25519', hostKey)).toBe('match');
    });
  });

  it('formats a SHA256 fingerprint without padding', () => {
    const mod = loadModule(dir);
    const fp = mod.fingerprint(hostKey);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp).not.toMatch(/=/);
  });
});
