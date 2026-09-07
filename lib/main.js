const { CompositeDisposable } = require('atom');

const configSchema = require('./config-schema');
const logger = require('./logger');
const connectionManager = require('./connection-manager');
const { createOpener } = require('./opener');
const { getSSHConfigPath } = require('./ssh/ssh-config');
const { RemoteTreeView, TREE_URI } = require('./ui/remote-tree');
const { RemoteTerminal, TERMINAL_URI_PREFIX } = require('./ui/remote-terminal');

let subscriptions = null;

module.exports = {
  config: configSchema,

  activate() {
    subscriptions = new CompositeDisposable();

    // Registered here rather than in package.json: declaring
    // providedServices there makes Pulsar require and call the provider
    // eagerly at startup, before activation.
    subscriptions.add(atom.packages.serviceHub.provide(
      'atom.directory-provider', '0.1.0', require('./directory-provider')));

    subscriptions.add(createOpener());

    // The tree is a dock item, reached by URI so Pulsar can restore it.
    subscriptions.add(atom.workspace.addOpener(uri => {
      if (uri === TREE_URI) { return this.getTreeView(); }
      if (uri.startsWith(TERMINAL_URI_PREFIX)) {
        const name = decodeURIComponent(uri.slice(TERMINAL_URI_PREFIX.length));
        const connection = connectionManager.get(name);
        // A terminal cannot be restored without its connection.
        return connection ? new RemoteTerminal(connection) : undefined;
      }
      return undefined;
    }));

    subscriptions.add(atom.commands.add('atom-workspace', {
      'pulsar-ssh-client:connect-to-host': () => this.connectToHost(),
      'pulsar-ssh-client:open-remote-file': () => this.openRemoteFile(),
      'pulsar-ssh-client:disconnect': () => this.disconnect(),
      'pulsar-ssh-client:open-ssh-config': () => this.openSSHConfig(),
      'pulsar-ssh-client:show-log': () => this.showLog(),
      'pulsar-ssh-client:toggle-tree': () => this.toggleTree(),
      'pulsar-ssh-client:open-terminal': () => this.openTerminal(),
      'pulsar-ssh-client:refresh-tree': () => {
        if (this.treeView) { this.treeView.refresh(); }
      }
    }));

    subscriptions.add(connectionManager.onDidConnect(() => {
      atom.workspace.open(TREE_URI, { searchAllPanes: true, activatePane: false });
    }));

    subscriptions.add(connectionManager.onDidError(({ connection, error }) => {
      atom.notifications.addWarning(`SSH: ${connection.name}`, {
        description: error.message,
        dismissable: true
      });
    }));
  },

  deactivate() {
    if (subscriptions) { subscriptions.dispose(); subscriptions = null; }
    if (this.treeView) { this.treeView.destroy(); this.treeView = null; }
    connectionManager.disconnectAll();
  },

  deserializeRemoteTreeView() {
    return this.getTreeView();
  },

  getTreeView() {
    if (!this.treeView) {
      this.treeView = new RemoteTreeView();
      this.treeView.onDidDestroy(() => { this.treeView = null; });
    }
    return this.treeView;
  },

  toggleTree() {
    return atom.workspace.toggle(TREE_URI);
  },

  async openTerminal() {
    const open = connectionManager.getConnections();
    const connection = open.length === 1 ? open[0] : await this.connectToHost();
    if (!connection) { return null; }

    return atom.workspace.open(
      `${TERMINAL_URI_PREFIX}${encodeURIComponent(connection.name)}`,
      { searchAllPanes: true });
  },

  async connectToHost() {
    const { selectHost } = require('./ui/host-picker');
    const host = await selectHost();
    if (!host) { return; }

    try {
      const connection = await connectionManager.connect(host);
      atom.notifications.addSuccess(`Connected to ${connection.name}`);
      return connection;
    } catch (err) {
      atom.notifications.addError(`Could not connect to ${host}`, {
        description: err.message,
        dismissable: true
      });
      return null;
    }
  },

  async openRemoteFile() {
    const { promptForInput } = require('./ui/prompt');

    // Reuse a live connection rather than asking again.
    const open = connectionManager.getConnections();
    const connection = open.length === 1 ? open[0] : await this.connectToHost();
    if (!connection) { return; }

    const remotePath = await promptForInput({
      message: `Open file on ${connection.name}`,
      detail: 'Absolute path on the remote host.',
      placeholder: '/etc/hosts'
    });
    if (!remotePath) { return; }

    await atom.workspace.open(connection.destination.toURI(remotePath.trim()));
  },

  async disconnect() {
    const connections = connectionManager.getConnections();
    if (connections.length === 0) {
      atom.notifications.addInfo('No SSH connections are open.');
      return;
    }

    const { promptForChoice } = require('./ui/prompt');
    const choice = await promptForChoice({
      message: 'Disconnect which host?',
      choices: [
        ...connections.map(c => ({ label: c.name, value: c.name })),
        { label: 'Cancel', value: null }
      ]
    });
    if (choice) { connectionManager.disconnect(choice); }
  },

  async openSSHConfig() {
    const configPath = getSSHConfigPath();
    const fs = require('fs');

    try {
      await fs.promises.access(configPath);
    } catch {
      await fs.promises.mkdir(require('path').dirname(configPath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(configPath,
        '# SSH configuration\n#\n# Host example\n#   HostName example.com\n#   User me\n',
        { mode: 0o600 });
    }

    await atom.workspace.open(configPath);
  },

  showLog() {
    const lines = logger.getLines();
    const text = lines.length
      ? lines.map(l => `[${l.time.toISOString()}] ${l.level.padEnd(5)} ${l.text}`).join('\n')
      : 'Nothing logged yet.';

    atom.workspace.open().then(editor => {
      editor.setText(text);
      editor.setGrammar(atom.grammars.grammarForScopeName('text.plain'));
    });
  },

  consumeStatusBar(statusBar) {
    const { createStatusTile } = require('./ui/status-tile');
    const tile = createStatusTile(statusBar);
    subscriptions.add(tile);
    return tile;
  }
};
