const { FakeSFTP, FakeConnection } = require('./fake-sftp');
const connectionManager = require('../lib/connection-manager');
const directoryProvider = require('../lib/directory-provider');
const SSHDestination = require('../lib/ssh/ssh-destination');

// Put a fake connection into the manager so the opener and provider can be
// exercised without a server.
function installFakeConnection(destination, sftp) {
  const connection = new FakeConnection(destination, sftp);
  connection.connected = true;
  connection.name = connection.destination.toString();
  connectionManager.connections.set(connection.destination.toString(), connection);
  return connection;
}

describe('the package', () => {
  beforeEach(() => {
    connectionManager.connections.clear();
    connectionManager.pending.clear();

    waitsForPromise(() => atom.packages.activatePackage('pulsar-ssh-client'));
  });

  afterEach(() => {
    connectionManager.connections.clear();
  });

  it('activates', () => {
    expect(atom.packages.isPackageActive('pulsar-ssh-client')).toBe(true);
  });

  it('registers its commands', () => {
    const target = atom.views.getView(atom.workspace);
    const names = atom.commands.findCommands({ target }).map(c => c.name);

    expect(names).toContain('pulsar-ssh-client:connect-to-host');
    expect(names).toContain('pulsar-ssh-client:open-remote-file');
    expect(names).toContain('pulsar-ssh-client:disconnect');
    expect(names).toContain('pulsar-ssh-client:open-ssh-config');
    expect(names).toContain('pulsar-ssh-client:show-log');
  });

  it('registers its config schema', () => {
    expect(atom.config.get('pulsar-ssh-client.connectTimeout')).toBe(60);
    expect(atom.config.get('pulsar-ssh-client.showHiddenFiles')).toBe(false);
  });

  describe('the opener', () => {
    let sftp;

    beforeEach(() => {
      sftp = new FakeSFTP();
      sftp.addFile('/srv/app/index.js', 'console.log("remote")\n');
      installFakeConnection('ci@build:2222', sftp);
    });

    it('opens a remote file as a real editor', () => {
      let editor = null;

      waitsForPromise(() =>
        atom.workspace.open('ssh://ci@build:2222/srv/app/index.js')
          .then(result => { editor = result; }));

      runs(() => {
        expect(editor).toBeTruthy();
        expect(editor.getText()).toBe('console.log("remote")\n');
        expect(editor.getPath()).toBe('ssh://ci@build:2222/srv/app/index.js');
        expect(atom.workspace.getActiveTextEditor()).toBe(editor);
      });
    });

    it('saves an edited remote file back over SFTP', () => {
      let editor = null;

      waitsForPromise(() =>
        atom.workspace.open('ssh://ci@build:2222/srv/app/index.js')
          .then(result => { editor = result; }));

      runs(() => { editor.setText('console.log("edited")\n'); });

      waitsForPromise(() => editor.save());

      runs(() => {
        expect(sftp.readContents('/srv/app/index.js')).toBe('console.log("edited")\n');
        expect(editor.isModified()).toBe(false);
      });
    });

    it('leaves local paths to the normal openers', () => {
      waitsForPromise(() => atom.workspace.open(__filename).then(editor => {
        expect(editor.getPath()).toBe(__filename);
      }));
    });
  });

  describe('the directory provider', () => {
    it('ignores a non-remote URI', () => {
      expect(directoryProvider.directoryForURISync('/tmp/local')).toBe(null);
      expect(directoryProvider.directoryForURISync('https://example.com')).toBe(null);
    });

    it('returns a directory for a remote URI', () => {
      installFakeConnection('ci@build:2222', new FakeSFTP());
      const dir = directoryProvider.directoryForURISync('ssh://ci@build:2222/srv/app');

      expect(dir).toBeTruthy();
      expect(dir.getRemotePath()).toBe('/srv/app');
      expect(dir.isRoot()).toBe(true);
      expect(dir.existsSync()).toBe(true);
    });

    it('returns a usable placeholder before the host is connected', () => {
      // Project calls this synchronously at startup, long before any
      // connection exists. It must not return null or throw.
      const dir = directoryProvider.directoryForURISync('ssh://nobody@offline/srv');

      expect(dir).toBeTruthy();
      expect(dir.existsSync()).toBe(true);
      expect(typeof dir.getSubdirectory).toBe('function');
    });

    it('answers the async form too', () => {
      waitsForPromise(async () => {
        const dir = await directoryProvider.directoryForURI('ssh://ci@build:2222/srv');
        expect(dir.getRemotePath()).toBe('/srv');
      });
    });
  });
});

describe('ConnectionManager', () => {
  beforeEach(() => {
    connectionManager.connections.clear();
    connectionManager.pending.clear();
  });

  it('keys connections by user, host and port', () => {
    expect(connectionManager.keyFor('ci@build:2222')).toBe('ci@build:2222');
    expect(connectionManager.keyFor(SSHDestination.parse('build'))).toBe('build');
  });

  it('reports whether a host is connected', () => {
    expect(connectionManager.isConnected('ci@build:2222')).toBe(false);
    installFakeConnection('ci@build:2222', new FakeSFTP());
    expect(connectionManager.isConnected('ci@build:2222')).toBe(true);
  });

  it('treats the same host on a different port as a different connection', () => {
    installFakeConnection('ci@build:2222', new FakeSFTP());
    expect(connectionManager.isConnected('ci@build:2200')).toBe(false);
  });

  it('shares one attempt between concurrent callers', () => {
    // Ten files opened at once must not queue ten password prompts, so
    // connect() has to deduplicate. This drives the real manager, stubbing
    // only the connection it builds.
    const { SSHConnection } = require('../lib/ssh/connection');

    let resolveConnect = null;
    const pending = new Promise(resolve => { resolveConnect = resolve; });
    let attempts = 0;

    spyOn(SSHConnection.prototype, 'connect').andCallFake(function () {
      attempts++;
      return pending.then(() => {
        this.connected = true;
        return this;
      });
    });

    const first = connectionManager.connect('ci@build:2222');
    const second = connectionManager.connect('ci@build:2222');
    const third = connectionManager.connect('ci@build:2222');

    // One attempt for three callers. The promises are not identical --
    // connect() is an async method, so each call wraps the shared in-flight
    // attempt in its own promise -- but they resolve to the same connection.
    expect(attempts).toBe(1);

    resolveConnect();

    waitsForPromise(async () => {
      const [a, b, c] = await Promise.all([first, second, third]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(attempts).toBe(1);
      expect(connectionManager.isConnected('ci@build:2222')).toBe(true);
    });
  });

  it('starts a fresh attempt for a different host', () => {
    const { SSHConnection } = require('../lib/ssh/connection');
    let attempts = 0;

    spyOn(SSHConnection.prototype, 'connect').andCallFake(function () {
      attempts++;
      this.connected = true;
      return Promise.resolve(this);
    });

    waitsForPromise(async () => {
      await connectionManager.connect('ci@build:2222');
      await connectionManager.connect('ci@other:2222');
      expect(attempts).toBe(2);
    });
  });
});
