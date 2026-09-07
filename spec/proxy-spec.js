const { splitProxyCommand, substituteTokens, parseProxyJump } = require('../lib/ssh/proxy');

describe('splitProxyCommand', () => {
  it('splits on whitespace', () => {
    expect(splitProxyCommand('ssh -W %h:%p bastion'))
      .toEqual(['ssh', '-W', '%h:%p', 'bastion']);
  });

  it('collapses runs of whitespace', () => {
    expect(splitProxyCommand('  ssh   -W   bastion  '))
      .toEqual(['ssh', '-W', 'bastion']);
  });

  it('groups a quoted token, spaces included', () => {
    expect(splitProxyCommand('"/opt/my tools/connect" --host bastion'))
      .toEqual(['/opt/my tools/connect', '--host', 'bastion']);
  });

  it('treats a backslash as escaping the next character', () => {
    expect(splitProxyCommand('/opt/my\\ tools/connect bastion'))
      .toEqual(['/opt/my tools/connect', 'bastion']);
  });

  it('keeps an empty quoted token', () => {
    expect(splitProxyCommand('cmd "" tail')).toEqual(['cmd', '', 'tail']);
  });

  it('passes an array straight through, and copies it', () => {
    const input = ['ssh', '-W'];
    const output = splitProxyCommand(input);
    expect(output).toEqual(['ssh', '-W']);
    expect(output).not.toBe(input);
  });

  it('returns nothing for an empty command', () => {
    expect(splitProxyCommand('')).toEqual([]);
    expect(splitProxyCommand('   ')).toEqual([]);
  });

  it('does not split a single string into characters', () => {
    // The bug this function exists to prevent: ssh-config v5 returns one
    // string, and [].concat(str) wraps rather than splits, so spawn() got the
    // whole command line as the executable. (upstream #271, #273)
    const argv = splitProxyCommand('ssh -W %h:%p bastion');
    expect(argv.length).toBe(4);
    expect(argv[0]).toBe('ssh');
  });
});

describe('substituteTokens', () => {
  const tokens = { hostname: 'real.internal', originalHost: 'box', port: 2222, user: 'ci' };

  it('replaces %h, %n, %p and %r', () => {
    expect(substituteTokens('%h', tokens)).toBe('real.internal');
    expect(substituteTokens('%n', tokens)).toBe('box');
    expect(substituteTokens('%p', tokens)).toBe('2222');
    expect(substituteTokens('%r', tokens)).toBe('ci');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(substituteTokens('%h:%p %h:%p', tokens))
      .toBe('real.internal:2222 real.internal:2222');
  });

  it('leaves an unknown token alone', () => {
    expect(substituteTokens('%q', tokens)).toBe('%q');
  });
});

describe('parseProxyJump', () => {
  it('parses a single hop', () => {
    const hops = parseProxyJump('bastion');
    expect(hops.length).toBe(1);
    expect(hops[0].hostname).toBe('bastion');
  });

  it('parses a chain in order, with user and port', () => {
    const hops = parseProxyJump('alice@first:2201, bob@second:2202');
    expect(hops.length).toBe(2);
    expect(hops[0].user).toBe('alice');
    expect(hops[0].hostname).toBe('first');
    expect(hops[0].port).toBe(2201);
    expect(hops[1].user).toBe('bob');
    expect(hops[1].hostname).toBe('second');
    expect(hops[1].port).toBe(2202);
  });

  it('ignores empty entries', () => {
    expect(parseProxyJump('first,,second').length).toBe(2);
  });
});
