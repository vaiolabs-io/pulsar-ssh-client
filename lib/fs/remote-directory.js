// A directory on a remote host.
//
// Two audiences, and they want different things:
//
//   Our own tree panel calls getEntries(), which is async and does the real
//   SFTP work.
//
//   Pulsar core calls a synchronous Directory duck type when a path is a
//   project root -- and more of it than the docs admit. git-repository-provider
//   calls getSubdirectory() and will throw without it, and Project walks
//   getParent() until isRoot() is true. Those answer from cache or from
//   pure string work; none of them touch the network.
//
// Modelled on Nuclide's RemoteDirectory (Facebook, MIT).

const path = require('path').posix;
const { Emitter } = require('atom');

const RemoteFile = require('./remote-file');

class RemoteDirectory {
  constructor(connection, remotePath, { isProjectRoot = false } = {}) {
    this.connection = connection;
    // Normalise away any trailing slash so paths compare predictably.
    this.remotePath = remotePath === '/' ? '/' : remotePath.replace(/\/+$/, '');
    this.isProjectRoot = isProjectRoot;
    this.emitter = new Emitter();
    this.entryCache = null;
  }

  getPath() { return this.connection.destination.toURI(this.remotePath); }
  getRemotePath() { return this.remotePath; }
  getBaseName() { return path.basename(this.remotePath) || this.remotePath; }

  isFile() { return false; }
  isDirectory() { return true; }
  isSymbolicLink() { return false; }

  // A project root must claim to be a root, or Project recurses through
  // getParent() forever looking for one.
  isRoot() { return this.isProjectRoot || this.remotePath === '/'; }

  // Answering false here would make Pulsar drop the root before we ever
  // connect, and this cannot wait on the network.
  existsSync() { return true; }

  getParent() {
    if (this.isRoot()) { return this; }
    return new RemoteDirectory(this.connection, path.dirname(this.remotePath));
  }

  getFile(...parts) {
    return new RemoteFile(this.connection, path.join(this.remotePath, ...parts));
  }

  // git-repository-provider calls this on every project root. Without it,
  // adding the root throws "directory.getSubdirectory is not a function".
  getSubdirectory(...parts) {
    return new RemoteDirectory(this.connection, path.join(this.remotePath, ...parts));
  }

  resolve(relativePath = '') {
    if (!relativePath) { return this.getPath(); }
    if (relativePath.startsWith('ssh://')) { return relativePath; }
    return this.connection.destination.toURI(path.resolve(this.remotePath, relativePath));
  }

  contains(uri) {
    const remote = this.toRemotePath(uri);
    if (remote === null) { return false; }
    if (remote === this.remotePath) { return false; }

    const prefix = this.remotePath === '/' ? '/' : `${this.remotePath}/`;
    return remote.startsWith(prefix);
  }

  relativize(uri) {
    const remote = this.toRemotePath(uri);
    if (remote === null) { return uri; }
    if (remote === this.remotePath) { return ''; }

    const prefix = this.remotePath === '/' ? '/' : `${this.remotePath}/`;
    return remote.startsWith(prefix) ? remote.slice(prefix.length) : remote;
  }

  // Accepts an ssh:// URI for this host, or an already-remote path.
  toRemotePath(uri) {
    if (typeof uri !== 'string') { return null; }
    if (uri.startsWith('/')) { return uri; }

    const SSHDestination = require('../ssh/ssh-destination');
    const parsed = SSHDestination.fromURI(uri);
    if (!parsed) { return null; }
    if (parsed.destination.toString() !== this.connection.destination.toString()) { return null; }

    return parsed.path;
  }

  /**
   * List this directory. Returns {directories, files}, each sorted by name,
   * directories first -- which is the order a tree wants to render.
   */
  async getEntries({ useCache = false } = {}) {
    if (useCache && this.entryCache) { return this.entryCache; }

    const sftp = await this.connection.sftp();
    const listing = await new Promise((resolve, reject) => {
      sftp.readdir(this.remotePath, (err, entries) => err ? reject(err) : resolve(entries || []));
    });

    const directories = [];
    const files = [];

    for (const entry of listing) {
      const childPath = path.join(this.remotePath, entry.filename);
      const attrs = entry.attrs;

      // A symlink's own stat says "link"; what matters for the tree is what it
      // points at. Resolve it, and treat a broken link as a file.
      let isDirectory = attrs.isDirectory();
      if (attrs.isSymbolicLink()) {
        isDirectory = await this.symlinkPointsToDirectory(sftp, childPath);
      }

      if (isDirectory) {
        directories.push(new RemoteDirectory(this.connection, childPath));
      } else {
        files.push(new RemoteFile(this.connection, childPath, { exists: true, stats: attrs }));
      }
    }

    const byName = (a, b) => a.getBaseName().localeCompare(b.getBaseName());
    directories.sort(byName);
    files.sort(byName);

    this.entryCache = { directories, files };
    return this.entryCache;
  }

  symlinkPointsToDirectory(sftp, linkPath) {
    return new Promise(resolve => {
      sftp.stat(linkPath, (err, stats) => resolve(!err && stats.isDirectory()));
    });
  }

  clearCache() { this.entryCache = null; }

  async create() {
    const sftp = await this.connection.sftp();
    return new Promise((resolve, reject) => {
      sftp.mkdir(this.remotePath, err => err ? reject(err) : resolve());
    });
  }

  // Pulsar subscribes to this instead of using the native pathwatcher when it
  // is present. Nothing watches the remote side yet, so it only reports what
  // this editor does.
  onDidChangeFiles(callback) { return this.emitter.on('did-change-files', callback); }

  destroy() { this.emitter.dispose(); }
}

module.exports = RemoteDirectory;
