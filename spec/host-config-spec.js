const os = require('os');
const SSHDestination = require('../lib/ssh/ssh-destination');
const { resolveHostConfig } = require('../lib/ssh/host-config');
const { keyTypeOf } = require('../lib/ssh/connection');

describe('resolveHostConfig', () => {
  it('falls back to the local username and port 22', () => {
    const settings = resolveHostConfig(SSHDestination.parse('box'), {});
    expect(settings.hostname).toBe('box');
    expect(settings.port).toBe(22);
    expect(settings.user).toBe(os.userInfo().username);
  });

  it('prefers ssh_config over the typed destination', () => {
    const settings = resolveHostConfig(SSHDestination.parse('root@box:2222'), {
      HostName: 'real.internal', User: 'ci', Port: '2022'
    });
    expect(settings.hostname).toBe('real.internal');
    expect(settings.user).toBe('ci');
    expect(settings.port).toBe(2022);
  });

  it('uses the typed user and port when ssh_config omits them', () => {
    const settings = resolveHostConfig(SSHDestination.parse('root@box:2222'), {
      HostName: 'real.internal'
    });
    expect(settings.user).toBe('root');
    expect(settings.port).toBe(2222);
  });

  it('expands %h in HostName', () => {
    const settings = resolveHostConfig(SSHDestination.parse('web1'), {
      HostName: '%h.internal'
    });
    expect(settings.hostname).toBe('web1.internal');
  });

  it('keeps the name as typed for known_hosts and %n', () => {
    const settings = resolveHostConfig(SSHDestination.parse('box'), {
      HostName: 'real.internal'
    });
    expect(settings.originalHost).toBe('box');
  });

  it('inherits user and port down a ProxyJump chain', () => {
    const settings = resolveHostConfig(SSHDestination.parse('bastion'), {},
      { user: 'ci', port: 2222 });
    expect(settings.user).toBe('ci');
    expect(settings.port).toBe(2222);
  });

  it('reads yes/no directives case-insensitively', () => {
    const settings = resolveHostConfig(SSHDestination.parse('box'), {
      IdentitiesOnly: 'YES', ForwardAgent: 'Yes'
    });
    expect(settings.identitiesOnly).toBe(true);
    expect(settings.forwardAgent).toBe(true);
  });

  it('defaults those to false', () => {
    const settings = resolveHostConfig(SSHDestination.parse('box'), {});
    expect(settings.identitiesOnly).toBe(false);
    expect(settings.forwardAgent).toBe(false);
  });

  it('normalises IdentityFile to an array', () => {
    expect(resolveHostConfig(SSHDestination.parse('box'), { IdentityFile: '~/.ssh/one' })
      .identityFiles).toEqual(['~/.ssh/one']);
    expect(resolveHostConfig(SSHDestination.parse('box'), { IdentityFile: ['a', 'b'] })
      .identityFiles).toEqual(['a', 'b']);
    expect(resolveHostConfig(SSHDestination.parse('box'), {}).identityFiles).toEqual([]);
  });

  it('splits PreferredAuthentications, and defaults it', () => {
    expect(resolveHostConfig(SSHDestination.parse('box'), {
      PreferredAuthentications: 'publickey, keyboard-interactive'
    }).preferredAuthentications).toEqual(['publickey', 'keyboard-interactive']);

    expect(resolveHostConfig(SSHDestination.parse('box'), {}).preferredAuthentications)
      .toEqual(['publickey', 'password', 'keyboard-interactive']);
  });

  it('turns ConnectTimeout seconds into milliseconds', () => {
    expect(resolveHostConfig(SSHDestination.parse('box'), { ConnectTimeout: '30' })
      .connectTimeout).toBe(30000);
  });

  it('honours "IdentityAgent none" by disabling the agent', () => {
    expect(resolveHostConfig(SSHDestination.parse('box'), { IdentityAgent: 'none' })
      .agentSock).toBeUndefined();
  });

  it('defaults StrictHostKeyChecking to ask', () => {
    expect(resolveHostConfig(SSHDestination.parse('box'), {}).strictHostKeyChecking)
      .toBe('ask');
    expect(resolveHostConfig(SSHDestination.parse('box'), { StrictHostKeyChecking: 'NO' })
      .strictHostKeyChecking).toBe('no');
  });
});

describe('keyTypeOf', () => {
  function blob(type) {
    const name = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length, 0);
    return Buffer.concat([length, name, Buffer.from('key material')]);
  }

  it('reads the type out of a public key blob', () => {
    expect(keyTypeOf(blob('ssh-ed25519'))).toBe('ssh-ed25519');
    expect(keyTypeOf(blob('ecdsa-sha2-nistp256'))).toBe('ecdsa-sha2-nistp256');
  });

  it('does not throw on a truncated buffer', () => {
    expect(keyTypeOf(Buffer.alloc(2))).toBe('unknown');
  });
});
