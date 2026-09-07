// Supplies Directory objects for ssh:// project roots.
//
// Pulsar core consumes `atom.directory-provider` (src/project.js:668) and this
// makes atom.project understand a remote root. Note that the bundled tree-view
// does NOT consult it -- tree-view calls fs.lstatSyncNoException on each
// project path and silently drops the ones that fail, so a remote root renders
// nothing there. That is why this package ships its own tree.

const SSHDestination = require('./ssh/ssh-destination');
const RemoteDirectory = require('./fs/remote-directory');
const connectionManager = require('./connection-manager');

module.exports = {
  // Must be synchronous, and must not do network I/O. If the host is not
  // connected yet, hand back a directory that simply claims to exist; it
  // starts answering properly once the connection is up.
  directoryForURISync(uri) {
    if (!SSHDestination.isRemoteURI(uri)) { return null; }

    const parsed = SSHDestination.fromURI(uri);
    if (!parsed) { return null; }

    const connection = connectionManager.get(parsed.destination)
      || { destination: parsed.destination, sftp: () => Promise.reject(new Error('Not connected')) };

    return new RemoteDirectory(connection, parsed.path, { isProjectRoot: true });
  },

  directoryForURI(uri) {
    return Promise.resolve(this.directoryForURISync(uri));
  }
};
