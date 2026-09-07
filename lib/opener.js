// Turns an ssh:// URI into a real editor.
//
// atom.workspace.open() alone cannot do this: Project.buildBuffer passes a
// plain string to TextBuffer.load, which builds a local File and fails. An
// opener runs first (workspace.js:1533), so the scheme is intercepted here.

const logger = require('./logger');
const SSHDestination = require('./ssh/ssh-destination');
const RemoteFile = require('./fs/remote-file');
const connectionManager = require('./connection-manager');

// text-buffer is not requirable by name from a package, so the class is taken
// from a buffer Pulsar already built.
function getTextBufferClass() {
  return atom.workspace.buildTextEditor().getBuffer().constructor;
}

async function openRemoteURI(uri) {
  const parsed = SSHDestination.fromURI(uri);
  if (!parsed) { return undefined; }

  const connection = await connectionManager.connect(parsed.destination);
  const file = new RemoteFile(connection, parsed.path);

  const TextBuffer = getTextBufferClass();
  const buffer = await TextBuffer.load(file);

  return atom.workspace.buildTextEditor({ buffer });
}

/**
 * Register the opener. Returns a Disposable.
 *
 * An opener must return undefined for a URI it does not handle, so Pulsar can
 * try the next one.
 */
function createOpener() {
  return atom.workspace.addOpener(uri => {
    if (!SSHDestination.isRemoteURI(uri)) { return undefined; }

    return openRemoteURI(uri).catch(err => {
      logger.error(`Could not open ${uri}: ${err.message}`);
      atom.notifications.addError('Could not open remote file', {
        description: `${uri}\n\n${err.message}`,
        dismissable: true
      });
      // Rethrowing would leave a broken pane item; returning undefined lets
      // Pulsar treat it as unopened.
      return undefined;
    });
  });
}

module.exports = { createOpener, openRemoteURI };
