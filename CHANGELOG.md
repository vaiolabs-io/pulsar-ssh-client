# Changelog

## Unreleased

Remote files can be browsed, opened, edited and saved. The remote terminal is
not built yet.

### Added
- A remote file tree, in the left dock. Pulsar's own tree-view cannot show a
  remote root -- it calls `fs.lstatSyncNoException` on each project path and
  drops the ones that fail, with no error -- so this is a separate tree. It
  lists over SFTP, expands lazily, remembers which folders were open, and
  roots each host at its login directory.
- Connect to a host from a picker listing every `Host` in `~/.ssh/config`, or
  by typing a hostname that is not in it.
- Open, edit and save remote files. No local copy and no sync step: reads and
  writes stream over SFTP straight into the editor's buffer.
- Saves are atomic. Contents are written to a temporary file and renamed over
  the target with `posix-rename@openssh.com`, so a connection dropping
  mid-save cannot truncate the file. Falls back to `unlink`+`rename`, and then
  to a direct write where the server forbids creating a sibling file.
- The existing file mode is preserved across a save.
- `ssh_config` support: `HostName` (with `%h`), `User`, `Port`, `IdentityFile`,
  `IdentitiesOnly`, `IdentityAgent`, `ForwardAgent`,
  `PreferredAuthentications`, `ProxyJump`, `ProxyCommand`,
  `StrictHostKeyChecking`, `ConnectTimeout`, and `Include` globs.
- Authentication by public key, password and keyboard-interactive, trying keys
  in OpenSSH's own order and offering one key per attempt so a full agent
  cannot exhaust the server's `MaxAuthTries`.
- Host key verification against `known_hosts`, handling hashed and plaintext
  entries, `[host]:port`, and `@revoked`. A changed key is reported as such and
  is never offered a one-click override.
- Keepalives, so a dropped link surfaces as an error rather than a hang.
- One connection per host, shared: opening several files at once produces one
  authentication, not several.
- Status bar tile showing the connected host.

### Notes
- Requires nothing on the remote host but `sshd` and its default SFTP
  subsystem. No server binary is downloaded or installed.
- No native modules; nothing is compiled at install time.
