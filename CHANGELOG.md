# Changelog

## Unreleased

Remote files can be browsed, opened, edited and saved, and there is a remote
shell.

### Added
- A remote terminal, wired straight to a shell channel on the connection that
  is already open — so it does not authenticate a second time, which on a
  two-factor host would mean a second code. The pty is allocated by the remote
  `sshd`, so nothing is compiled locally.
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

### Fixed
- Password, passphrase and keyboard-interactive prompts could not be
  submitted. They subscribed to `core:confirm`, which Pulsar's keymap does not
  bind on a plain `<input>` — only on things like `atom-text-editor[mini]` and
  `.select-list` — so pressing Enter did nothing and there was no way to
  authenticate. Escape worked only because `core:cancel` is bound on `body`.
  Keys are now handled directly.
- A prompt cancelled itself when it lost focus, throwing away a half-typed
  password whenever a password manager, the devtools or the window manager
  took focus. The blur handler is gone.

### Notes
- Requires nothing on the remote host but `sshd` and its default SFTP
  subsystem. No server binary is downloaded or installed.
- No native modules; nothing is compiled at install time.
