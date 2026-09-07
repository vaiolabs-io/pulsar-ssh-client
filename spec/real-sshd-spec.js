/*
 * Integration test against a real sshd.
 *
 * Everything else in this suite runs against an in-memory double, which
 * encodes what I believe the SFTP protocol does. This checks those beliefs
 * against an actual server.
 *
 * Skipped unless a test host is configured:
 *
 *   PULSAR_SSH_TEST_HOST=127.0.0.1 \
 *   PULSAR_SSH_TEST_PORT=2222 \
 *   PULSAR_SSH_TEST_USER=tester \
 *   PULSAR_SSH_TEST_KEY=/path/to/private_key \
 *   pulsar --test spec
 *
 * script/test-host.sh starts a container providing exactly that.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SSHConnection } = require('../lib/ssh/connection');
const RemoteFile = require('../lib/fs/remote-file');
const RemoteDirectory = require('../lib/fs/remote-directory');
const connectionManager = require('../lib/connection-manager');
const { RemoteTreeView } = require('../lib/ui/remote-tree');

const TEST_HOST = process.env.PULSAR_SSH_TEST_HOST;
const TEST_PORT = process.env.PULSAR_SSH_TEST_PORT || '2222';
const TEST_USER = process.env.PULSAR_SSH_TEST_USER || 'tester';
const TEST_KEY = process.env.PULSAR_SSH_TEST_KEY;

const describeIntegration = (TEST_HOST && TEST_KEY) ? describe : xdescribe;

describeIntegration('against a real sshd', () => {
  const alias = 'pulsar-ssh-test';
  let connection, remoteDir, configPath;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-ssh-int-'));
    configPath = path.join(dir, 'config');

    // StrictHostKeyChecking no keeps the host-key dialog out of an automated
    // run. The dialog itself is covered by unit tests.
    fs.writeFileSync(configPath, [
      `Host ${alias}`,
      `  HostName ${TEST_HOST}`,
      `  Port ${TEST_PORT}`,
      `  User ${TEST_USER}`,
      `  IdentityFile ${TEST_KEY}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking no',
      ''
    ].join('\n'));

    atom.config.set('pulsar-ssh-client.configFile', configPath);

    waitsForPromise(async () => {
      connection = new SSHConnection(alias);
      await connection.connect();
      remoteDir = process.env.PULSAR_SSH_TEST_DIR
        || `/tmp/pulsar-ssh-spec-${process.pid}`;
      await connection.exec(`rm -rf ${remoteDir} && mkdir -p ${remoteDir}`);
    });
  });

  afterEach(() => {
    waitsForPromise(async () => {
      if (connection && connection.connected) {
        await connection.exec(`rm -rf ${remoteDir}`);
        connection.close();
      }
    });
  });

  it('connects and runs a command', () => {
    waitsForPromise(async () => {
      const result = await connection.exec('echo hello && id -un');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('hello');
      expect(result.stdout).toContain(TEST_USER);
    });
  });

  it('works even though the server refuses TCP forwarding', () => {
    // The test server sets AllowTcpForwarding no. Upstream's whole approach
    // depends on forwarding a port to the server it installs; this one must
    // not need it. Prove the server really refuses, and that we work anyway.
    waitsForPromise(async () => {
      let forwardingRefused = false;
      try {
        await new Promise((resolve, reject) => {
          connection.client.forwardOut('127.0.0.1', 0, '127.0.0.1', 22,
            (err, stream) => {
              if (err) { return reject(err); }
              stream.destroy();
              resolve();
            });
        });
      } catch {
        forwardingRefused = true;
      }

      expect(forwardingRefused).toBe(true);

      // ...and file work over the same connection is unaffected.
      expect(connection.connected).toBe(true);
      const file = new RemoteFile(connection, `${remoteDir}/no-forwarding.txt`);
      await file.write('still works\n');
      expect(await file.read()).toBe('still works\n');
    });
  });

  it('resolves the login directory', () => {
    // The tree roots itself here when no directory is configured.
    waitsForPromise(async () => {
      expect(connection.homeDirectory).toBeTruthy();
      expect(connection.homeDirectory.startsWith('/')).toBe(true);

      const result = await connection.exec('cd ~ && pwd');
      expect(connection.homeDirectory).toBe(result.stdout.trim());
    });
  });

  it('reuses one SFTP channel', () => {
    waitsForPromise(async () => {
      const first = await connection.sftp();
      const second = await connection.sftp();
      expect(second).toBe(first);
    });
  });

  it('reads a file the server wrote', () => {
    waitsForPromise(async () => {
      await connection.exec(`printf 'line one\\nline two\\n' > ${remoteDir}/read.txt`);

      const file = new RemoteFile(connection, `${remoteDir}/read.txt`);
      expect(await file.read()).toBe('line one\nline two\n');
    });
  });

  it('writes a file the server can read back', () => {
    waitsForPromise(async () => {
      const file = new RemoteFile(connection, `${remoteDir}/write.txt`);
      await file.write('written by pulsar\n');

      const result = await connection.exec(`cat ${remoteDir}/write.txt`);
      expect(result.stdout).toBe('written by pulsar\n');
    });
  });

  it('saves atomically, leaving no temp file behind', () => {
    waitsForPromise(async () => {
      const file = new RemoteFile(connection, `${remoteDir}/atomic.txt`);
      await file.write('first\n');
      await file.write('second\n');

      expect((await connection.exec(`cat ${remoteDir}/atomic.txt`)).stdout).toBe('second\n');

      const listing = await connection.exec(`ls -a ${remoteDir}`);
      expect(listing.stdout).not.toMatch(/pulsar-ssh/);
    });
  });

  it('preserves the file mode across a save', () => {
    waitsForPromise(async () => {
      await connection.exec(`printf '#!/bin/sh\\n' > ${remoteDir}/run.sh && chmod 755 ${remoteDir}/run.sh`);

      const file = new RemoteFile(connection, `${remoteDir}/run.sh`);
      await file.write('#!/bin/sh\necho hi\n');

      const result = await connection.exec(`stat -c %a ${remoteDir}/run.sh`);
      expect(result.stdout.trim()).toBe('755');
    });
  });

  it('lists a directory, separating files from directories', () => {
    waitsForPromise(async () => {
      await connection.exec(
        `cd ${remoteDir} && mkdir -p lib vendor && touch alpha.js zebra.js`);

      const { directories, files } =
        await new RemoteDirectory(connection, remoteDir).getEntries();

      expect(directories.map(d => d.getBaseName())).toEqual(['lib', 'vendor']);
      expect(files.map(f => f.getBaseName())).toEqual(['alpha.js', 'zebra.js']);
    });
  });

  it('follows a symlink to a directory', () => {
    waitsForPromise(async () => {
      await connection.exec(
        `cd ${remoteDir} && mkdir -p real && ln -s real link && ln -s gone broken`);

      const { directories, files } =
        await new RemoteDirectory(connection, remoteDir).getEntries();

      expect(directories.map(d => d.getBaseName()).sort()).toEqual(['link', 'real']);
      expect(files.map(f => f.getBaseName())).toEqual(['broken']);
    });
  });

  it('reports a missing file rather than hanging', () => {
    waitsForPromise(async () => {
      let failed = false;
      try { await new RemoteFile(connection, `${remoteDir}/nope.txt`).read(); }
      catch { failed = true; }
      expect(failed).toBe(true);
    });
  });

  it('opens a real shell and runs a command in it', () => {
    let stream = null;
    let output = '';

    waitsForPromise(async () => {
      stream = await connection.shell({ term: 'xterm-256color', cols: 80, rows: 24 });
      stream.on('data', data => { output += data.toString('utf8'); });
      stream.write('echo PULSAR_SHELL_OK\n');
    });

    waitsFor('the shell to answer', () => output.includes('PULSAR_SHELL_OK'), 10000);

    runs(() => {
      expect(output).toContain('PULSAR_SHELL_OK');
      // The remote sshd allocated the pty, so resizing must reach it.
      expect(typeof stream.setWindow).toBe('function');
      stream.setWindow(30, 100, 0, 0);
      stream.end();
    });
  });

  it('renders real directory contents in the tree', () => {
    let view = null;

    waitsForPromise(async () => {
      await connection.exec(
        `cd ${remoteDir} && mkdir -p src && touch readme.md .dotfile`);

      atom.config.set('pulsar-ssh-client.defaultDirectory', remoteDir);
      atom.config.set('pulsar-ssh-client.showHiddenFiles', false);
      connectionManager.connections.set(connection.destination.toString(), connection);

      view = new RemoteTreeView();
      view.expanded.add(connection.destination.toURI(remoteDir));
      view.render();
    });

    waitsFor('the tree to list the real host', () =>
      view.element.querySelector('.pulsar-ssh-client-loading') === null, 10000);

    runs(() => {
      const text = view.element.textContent;
      expect(text).toContain('src');
      expect(text).toContain('readme.md');
      expect(text).not.toContain('.dotfile');

      view.destroy();
      connectionManager.connections.clear();
      atom.config.set('pulsar-ssh-client.defaultDirectory', '.');
    });
  });

  it('opens a remote file as an editor and saves it', () => {
    let editor = null;

    waitsForPromise(async () => {
      await connection.exec(`printf 'original\\n' > ${remoteDir}/editor.txt`);

      // Route the opener's connection lookup to this connection.
      connectionManager.connections.set(connection.destination.toString(), connection);

      await atom.packages.activatePackage('pulsar-ssh-client');
      editor = await atom.workspace.open(connection.destination.toURI(`${remoteDir}/editor.txt`));
    });

    runs(() => {
      expect(editor.getText()).toBe('original\n');
      editor.setText('edited in pulsar\n');
    });

    waitsForPromise(() => editor.save());

    waitsForPromise(async () => {
      const result = await connection.exec(`cat ${remoteDir}/editor.txt`);
      expect(result.stdout).toBe('edited in pulsar\n');
      connectionManager.connections.clear();
    });
  });
});
