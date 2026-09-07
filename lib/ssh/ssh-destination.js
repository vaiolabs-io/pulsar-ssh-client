// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Parses "[user@]host[:port]" into its parts, and maps between that and the
// ssh:// URIs used as buffer paths.
//
// Upstream also carries a hex/\xNN encoding to survive VS Code lowercasing a
// URI authority. Pulsar does not lowercase our paths, so that is dropped.

class SSHDestination {
  constructor(hostname, user, port) {
    this.hostname = hostname;
    this.user = user;
    this.port = port;
  }

  // "root@box:2222" -> {user: 'root', hostname: 'box', port: 2222}
  // lastIndexOf is deliberate: a username may contain '@'.
  static parse(dest) {
    let user;
    const atPos = dest.lastIndexOf('@');
    if (atPos !== -1) { user = dest.substring(0, atPos); }

    let port;
    const colonPos = dest.lastIndexOf(':');
    if (colonPos !== -1) {
      const parsed = parseInt(dest.substring(colonPos + 1), 10);
      if (!Number.isNaN(parsed)) { port = parsed; }
    }

    const start = atPos !== -1 ? atPos + 1 : 0;
    const end = colonPos !== -1 ? colonPos : dest.length;

    return new SSHDestination(dest.substring(start, end), user, port);
  }

  toString() {
    let result = this.hostname;
    if (this.user) { result = `${this.user}@${result}`; }
    if (this.port) { result = `${result}:${this.port}`; }
    return result;
  }

  // ssh://user@host:port/absolute/remote/path
  toURI(remotePath = '/') {
    const path = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
    return `ssh://${this.toString()}${path}`;
  }

  static fromURI(uri) {
    const match = /^ssh:\/\/([^/]+)(\/.*)?$/.exec(uri);
    if (!match) { return null; }
    return {
      destination: SSHDestination.parse(match[1]),
      path: match[2] || '/'
    };
  }

  static isRemoteURI(uri) {
    return typeof uri === 'string' && uri.startsWith('ssh://');
  }
}

module.exports = SSHDestination;
