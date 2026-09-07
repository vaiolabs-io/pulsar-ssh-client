// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Works out which keys to offer a host, in the order OpenSSH would offer them.
// Upstream follows sshconnect2.c; so do we.
// https://github.com/openssh/openssh-portable/blob/acb2059/sshconnect2.c#L1689-L1690
//
// Reading the .pub file first matters: a private key may be encrypted, and
// parsing it would need the passphrase before we know whether the server will
// even accept that key. The public half is enough to offer it.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ssh2 = require('ssh2');

const logger = require('../logger');
const { untildify } = require('./ssh-config');

// OpenSSH's default order, from ssh_config(5) IdentityFile.
const DEFAULT_IDENTITY_FILES = [
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
  'id_xmss',
  'id_dsa'
].map(name => path.join(os.homedir(), '.ssh', name));

function fingerprintOf(parsedKey) {
  return crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
}

// ssh2 returns a single key, an array of keys, or an Error.
function firstKeyOrError(result) {
  if (!result) { return new Error('unknown error parsing key'); }
  if (result instanceof Error) { return result; }
  return Array.isArray(result) ? result[0] : result;
}

async function readIfPresent(filePath) {
  try {
    return await fs.promises.readFile(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error(`Could not read SSH key ${filePath}: ${err.message}`);
    }
    return null;
  }
}

async function loadKeyFromFile(keyPath) {
  const publicKeyPath = `${keyPath}.pub`;
  const publicBuffer = await readIfPresent(publicKeyPath);

  if (publicBuffer) {
    const parsedKey = firstKeyOrError(ssh2.utils.parseKey(publicBuffer));
    if (!(parsedKey instanceof Error)) {
      return { filename: keyPath, parsedKey, fingerprint: fingerprintOf(parsedKey) };
    }
    // A .pub that is not an SSH key at all (a PGP key, say). Fall through to
    // the private file rather than discarding the identity.
    logger.warn(`${publicKeyPath} is not an SSH public key, reading the private key instead`);
  }

  const privateBuffer = await readIfPresent(keyPath);
  if (!privateBuffer) { return null; }

  const parsedKey = firstKeyOrError(ssh2.utils.parseKey(privateBuffer));
  if (parsedKey instanceof Error) {
    if (/no passphrase given/i.test(parsedKey.message)) {
      // Encrypted, and we have no passphrase yet. Offer it anyway; the auth
      // handler prompts and reparses when the server asks for this key.
      return { filename: keyPath, needsPassphrase: true };
    }
    logger.error(`Could not load SSH key ${keyPath}: ${parsedKey.message}`);
    return null;
  }

  return {
    filename: keyPath,
    parsedKey,
    fingerprint: fingerprintOf(parsedKey),
    isPrivate: true
  };
}

// createAgent picks PageantAgent, CygwinAgent or OpenSSHAgent by inspecting the
// value. Upstream constructs OpenSSHAgent directly, so Pageant users are
// unsupported there.
async function loadKeysFromAgent(sshAgentSock) {
  if (!sshAgentSock) { return []; }

  try {
    const agent = ssh2.createAgent(sshAgentSock);
    const parsedKeys = await new Promise((resolve, reject) => {
      agent.getIdentities((err, keys) => err ? reject(err) : resolve(keys || []));
    });

    return parsedKeys.map(parsedKey => ({
      filename: parsedKey.comment || '(agent key)',
      parsedKey,
      fingerprint: fingerprintOf(parsedKey),
      fromAgent: true
    }));
  } catch (err) {
    logger.error(`Could not list identities from the SSH agent: ${err.message}`);
    return [];
  }
}

/**
 * Returns the keys to offer, best first.
 *
 * A key held by both the agent and a file comes first: the agent can sign for
 * it without a passphrase prompt, and the file tells us the user asked for it
 * by name. Then agent-only keys, then file-only keys.
 *
 * `identitiesOnly` (IdentitiesOnly yes) drops agent keys the user did not
 * name in ssh_config. Without it, an agent holding many keys can exhaust
 * MaxAuthTries before reaching the right one.
 */
async function gatherIdentityFiles(identityFiles, sshAgentSock, identitiesOnly) {
  let candidates = (identityFiles || [])
    .map(untildify)
    .map(file => file.replace(/\.pub$/, ''));

  if (candidates.length === 0) { candidates = DEFAULT_IDENTITY_FILES; }

  const settled = await Promise.allSettled(candidates.map(loadKeyFromFile));
  const fileKeys = settled
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  const agentKeys = await loadKeysFromAgent(sshAgentSock);

  const both = [];
  const agentOnly = [];

  for (const agentKey of agentKeys) {
    const index = fileKeys.findIndex(fileKey =>
      fileKey.fingerprint === agentKey.fingerprint &&
      fileKey.parsedKey && fileKey.parsedKey.type === agentKey.parsedKey.type);

    if (index >= 0) {
      both.push({ ...fileKeys[index], fromAgent: true });
      fileKeys.splice(index, 1);
    } else if (!identitiesOnly) {
      agentOnly.push(agentKey);
    }
  }

  const ordered = [...both, ...agentOnly, ...fileKeys];

  logger.trace(ordered.length
    ? `Identity keys:\n${ordered.map(describeKey).join('\n')}`
    : 'Identity keys: none');

  return ordered;
}

function describeKey(key) {
  const type = key.parsedKey ? key.parsedKey.type : 'encrypted';
  const source = key.fromAgent ? ' (agent)' : '';
  const fingerprint = key.fingerprint ? ` SHA256:${key.fingerprint.replace(/=+$/, '')}` : '';
  return `  ${key.filename} ${type}${fingerprint}${source}`;
}

module.exports = { gatherIdentityFiles, fingerprintOf, describeKey, DEFAULT_IDENTITY_FILES };
