// An in-memory stand-in for an ssh2 SFTP channel, enough to exercise
// RemoteFile and RemoteDirectory without a server.

const { Readable } = require('stream');
const path = require('path').posix;

class Attrs {
  constructor({ mode = 0o644, size = 0, directory = false, symlink = false }) {
    this.mode = mode;
    this.size = size;
    this.directory = directory;
    this.symlink = symlink;
  }
  isDirectory() { return this.directory; }
  isFile() { return !this.directory && !this.symlink; }
  isSymbolicLink() { return this.symlink; }
}

class FakeSFTP {
  constructor() {
    this.files = new Map();       // path -> {contents: Buffer, mode}
    this.directories = new Set(['/']);
    this.symlinks = new Map();    // path -> target path
    this.calls = [];
    this.failures = new Map();    // method -> Error to throw once
    this.supportsPosixRename = true;
  }

  // --- test helpers -------------------------------------------------------

  addFile(filePath, contents, mode = 0o644) {
    this.files.set(filePath, { contents: Buffer.from(contents), mode });
    this.addDirectory(path.dirname(filePath));
  }

  addDirectory(dirPath) {
    let current = dirPath;
    while (current && current !== '/') {
      this.directories.add(current);
      current = path.dirname(current);
    }
    this.directories.add('/');
  }

  addSymlink(linkPath, targetPath) {
    this.symlinks.set(linkPath, targetPath);
    this.addDirectory(path.dirname(linkPath));
  }

  failOnce(method, error) { this.failures.set(method, error); }

  readContents(filePath) {
    const file = this.files.get(filePath);
    return file ? file.contents.toString('utf8') : null;
  }

  entriesIn(dirPath) {
    const names = new Set();
    for (const filePath of this.files.keys()) {
      if (path.dirname(filePath) === dirPath) { names.add(path.basename(filePath)); }
    }
    for (const dir of this.directories) {
      if (dir !== '/' && path.dirname(dir) === dirPath) { names.add(path.basename(dir)); }
    }
    for (const link of this.symlinks.keys()) {
      if (path.dirname(link) === dirPath) { names.add(path.basename(link)); }
    }
    return [...names];
  }

  checkFailure(method) {
    const error = this.failures.get(method);
    if (error) { this.failures.delete(method); return error; }
    return null;
  }

  // --- ssh2 SFTP surface --------------------------------------------------

  stat(target, callback) {
    this.calls.push(['stat', target]);
    const resolved = this.symlinks.get(target) || target;

    if (this.directories.has(resolved)) {
      return process.nextTick(() => callback(null, new Attrs({ directory: true, mode: 0o755 })));
    }
    const file = this.files.get(resolved);
    if (file) {
      return process.nextTick(() =>
        callback(null, new Attrs({ mode: file.mode, size: file.contents.length })));
    }
    const err = new Error(`No such file: ${target}`);
    err.code = 2;
    process.nextTick(() => callback(err));
  }

  readdir(dirPath, callback) {
    this.calls.push(['readdir', dirPath]);
    if (!this.directories.has(dirPath)) {
      const err = new Error(`No such directory: ${dirPath}`);
      err.code = 2;
      return process.nextTick(() => callback(err));
    }

    const entries = this.entriesIn(dirPath).map(name => {
      const full = path.join(dirPath, name);
      if (this.symlinks.has(full)) {
        return { filename: name, attrs: new Attrs({ symlink: true }) };
      }
      if (this.directories.has(full)) {
        return { filename: name, attrs: new Attrs({ directory: true, mode: 0o755 }) };
      }
      const file = this.files.get(full);
      return { filename: name, attrs: new Attrs({ mode: file.mode, size: file.contents.length }) };
    });

    process.nextTick(() => callback(null, entries));
  }

  createReadStream(filePath) {
    this.calls.push(['createReadStream', filePath]);
    const file = this.files.get(filePath);
    if (!file) {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(new Error(`No such file: ${filePath}`)));
      return stream;
    }
    return Readable.from([file.contents]);
  }

  writeFile(filePath, contents, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    this.calls.push(['writeFile', filePath]);

    const failure = this.checkFailure('writeFile');
    if (failure) { return process.nextTick(() => callback(failure)); }

    this.files.set(filePath, {
      contents: Buffer.from(contents),
      mode: options.mode === undefined ? 0o644 : options.mode
    });
    process.nextTick(() => callback(null));
  }

  readFile(filePath, callback) {
    this.calls.push(['readFile', filePath]);
    const file = this.files.get(filePath);
    if (!file) {
      const err = new Error(`No such file: ${filePath}`);
      err.code = 2;
      return process.nextTick(() => callback(err));
    }
    process.nextTick(() => callback(null, file.contents));
  }

  unlink(filePath, callback) {
    this.calls.push(['unlink', filePath]);
    this.files.delete(filePath);
    process.nextTick(() => callback(null));
  }

  rename(from, to, callback) {
    this.calls.push(['rename', from, to]);
    const failure = this.checkFailure('rename');
    if (failure) { return process.nextTick(() => callback(failure)); }

    // Plain SFTP rename must fail when the target exists.
    if (this.files.has(to)) {
      const err = new Error('Failure: target exists');
      err.code = 4;
      return process.nextTick(() => callback(err));
    }
    const file = this.files.get(from);
    if (!file) {
      const err = new Error(`No such file: ${from}`);
      err.code = 2;
      return process.nextTick(() => callback(err));
    }
    this.files.delete(from);
    this.files.set(to, file);
    process.nextTick(() => callback(null));
  }

  ext_openssh_rename(from, to, callback) {
    this.calls.push(['ext_openssh_rename', from, to]);
    if (!this.supportsPosixRename) {
      return process.nextTick(() => callback(new Error('Unsupported extension')));
    }
    const failure = this.checkFailure('ext_openssh_rename');
    if (failure) { return process.nextTick(() => callback(failure)); }

    const file = this.files.get(from);
    if (!file) {
      const err = new Error(`No such file: ${from}`);
      err.code = 2;
      return process.nextTick(() => callback(err));
    }
    this.files.delete(from);
    this.files.set(to, file);   // atomic overwrite
    process.nextTick(() => callback(null));
  }

  mkdir(dirPath, callback) {
    this.calls.push(['mkdir', dirPath]);
    this.addDirectory(dirPath);
    process.nextTick(() => callback(null));
  }

  end() {}
}

// Minimal stand-in for SSHConnection.
class FakeConnection {
  constructor(destination, sftp) {
    const SSHDestination = require('../lib/ssh/ssh-destination');
    this.destination = SSHDestination.parse(destination);
    this.sftpChannel = sftp;
  }
  sftp() { return Promise.resolve(this.sftpChannel); }
}

module.exports = { FakeSFTP, FakeConnection, Attrs };
