// A file on a remote host, shaped so text-buffer can load and save it.
//
// The duck type text-buffer documents (src/text-buffer.js:556) is getPath,
// createReadStream, createWriteStream and existsSync, plus optional change
// notifications. Meeting it means a remote file opens as an ordinary editor
// with no local copy, no temp file and no sync step.
//
// The design follows Nuclide's RemoteFile (Facebook, MIT), which is the only
// prior art for a virtual filesystem in this editor.

const path = require('path').posix;
const { Emitter } = require('atom');
const { Writable } = require('stream');

const logger = require('../logger');

// Buffer the whole file rather than streaming chunks straight out.
//
// text-buffer writes as it serialises, and a connection that drops midway
// would leave the remote file truncated -- the worst thing an editor can do.
// Collecting first means one atomic write at the end, or none at all.
class RemoteWriteStream extends Writable {
  constructor(file) {
    super();
    this.file = file;
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  _final(callback) {
    this.file.writeAtomically(Buffer.concat(this.chunks))
      .then(() => callback(), err => callback(err));
  }
}

class RemoteFile {
  constructor(connection, remotePath, { exists = true, stats = null } = {}) {
    this.connection = connection;
    this.remotePath = remotePath;
    this.emitter = new Emitter();
    // existsSync cannot do network I/O, so it answers from what the directory
    // listing already told us.
    this.cachedExists = exists;
    this.cachedStats = stats;
    this.digest = null;
  }

  // The URI is the buffer's path, so it must round-trip back to this file.
  getPath() { return this.connection.destination.toURI(this.remotePath); }
  getRemotePath() { return this.remotePath; }
  getBaseName() { return path.basename(this.remotePath); }
  isFile() { return true; }
  isDirectory() { return false; }
  isSymbolicLink() { return Boolean(this.cachedStats && this.cachedStats.isSymbolicLink()); }
  existsSync() { return this.cachedExists; }

  getParent() {
    const RemoteDirectory = require('./remote-directory');
    return new RemoteDirectory(this.connection, path.dirname(this.remotePath));
  }

  async exists() {
    const sftp = await this.connection.sftp();
    return new Promise(resolve => {
      sftp.stat(this.remotePath, err => {
        this.cachedExists = !err;
        resolve(!err);
      });
    });
  }

  async stat() {
    const sftp = await this.connection.sftp();
    return new Promise((resolve, reject) => {
      sftp.stat(this.remotePath, (err, stats) => {
        if (err) { return reject(err); }
        this.cachedStats = stats;
        this.cachedExists = true;
        resolve(stats);
      });
    });
  }

  createReadStream() {
    // text-buffer wants a stream immediately, but the SFTP channel may still
    // be opening. Bridge the gap with a passthrough that is fed once it is up.
    const { PassThrough } = require('stream');
    const passthrough = new PassThrough();

    this.connection.sftp().then(sftp => {
      const source = sftp.createReadStream(this.remotePath);
      source.on('error', err => passthrough.destroy(err));
      source.pipe(passthrough);
    }, err => passthrough.destroy(err));

    return passthrough;
  }

  createWriteStream() {
    return new RemoteWriteStream(this);
  }

  /**
   * Write via a temporary file and rename over the target.
   *
   * A direct write truncates the file before the new content arrives, so a
   * connection dropping mid-save destroys the user's work. Renaming is atomic
   * on the remote filesystem: the file is either the old one or the new one.
   */
  async writeAtomically(contents) {
    const sftp = await this.connection.sftp();
    const directory = path.dirname(this.remotePath);
    const tempPath = path.join(directory, `.${this.getBaseName()}.pulsar-ssh.${process.pid}.${Date.now()}`);

    // Keep the original file's permissions; a fresh temp file would otherwise
    // be created with the default mode and silently change them.
    let mode;
    try {
      const stats = await this.stat();
      mode = stats.mode & 0o7777;
    } catch { /* new file, let the server choose */ }

    try {
      await writeFile(sftp, tempPath, contents, mode);
      await renameOver(sftp, tempPath, this.remotePath);
    } catch (err) {
      // Never leave the temp file behind if the rename failed.
      await new Promise(resolve => sftp.unlink(tempPath, () => resolve()));

      if (err.code === 4 || /permission denied/i.test(err.message || '')) {
        // Some servers forbid creating a sibling file (read-only directory,
        // restricted chroot) while still allowing the file itself to be
        // written. Fall back to a direct write rather than failing the save.
        logger.warn(`Atomic save unavailable for ${this.remotePath}, writing in place`);
        await writeFile(sftp, this.remotePath, contents, mode);
      } else {
        throw err;
      }
    }

    this.cachedExists = true;
    this.emitter.emit('did-change');
  }

  async read() {
    const sftp = await this.connection.sftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(this.remotePath, (err, data) => {
        if (err) { return reject(err); }
        this.cachedExists = true;
        resolve(data.toString('utf8'));
      });
    });
  }

  async write(text) {
    await this.writeAtomically(Buffer.from(text, 'utf8'));
  }

  // text-buffer subscribes to these when they exist. Remote change detection
  // would need polling or inotify on the far side; neither is implemented, so
  // these only fire for changes this editor makes.
  onDidChange(callback) { return this.emitter.on('did-change', callback); }
  onDidDelete(callback) { return this.emitter.on('did-delete', callback); }
  onDidRename(callback) { return this.emitter.on('did-rename', callback); }

  destroy() { this.emitter.dispose(); }
}

function writeFile(sftp, filePath, contents, mode) {
  return new Promise((resolve, reject) => {
    const options = mode === undefined ? {} : { mode };
    sftp.writeFile(filePath, contents, options, err => err ? reject(err) : resolve());
  });
}

// posix-rename@openssh.com replaces the target atomically. Plain SFTP rename
// is required to fail when the target exists, so fall back to unlink first.
function renameOver(sftp, from, to) {
  return new Promise((resolve, reject) => {
    if (typeof sftp.ext_openssh_rename === 'function') {
      return sftp.ext_openssh_rename(from, to, err => {
        if (!err) { return resolve(); }
        legacyRename(sftp, from, to).then(resolve, reject);
      });
    }
    legacyRename(sftp, from, to).then(resolve, reject);
  });
}

function legacyRename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, err => {
      if (!err) { return resolve(); }
      // There is a window here where the file does not exist. Nothing in plain
      // SFTP closes it, which is why posix-rename is preferred above.
      sftp.unlink(to, () => {
        sftp.rename(from, to, err2 => err2 ? reject(err2) : resolve());
      });
    });
  });
}

module.exports = RemoteFile;
