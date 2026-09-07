// The remote file tree, as a dock item.
//
// Pulsar's own tree-view cannot show a remote root: updateRoots() calls
// fs.lstatSyncNoException(projectPath) and skips the path when it fails, so an
// ssh:// root is dropped with no error. It then builds its own Directory class
// hardcoded to fs.readdirSync and fs.watch. There is no injection point.
//
// So this is a separate tree. It lists over SFTP, expands lazily, and opens
// files through the same opener atom.workspace.open uses.

const { CompositeDisposable, Emitter } = require('atom');

const logger = require('../logger');
const connectionManager = require('../connection-manager');
const RemoteDirectory = require('../fs/remote-directory');

const URI = 'atom://pulsar-ssh-client/tree';

class RemoteTreeView {
  constructor() {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    // Remembered across refreshes so expanding a folder, refreshing, and
    // finding everything collapsed again does not happen.
    this.expanded = new Set();
    this.selectedURI = null;
    // Bumped on every render. A listing that finishes after the tree has been
    // redrawn belongs to a tree that no longer exists, so it is dropped.
    this.renderToken = 0;

    this.element = document.createElement('div');
    this.element.classList.add('pulsar-ssh-client-tree', 'tool-panel', 'focusable-panel');
    this.element.tabIndex = -1;

    this.listElement = document.createElement('ol');
    this.listElement.classList.add('list-tree', 'has-collapsable-children');
    this.element.appendChild(this.listElement);

    this.subscriptions.add(connectionManager.onDidChange(() => this.render()));
    this.subscriptions.add(atom.config.onDidChange(
      'pulsar-ssh-client.showHiddenFiles', () => this.render()));

    this.subscriptions.add(atom.commands.add(this.element, {
      'pulsar-ssh-client:refresh-tree': () => this.refresh()
    }));

    this.render();
  }

  getTitle() { return 'Remote'; }
  getURI() { return URI; }
  getIconName() { return 'radio-tower'; }
  getDefaultLocation() { return 'left'; }
  getAllowedLocations() { return ['left', 'right']; }
  getPreferredWidth() { return 250; }

  serialize() { return { deserializer: 'RemoteTreeView' }; }

  onDidDestroy(callback) { return this.emitter.on('did-destroy', callback); }

  destroy() {
    this.subscriptions.dispose();
    this.emitter.emit('did-destroy');
    this.emitter.dispose();
    this.element.remove();
  }

  showHidden() {
    return Boolean(atom.config.get('pulsar-ssh-client.showHiddenFiles'));
  }

  /** Re-list everything currently expanded. */
  refresh() {
    for (const connection of connectionManager.getConnections()) {
      const root = this.rootDirectoryFor(connection);
      root.clearCache();
    }
    this.render();
  }

  rootDirectoryFor(connection) {
    const configured = atom.config.get('pulsar-ssh-client.defaultDirectory') || '.';
    // "." means the login directory, which we only learn after connecting.
    const remotePath = (configured === '.' || !configured.startsWith('/'))
      ? (connection.homeDirectory || '/')
      : configured;

    return new RemoteDirectory(connection, remotePath, { isProjectRoot: true });
  }

  render() {
    this.renderToken += 1;
    this.listElement.innerHTML = '';

    const connections = connectionManager.getConnections();
    if (connections.length === 0) {
      this.listElement.appendChild(this.buildEmptyMessage());
      return;
    }

    for (const connection of connections) {
      this.listElement.appendChild(this.buildHostNode(connection));
    }
  }

  buildEmptyMessage() {
    const item = document.createElement('li');
    item.classList.add('pulsar-ssh-client-empty');

    const message = document.createElement('div');
    message.textContent = 'No SSH connection.';
    item.appendChild(message);

    const button = document.createElement('button');
    button.classList.add('btn', 'btn-sm');
    button.textContent = 'Connect to Host…';
    button.addEventListener('click', () => atom.commands.dispatch(
      atom.views.getView(atom.workspace), 'pulsar-ssh-client:connect-to-host'));
    item.appendChild(button);

    return item;
  }

  buildHostNode(connection) {
    const directory = this.rootDirectoryFor(connection);
    const node = this.buildDirectoryNode(directory, connection.name);
    node.classList.add('pulsar-ssh-client-host');
    return node;
  }

  buildDirectoryNode(directory, label) {
    const uri = directory.getPath();
    const isExpanded = this.expanded.has(uri);

    const item = document.createElement('li');
    item.classList.add('list-nested-item', 'directory', 'entry');
    if (!isExpanded) { item.classList.add('collapsed'); }

    const header = document.createElement('div');
    header.classList.add('header', 'list-item', 'icon', 'icon-file-directory');
    header.textContent = label || directory.getBaseName();
    header.addEventListener('click', event => {
      event.stopPropagation();
      this.toggleDirectory(directory);
    });
    item.appendChild(header);

    const childList = document.createElement('ol');
    childList.classList.add('entries', 'list-tree');
    item.appendChild(childList);

    if (isExpanded) { this.populate(directory, childList, this.renderToken); }

    return item;
  }

  toggleDirectory(directory) {
    const uri = directory.getPath();
    if (this.expanded.has(uri)) { this.expanded.delete(uri); }
    else { this.expanded.add(uri); }
    this.render();
  }

  async populate(directory, childList, token) {
    const loading = document.createElement('li');
    loading.classList.add('list-item', 'pulsar-ssh-client-loading');
    loading.textContent = 'Loading…';
    childList.appendChild(loading);

    let entries;
    try {
      entries = await directory.getEntries({ useCache: true });
    } catch (err) {
      logger.error(`Could not list ${directory.getRemotePath()}: ${err.message}`);
      if (token !== this.renderToken) { return; }
      loading.classList.add('text-error');
      loading.textContent = err.message;
      return;
    }

    // The tree may have been re-rendered while this listing was in flight.
    // Checking element.isConnected would be wrong: it is false whenever the
    // dock item is not attached to the document, which stalls the whole tree.
    if (token !== this.renderToken) { return; }
    childList.innerHTML = '';

    const visible = name => this.showHidden() || !name.startsWith('.');

    for (const child of entries.directories) {
      if (!visible(child.getBaseName())) { continue; }
      childList.appendChild(this.buildDirectoryNode(child));
    }
    for (const file of entries.files) {
      if (!visible(file.getBaseName())) { continue; }
      childList.appendChild(this.buildFileNode(file));
    }

    if (childList.children.length === 0) {
      const empty = document.createElement('li');
      empty.classList.add('list-item', 'text-subtle');
      empty.textContent = 'empty';
      childList.appendChild(empty);
    }
  }

  buildFileNode(file) {
    const uri = file.getPath();

    const item = document.createElement('li');
    item.classList.add('list-item', 'file', 'entry', 'icon', 'icon-file-text');
    item.textContent = file.getBaseName();
    if (uri === this.selectedURI) { item.classList.add('selected'); }

    item.addEventListener('click', event => {
      event.stopPropagation();
      this.selectedURI = uri;
      this.render();
      atom.workspace.open(uri);
    });

    return item;
  }
}

module.exports = { RemoteTreeView, TREE_URI: URI };
