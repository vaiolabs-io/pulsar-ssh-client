# Changelog

## Unreleased

Foundation work. Not yet usable end to end.

### Added
- `ssh_config` parsing with `Include` glob resolution, including the fix for an
  `Include` written after a `Host` block being parsed as its child.
- `known_hosts` verification. Handles hashed and plaintext entries, the
  `[host]:port` form, and `@revoked` markers, and distinguishes an unknown host
  from a host whose key has changed.
- `ssh://user@host:port/path` destination parsing.
- Spec suite proving `TextBuffer` honours a custom file object, so remote files
  can be opened and saved without touching local disk.
