const { FakeSFTP, FakeConnection } = require('./fake-sftp');
const { RemoteTreeView, TREE_URI } = require('../lib/ui/remote-tree');
const connectionManager = require('../lib/connection-manager');

function installConnection(destination, sftp, home = '/home/tester') {
  const connection = new FakeConnection(destination, sftp);
  connection.connected = true;
  connection.name = connection.destination.toString();
  connection.homeDirectory = home;
  connectionManager.connections.set(connection.destination.toString(), connection);
  return connection;
}

// The tree populates asynchronously; wait for the loading row to go.
function waitForRender(view) {
  waitsFor('the tree to finish listing', () =>
    view.element.querySelector('.pulsar-ssh-client-loading') === null, 3000);
}

describe('RemoteTreeView', () => {
  let view, sftp;

  beforeEach(() => {
    connectionManager.connections.clear();
    atom.config.set('pulsar-ssh-client.showHiddenFiles', false);
    atom.config.set('pulsar-ssh-client.defaultDirectory', '.');

    sftp = new FakeSFTP();
    sftp.addFile('/home/tester/index.js', 'x');
    sftp.addFile('/home/tester/.hidden', 'x');
    sftp.addDirectory('/home/tester/lib');
    sftp.addFile('/home/tester/lib/deep.js', 'x');
  });

  afterEach(() => {
    if (view) { view.destroy(); view = null; }
    connectionManager.connections.clear();
  });

  it('describes itself as a dock item', () => {
    view = new RemoteTreeView();
    expect(view.getTitle()).toBe('Remote');
    expect(view.getURI()).toBe(TREE_URI);
    expect(view.getDefaultLocation()).toBe('left');
    expect(view.getAllowedLocations()).toContain('left');
    expect(view.serialize().deserializer).toBe('RemoteTreeView');
  });

  it('offers a connect button when nothing is connected', () => {
    view = new RemoteTreeView();
    const empty = view.element.querySelector('.pulsar-ssh-client-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('No SSH connection');
    expect(empty.querySelector('button')).toBeTruthy();
  });

  it('shows a connected host as a collapsed root', () => {
    installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();

    const host = view.element.querySelector('.pulsar-ssh-client-host');
    expect(host).toBeTruthy();
    expect(host.querySelector('.header').textContent).toBe('ci@build:2222');
    expect(host.classList.contains('collapsed')).toBe(true);
  });

  it('roots the host at its login directory', () => {
    const connection = installConnection('ci@build:2222', sftp, '/home/tester');
    view = new RemoteTreeView();
    expect(view.rootDirectoryFor(connection).getRemotePath()).toBe('/home/tester');
  });

  it('roots at a configured absolute directory instead', () => {
    atom.config.set('pulsar-ssh-client.defaultDirectory', '/srv/app');
    const connection = installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();
    expect(view.rootDirectoryFor(connection).getRemotePath()).toBe('/srv/app');
  });

  it('lists directories before files when expanded', () => {
    installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();
    view.expanded.add('ssh://ci@build:2222/home/tester');
    view.render();

    waitForRender(view);

    runs(() => {
      const entries = [...view.element.querySelectorAll('.entries > .entry')];
      const labels = entries.map(e => e.querySelector('.header')
        ? e.querySelector('.header').textContent
        : e.textContent);
      expect(labels).toEqual(['lib', 'index.js']);
    });
  });

  it('hides dotfiles unless asked', () => {
    installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();
    view.expanded.add('ssh://ci@build:2222/home/tester');
    view.render();

    waitForRender(view);

    runs(() => {
      expect(view.element.textContent).not.toContain('.hidden');
      atom.config.set('pulsar-ssh-client.showHiddenFiles', true);
      view.render();
    });

    waitForRender(view);

    runs(() => {
      expect(view.element.textContent).toContain('.hidden');
    });
  });

  it('keeps folders expanded across a refresh', () => {
    installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();
    const uri = 'ssh://ci@build:2222/home/tester';

    view.toggleDirectory({ getPath: () => uri });
    expect(view.expanded.has(uri)).toBe(true);

    view.refresh();
    expect(view.expanded.has(uri)).toBe(true);

    view.toggleDirectory({ getPath: () => uri });
    expect(view.expanded.has(uri)).toBe(false);
  });

  it('reports a listing failure in place rather than throwing', () => {
    const connection = installConnection('ci@build:2222', sftp, '/does/not/exist');
    view = new RemoteTreeView();
    view.expanded.add(`ssh://${connection.name}/does/not/exist`);
    view.render();

    waitsFor('the error to render', () =>
      view.element.querySelector('.text-error') !== null, 3000);

    runs(() => {
      expect(view.element.querySelector('.text-error').textContent)
        .toMatch(/No such directory/);
    });
  });

  it('says so when a directory is empty', () => {
    sftp.addDirectory('/home/tester/empty');
    installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();
    // Both the parent and the empty folder, or the empty one is never drawn.
    view.expanded.add('ssh://ci@build:2222/home/tester');
    view.expanded.add('ssh://ci@build:2222/home/tester/empty');
    view.render();

    waitForRender(view);

    runs(() => {
      const emptyFolder = [...view.element.querySelectorAll('.directory')]
        .find(e => e.querySelector('.header').textContent === 'empty');
      expect(emptyFolder).toBeTruthy();
      expect(emptyFolder.querySelector('.entries').textContent).toBe('empty');
    });
  });

  it('opens a file when it is clicked', () => {
    installConnection('ci@build:2222', sftp);
    view = new RemoteTreeView();
    view.expanded.add('ssh://ci@build:2222/home/tester');
    view.render();

    waitForRender(view);

    let opened = null;
    runs(() => {
      spyOn(atom.workspace, 'open').andCallFake(uri => {
        opened = uri;
        return Promise.resolve(null);
      });

      const file = [...view.element.querySelectorAll('.entry.file')]
        .find(e => e.textContent === 'index.js');
      expect(file).toBeTruthy();
      file.click();
    });

    waitsFor('the open call', () => opened !== null, 2000);

    runs(() => {
      expect(opened).toBe('ssh://ci@build:2222/home/tester/index.js');
    });
  });

  it('redraws when a connection appears or goes away', () => {
    view = new RemoteTreeView();
    expect(view.element.querySelector('.pulsar-ssh-client-empty')).toBeTruthy();

    installConnection('ci@build:2222', sftp);
    connectionManager.emitter.emit('did-change');

    expect(view.element.querySelector('.pulsar-ssh-client-empty')).toBe(null);
    expect(view.element.querySelector('.pulsar-ssh-client-host')).toBeTruthy();
  });
});
