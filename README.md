# pulsar-ssh-client

Edit files on a remote machine over SSH, from [Pulsar](https://pulsar-edit.dev).

**Nothing is installed on the remote host.** The package talks to the SFTP
subsystem that `sshd` already ships, so a machine you can `ssh` into is a
machine you can edit on — including hosts with no internet access, old glibc,
musl/Alpine, or an architecture nobody publishes binaries for.

This is a reimplementation of [Open Remote - SSH][ors] by **[jeanp413][jp]** for
Pulsar. See [Credits](#credits).

## Status

Early. See [CHANGELOG.md](CHANGELOG.md) for what works today.

## What it does

- Reads `~/.ssh/config` — `HostName`, `User`, `Port`, `IdentityFile`,
  `IdentitiesOnly`, `ProxyJump`, `ProxyCommand`, `ForwardAgent`,
  `PreferredAuthentications`, and `Include` globs.
- Finds keys the way OpenSSH does, including via `ssh-agent`.
- Verifies host keys against `~/.ssh/known_hosts` and warns when one changes.
- Opens remote files as ordinary Pulsar editors. No local copy, no temp file,
  no sync step — reads and writes stream over SFTP.
- Browses the remote host in its own file tree, in the left dock.
- Opens a remote shell, reusing the connection that is already authenticated.

## What it deliberately does not do

Pulsar has no remote extension host: there is no second copy of the editor that
can run on the remote machine. VS Code's Remote-SSH gets remote language
servers, project-wide search, file watching and debugging because Microsoft
ships a server binary that provides them. There is no equivalent to install.

So this package gives you **remote file editing, a remote file tree and a
remote shell**, and those features stay local to the files you have open. That is the honest trade for
requiring nothing on the remote host. If you need the full remote-IDE
experience, mount the host with `sshfs` and open the mountpoint as a normal
project folder.

## Requirements

Pulsar 1.121 or newer. Nothing on the remote but `sshd` with its default SFTP
subsystem enabled.

Unlike Open Remote - SSH, this package does **not** need `AllowTcpForwarding`.

## Credits

The SSH machinery in this package — identity-file discovery, `ssh_config`
parsing and `Include` resolution, the `ProxyCommand` tokenizer, `ProxyJump`
chaining, the agent-forwarding session, and the `known_hosts` handling — is
derived from **[Open Remote - SSH][ors]**, created by
**[Jean Pierre (jeanp413)][jp]** and maintained since 2024 by
**[Baptiste Augrain (daiyam)][ba]**. All of the hard-won correctness in those
parts is theirs.

Used under the MIT License. The upstream notice is preserved verbatim in
[LICENSE-open-remote-ssh.txt](LICENSE-open-remote-ssh.txt), and files derived
from it carry a header saying so.

Open Remote - SSH's own SSH connection wrapper is in turn derived from
[ssh2-promise][s2p] by Sanket Bajoria, also MIT. That credit is carried forward
here.

The remote-filesystem design follows the approach taken by
[Nuclide][nuclide]'s `RemoteFile` and `RemoteDirectory` (Facebook, MIT),
the only prior art for a virtual filesystem in this editor.

## License

MIT — see [LICENSE.md](LICENSE.md).

[ors]: https://github.com/jeanp413/open-remote-ssh
[jp]: https://github.com/jeanp413
[ba]: https://github.com/daiyam
[s2p]: https://github.com/sanketbajoria/ssh2-promise
[nuclide]: https://github.com/facebookarchive/nuclide
