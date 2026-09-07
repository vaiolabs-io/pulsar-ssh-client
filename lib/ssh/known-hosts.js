// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Reads and appends ~/.ssh/known_hosts so a changed host key is caught.
//
// Upstream ships an equivalent file but never imports it, so open-remote-ssh
// accepts any host key silently. We wire this into ssh2's hostVerifier.
//
// Two things upstream's version does not do, added here because a partial
// check is worse than none: plaintext (unhashed) entries are matched, and the
// "[host]:port" form OpenSSH uses for non-22 ports is understood.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const KNOWN_HOSTS_FILE = path.join(SSH_DIR, 'known_hosts');
const HASH_MAGIC = '|1|';
const HASH_DELIM = '|';

// OpenSSH writes "host" for port 22 and "[host]:port" for anything else.
function hostAddress(hostname, port) {
  return (!port || port === 22) ? hostname : `[${hostname}]:${port}`;
}

function hashMatches(salt, expected, address) {
  const digest = crypto.createHmac('sha1', Buffer.from(salt, 'base64'))
    .update(address)
    .digest('base64');
  return digest === expected;
}

// A known_hosts line is "<patterns> <keytype> <base64 key> [comment]".
// Patterns are comma-separated, and may be hashed or plaintext.
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) { return null; }

  // "@revoked" / "@cert-authority" markers sit before the patterns.
  const parts = trimmed.split(/\s+/);
  const marker = parts[0].startsWith('@') ? parts.shift() : null;
  if (parts.length < 3) { return null; }

  return { marker, patterns: parts[0], keyType: parts[1], key: parts[2] };
}

function lineMatchesAddress(entry, address) {
  if (entry.patterns.startsWith(HASH_MAGIC)) {
    const [salt, expected] = entry.patterns.substring(HASH_MAGIC.length).split(HASH_DELIM);
    return salt && expected ? hashMatches(salt, expected, address) : false;
  }
  return entry.patterns.split(',').some(pattern => pattern === address);
}

async function readKnownHosts() {
  try {
    return await fs.promises.readFile(KNOWN_HOSTS_FILE, { encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'ENOENT') { return ''; }
    throw err;
  }
}

// 'match'    the host is known and this key is the one we have
// 'unknown'  the host is not in known_hosts at all
// 'changed'  the host is known but presented a different key -- the dangerous case
// 'revoked'  the key is explicitly marked @revoked
async function checkHostKey(hostname, port, keyType, hostKey) {
  const address = hostAddress(hostname, port);
  const presented = hostKey.toString('base64');
  let seenHost = false;

  for (const line of (await readKnownHosts()).split(/\r?\n/)) {
    const entry = parseLine(line);
    if (!entry || !lineMatchesAddress(entry, address)) { continue; }

    seenHost = true;
    if (entry.key === presented) {
      return entry.marker === '@revoked' ? 'revoked' : 'match';
    }
  }

  return seenHost ? 'changed' : 'unknown';
}

async function addHostKey(hostname, port, keyType, hostKey) {
  await fs.promises.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });

  // Hash the address, as OpenSSH does with HashKnownHosts: a leaked
  // known_hosts should not enumerate every machine the user reaches.
  const salt = crypto.randomBytes(20);
  const address = hostAddress(hostname, port);
  const digest = crypto.createHmac('sha1', salt).update(address).digest('base64');

  const entry = `${HASH_MAGIC}${salt.toString('base64')}${HASH_DELIM}${digest}` +
    ` ${keyType} ${hostKey.toString('base64')}\n`;

  const existing = await readKnownHosts();
  const separator = (existing && !existing.endsWith('\n')) ? '\n' : '';
  await fs.promises.appendFile(KNOWN_HOSTS_FILE, separator + entry, { mode: 0o600 });
}

function fingerprint(hostKey) {
  const digest = crypto.createHash('sha256').update(hostKey).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

module.exports = { checkHostKey, addHostKey, fingerprint, hostAddress, KNOWN_HOSTS_FILE };
