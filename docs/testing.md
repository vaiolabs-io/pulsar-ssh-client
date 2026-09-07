# Testing

```bash
pulsar --test spec
```

That runs everything except the integration specs, which skip themselves when
no test host is configured. They are the ones that matter most, so read on.

## Why there are two kinds of test

Most specs run against `spec/fake-sftp.js`, an in-memory SFTP server. It is
fast and it can simulate failures a real server will not do on demand — a full
disk mid-save, a rename that is refused.

But a fake only encodes what its author *believed* the protocol does. Those
beliefs can be wrong, and then the suite passes while the package fails on
first contact with a real server. `spec/real-sshd-spec.js` checks them against
an actual `sshd`.

Beliefs it has caught or confirmed so far:

- plain SFTP `rename` refuses an existing target, so an atomic save needs
  `posix-rename@openssh.com`
- a symlink's own `stat` reports a link, not what it points at
- the file mode survives a save through a temp file and a rename
- none of this needs `AllowTcpForwarding`

## Running the integration specs

They read four environment variables and skip entirely without them:

```bash
PULSAR_SSH_TEST_HOST=127.0.0.1 \
PULSAR_SSH_TEST_PORT=2222 \
PULSAR_SSH_TEST_USER=tester \
PULSAR_SSH_TEST_KEY=/path/to/private_key \
pulsar --test spec
```

`PULSAR_SSH_TEST_DIR` optionally sets the scratch directory used on the remote.
It defaults to `/tmp/pulsar-ssh-spec-<pid>` and is removed after each spec.

### The easy way: a container

```bash
sudo script/test-host.sh start
eval "$(sudo script/test-host.sh -- env)"
pulsar --test spec
sudo script/test-host.sh stop
```

The container sets `AllowTcpForwarding no` deliberately. Open Remote - SSH
requires that option; this package must not.

### The fallback: an unprivileged sshd

The container needs Docker with working container networking. Where that is
unavailable — a locked-down sandbox, a CI runner without a bridge — `sshd` can
be run directly, as your own user, on a high port. No root, no container.

```bash
cd /tmp && mkdir -p sshdtest && cd sshdtest

ssh-keygen -t ed25519 -N '' -f testkey -q
ssh-keygen -t ed25519 -N '' -f host_ed25519 -q
chmod 600 testkey host_ed25519

cat > sshd_config <<CONFIG
Port 2222
ListenAddress 127.0.0.1
HostKey $PWD/host_ed25519
PidFile $PWD/sshd.pid
AuthorizedKeysFile $PWD/testkey.pub
Subsystem sftp /usr/lib/openssh/sftp-server
AllowTcpForwarding no
StrictModes no
UsePAM no
PasswordAuthentication no
CONFIG

# An absolute path is required; sshd re-executes itself and refuses otherwise.
/usr/sbin/sshd -f "$PWD/sshd_config" -e -D &
```

Then point the specs at it as yourself:

```bash
PULSAR_SSH_TEST_HOST=127.0.0.1 \
PULSAR_SSH_TEST_PORT=2222 \
PULSAR_SSH_TEST_USER="$USER" \
PULSAR_SSH_TEST_KEY="$PWD/testkey" \
pulsar --test spec
```

`StrictModes no` is needed because the key lives outside `~/.ssh`. Never use
that in a real server config.

If there is no `sshd` on the machine, one can be lifted out of any container
image that has it:

```bash
docker create --name tmp-sshd ubuntu:24.04
docker cp tmp-sshd:/usr/sbin/sshd .
docker cp tmp-sshd:/usr/lib/openssh/sftp-server .
docker rm tmp-sshd
```

The binary is dynamically linked against glibc, so it runs on a host with the
same or newer glibc. An Ubuntu 24.04 `sshd` (glibc 2.39) runs on Debian 13
(glibc 2.41).

## What is still untested

- Password and keyboard-interactive authentication. Both prompt, so neither
  runs unattended.
- `ProxyJump` and `ProxyCommand`. The tokenizer has unit tests; the chaining
  does not, because it needs two hosts.
- Agent authentication, including the known gap where 2FA with an agent key
  fails on stock `ssh2`.
- A host key actually changing.
