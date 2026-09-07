const { FakeSFTP, FakeConnection } = require('./fake-sftp');
const RemoteFile = require('../lib/fs/remote-file');
const RemoteDirectory = require('../lib/fs/remote-directory');

function setup() {
  const sftp = new FakeSFTP();
  const connection = new FakeConnection('ci@build:2222', sftp);
  return { sftp, connection };
}

function drain(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function writeThrough(file, text) {
  return new Promise((resolve, reject) => {
    const stream = file.createWriteStream();
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(Buffer.from(text, 'utf8'));
  });
}

describe('RemoteFile', () => {
  let sftp, connection;

  beforeEach(() => { ({ sftp, connection } = setup()); });

  it('reports an ssh:// URI as its path', () => {
    const file = new RemoteFile(connection, '/srv/app/index.js');
    expect(file.getPath()).toBe('ssh://ci@build:2222/srv/app/index.js');
    expect(file.getRemotePath()).toBe('/srv/app/index.js');
    expect(file.getBaseName()).toBe('index.js');
    expect(file.isFile()).toBe(true);
    expect(file.isDirectory()).toBe(false);
  });

  it('answers existsSync from cache, without touching the network', () => {
    expect(new RemoteFile(connection, '/a').existsSync()).toBe(true);
    expect(new RemoteFile(connection, '/a', { exists: false }).existsSync()).toBe(false);
    expect(sftp.calls.length).toBe(0);
  });

  it('streams contents in through createReadStream', () => {
    sftp.addFile('/srv/app/index.js', 'console.log(1)\n');
    const file = new RemoteFile(connection, '/srv/app/index.js');

    waitsForPromise(async () => {
      expect(await drain(file.createReadStream())).toBe('console.log(1)\n');
    });
  });

  it('surfaces a read error on the stream rather than throwing', () => {
    const file = new RemoteFile(connection, '/srv/missing.js');

    waitsForPromise(async () => {
      let message = null;
      try { await drain(file.createReadStream()); }
      catch (err) { message = err.message; }
      expect(message).toMatch(/No such file/);
    });
  });

  it('saves through a temp file and an atomic rename', () => {
    sftp.addFile('/srv/app/index.js', 'old\n');
    const file = new RemoteFile(connection, '/srv/app/index.js');

    waitsForPromise(async () => {
      await writeThrough(file, 'new contents\n');

      expect(sftp.readContents('/srv/app/index.js')).toBe('new contents\n');

      const methods = sftp.calls.map(c => c[0]);
      expect(methods).toContain('ext_openssh_rename');

      // The temp file is written first, and nothing is left behind.
      const written = sftp.calls.find(c => c[0] === 'writeFile');
      expect(written[1]).not.toBe('/srv/app/index.js');
      expect(written[1]).toMatch(/\.index\.js\.pulsar-ssh\./);
      expect(sftp.files.has(written[1])).toBe(false);
    });
  });

  it('never truncates the original when the write fails', () => {
    sftp.addFile('/srv/app/index.js', 'precious\n');
    sftp.failOnce('writeFile', Object.assign(new Error('Disk full'), { code: 7 }));
    const file = new RemoteFile(connection, '/srv/app/index.js');

    waitsForPromise(async () => {
      let failed = false;
      try { await writeThrough(file, 'replacement\n'); }
      catch { failed = true; }

      expect(failed).toBe(true);
      expect(sftp.readContents('/srv/app/index.js')).toBe('precious\n');
    });
  });

  it('preserves the existing file mode', () => {
    sftp.addFile('/srv/app/run.sh', '#!/bin/sh\n', 0o755);
    const file = new RemoteFile(connection, '/srv/app/run.sh');

    waitsForPromise(async () => {
      await writeThrough(file, '#!/bin/sh\necho hi\n');
      expect(sftp.files.get('/srv/app/run.sh').mode).toBe(0o755);
    });
  });

  it('creates a file that does not exist yet', () => {
    sftp.addDirectory('/srv/app');
    const file = new RemoteFile(connection, '/srv/app/new.txt');

    waitsForPromise(async () => {
      await writeThrough(file, 'fresh\n');
      expect(sftp.readContents('/srv/app/new.txt')).toBe('fresh\n');
    });
  });

  it('falls back to a direct write when the rename is forbidden', () => {
    sftp.addFile('/srv/app/index.js', 'old\n');
    sftp.supportsPosixRename = false;
    sftp.failOnce('rename', Object.assign(new Error('Permission denied'), { code: 3 }));
    const file = new RemoteFile(connection, '/srv/app/index.js');

    waitsForPromise(async () => {
      await writeThrough(file, 'written in place\n');
      expect(sftp.readContents('/srv/app/index.js')).toBe('written in place\n');
    });
  });

  it('reads and writes text directly', () => {
    sftp.addFile('/srv/notes.txt', 'hello\n');
    const file = new RemoteFile(connection, '/srv/notes.txt');

    waitsForPromise(async () => {
      expect(await file.read()).toBe('hello\n');
      await file.write('goodbye\n');
      expect(sftp.readContents('/srv/notes.txt')).toBe('goodbye\n');
    });
  });

  it('returns a RemoteDirectory as its parent', () => {
    const parent = new RemoteFile(connection, '/srv/app/index.js').getParent();
    expect(parent.getRemotePath()).toBe('/srv/app');
    expect(parent.isDirectory()).toBe(true);
  });
});

describe('RemoteDirectory', () => {
  let sftp, connection;

  beforeEach(() => { ({ sftp, connection } = setup()); });

  it('reports its path and name', () => {
    const dir = new RemoteDirectory(connection, '/srv/app');
    expect(dir.getPath()).toBe('ssh://ci@build:2222/srv/app');
    expect(dir.getBaseName()).toBe('app');
    expect(dir.isDirectory()).toBe(true);
    expect(dir.existsSync()).toBe(true);
  });

  it('strips a trailing slash', () => {
    expect(new RemoteDirectory(connection, '/srv/app/').getRemotePath()).toBe('/srv/app');
    expect(new RemoteDirectory(connection, '/').getRemotePath()).toBe('/');
  });

  it('is a root when told so, or when it is /', () => {
    expect(new RemoteDirectory(connection, '/srv/app').isRoot()).toBe(false);
    expect(new RemoteDirectory(connection, '/srv/app', { isProjectRoot: true }).isRoot()).toBe(true);
    expect(new RemoteDirectory(connection, '/').isRoot()).toBe(true);
  });

  it('stops at itself when walking up from a root', () => {
    const root = new RemoteDirectory(connection, '/srv/app', { isProjectRoot: true });
    expect(root.getParent().getRemotePath()).toBe('/srv/app');
  });

  it('supplies getSubdirectory, which git-repository-provider requires', () => {
    const dir = new RemoteDirectory(connection, '/srv/app');
    expect(typeof dir.getSubdirectory).toBe('function');
    expect(dir.getSubdirectory('.git').getRemotePath()).toBe('/srv/app/.git');
    expect(dir.getFile('package.json').getRemotePath()).toBe('/srv/app/package.json');
  });

  it('knows what it contains', () => {
    const dir = new RemoteDirectory(connection, '/srv/app');
    expect(dir.contains('ssh://ci@build:2222/srv/app/index.js')).toBe(true);
    expect(dir.contains('ssh://ci@build:2222/srv/other/index.js')).toBe(false);
    expect(dir.contains('ssh://ci@build:2222/srv/app')).toBe(false);
    // A different host is never contained, even at the same path.
    expect(dir.contains('ssh://ci@other:2222/srv/app/index.js')).toBe(false);
  });

  it('relativizes a URI beneath it', () => {
    const dir = new RemoteDirectory(connection, '/srv/app');
    expect(dir.relativize('ssh://ci@build:2222/srv/app/lib/index.js')).toBe('lib/index.js');
    expect(dir.relativize('ssh://ci@build:2222/srv/app')).toBe('');
  });

  it('resolves a relative path against itself', () => {
    const dir = new RemoteDirectory(connection, '/srv/app');
    expect(dir.resolve('lib/index.js')).toBe('ssh://ci@build:2222/srv/app/lib/index.js');
    expect(dir.resolve('../other')).toBe('ssh://ci@build:2222/srv/other');
  });

  it('lists entries with directories first, each sorted by name', () => {
    sftp.addFile('/srv/app/zebra.js', '');
    sftp.addFile('/srv/app/alpha.js', '');
    sftp.addDirectory('/srv/app/vendor');
    sftp.addDirectory('/srv/app/lib');

    waitsForPromise(async () => {
      const { directories, files } = await new RemoteDirectory(connection, '/srv/app').getEntries();
      expect(directories.map(d => d.getBaseName())).toEqual(['lib', 'vendor']);
      expect(files.map(f => f.getBaseName())).toEqual(['alpha.js', 'zebra.js']);
    });
  });

  it('treats a symlink to a directory as a directory', () => {
    sftp.addDirectory('/srv/shared');
    sftp.addSymlink('/srv/app/shared', '/srv/shared');
    sftp.addFile('/srv/app/index.js', '');

    waitsForPromise(async () => {
      const { directories, files } = await new RemoteDirectory(connection, '/srv/app').getEntries();
      expect(directories.map(d => d.getBaseName())).toEqual(['shared']);
      expect(files.map(f => f.getBaseName())).toEqual(['index.js']);
    });
  });

  it('treats a broken symlink as a file rather than failing', () => {
    sftp.addSymlink('/srv/app/dangling', '/srv/gone');

    waitsForPromise(async () => {
      const { directories, files } = await new RemoteDirectory(connection, '/srv/app').getEntries();
      expect(directories.length).toBe(0);
      expect(files.map(f => f.getBaseName())).toEqual(['dangling']);
    });
  });

  it('caches a listing only when asked to', () => {
    sftp.addFile('/srv/app/index.js', '');
    const dir = new RemoteDirectory(connection, '/srv/app');

    waitsForPromise(async () => {
      await dir.getEntries();
      await dir.getEntries({ useCache: true });
      expect(sftp.calls.filter(c => c[0] === 'readdir').length).toBe(1);

      await dir.getEntries();
      expect(sftp.calls.filter(c => c[0] === 'readdir').length).toBe(2);
    });
  });

  it('reports a readdir failure', () => {
    waitsForPromise(async () => {
      let message = null;
      try { await new RemoteDirectory(connection, '/nope').getEntries(); }
      catch (err) { message = err.message; }
      expect(message).toMatch(/No such directory/);
    });
  });
});
