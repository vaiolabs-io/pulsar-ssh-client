// Derived from https://github.com/jeanp413/open-remote-ssh (MIT)
// Copyright (c) 2022 Jean Pierre (jeanp413) and open-remote-ssh contributors
// See LICENSE-open-remote-ssh.txt
//
// Decides how to authenticate, one method at a time.
//
// ssh2 calls the handler with the methods the server still allows, and we
// answer with the next thing to try. Returning false gives up. The order
// follows OpenSSH: publickey, then password, then keyboard-interactive.

const fs = require('fs');
const ssh2 = require('ssh2');

const logger = require('../logger');
const { promptForInput } = require('../ui/prompt');

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;
const KEYBOARD_RETRY_COUNT = 3;

/**
 * An agent that offers exactly one key.
 *
 * The agent decides its own order, which is rarely OpenSSH's, and a server's
 * MaxAuthTries (6 by default) can be exhausted before the right key is
 * reached. Offering one key per attempt puts us back in control of the order.
 *
 * Object.create keeps the prototype chain, so ssh2's `instanceof BaseAgent`
 * check still passes and sign() still delegates to the real agent.
 */
function singleKeyAgent(agentSock, parsedKey) {
  const agent = ssh2.createAgent(agentSock);
  const restricted = Object.create(agent);
  restricted.getIdentities = (callback) => callback(undefined, [parsedKey]);
  return restricted;
}

async function fileExists(filePath) {
  try { await fs.promises.access(filePath); return true; }
  catch { return false; }
}

// Read an encrypted key, prompting for the passphrase. Returns a parsed key,
// or null if the user gave up.
async function unlockKey(keyPath) {
  const buffer = await fs.promises.readFile(keyPath);
  let result = ssh2.utils.parseKey(buffer);

  if (!(result instanceof Error) || !/no passphrase given/i.test(result.message)) {
    return result instanceof Error ? null : result;
  }

  for (let attempt = 0; attempt < PASSPHRASE_RETRY_COUNT; attempt++) {
    const passphrase = await promptForInput({
      message: `Passphrase for ${keyPath}`,
      detail: attempt > 0 ? 'That passphrase did not work.' : undefined,
      password: true
    });
    if (passphrase === null) { return null; }

    result = ssh2.utils.parseKey(buffer, passphrase);
    if (!(result instanceof Error)) { return result; }
  }

  logger.error(`Gave up unlocking ${keyPath}`);
  return null;
}

function firstKey(result) {
  return Array.isArray(result) ? result[0] : result;
}

/**
 * Build an ssh2 authHandler.
 *
 * `identityKeys` is consumed as it goes: each publickey attempt shifts one
 * off, so a server that rejects a key gets the next one on the following call.
 */
function createAuthHandler({ user, hostname, identityKeys, preferredAuthentications, agentSock }) {
  const keys = identityKeys.slice();
  let passwordRetries = PASSWORD_RETRY_COUNT;
  let keyboardRetries = KEYBOARD_RETRY_COUNT;

  const wants = method => preferredAuthentications.includes(method);
  const target = `${user}@${hostname}`;

  return async function authHandler(methodsLeft, _partialSuccess, callback) {
    // A null method list means we have not asked the server anything yet.
    // "none" is how the server is made to declare what it accepts.
    if (methodsLeft === null) {
      logger.trace('Trying no-auth, to learn which methods the server offers');
      return callback({ type: 'none', username: user });
    }

    if (methodsLeft.includes('publickey') && keys.length && wants('publickey')) {
      const key = keys.shift();

      if (key.parsedKey) {
        const label = `${key.filename} ${key.parsedKey.type}`;
        logger.info(`Trying publickey: ${label}`);

        if (key.fromAgent) {
          return callback({
            type: 'agent',
            username: user,
            agent: singleKeyAgent(agentSock, key.parsedKey)
          });
        }
        if (key.isPrivate) {
          return callback({ type: 'publickey', username: user, key: key.parsedKey });
        }
        // We only have the public half, so the private file must be unlocked
        // before it can sign. Fall through.
      }

      if (!await fileExists(key.filename)) {
        logger.trace(`${key.filename} is gone, trying the next key`);
        return callback(null);
      }

      const unlocked = await unlockKey(key.filename);
      if (!unlocked) { return callback(null); }

      return callback({ type: 'publickey', username: user, key: firstKey(unlocked) });
    }

    if (methodsLeft.includes('password') && passwordRetries > 0 && wants('password')) {
      if (passwordRetries === PASSWORD_RETRY_COUNT) { logger.info('Trying password'); }

      const password = await promptForInput({
        message: `Password for ${target}`,
        detail: passwordRetries < PASSWORD_RETRY_COUNT ? 'That password was rejected.' : undefined,
        password: true
      });
      passwordRetries--;

      // null means dismissed. Do not send it as an empty password.
      return callback(password === null
        ? false
        : { type: 'password', username: user, password });
    }

    if (methodsLeft.includes('keyboard-interactive') && keyboardRetries > 0 && wants('keyboard-interactive')) {
      if (keyboardRetries === KEYBOARD_RETRY_COUNT) { logger.info('Trying keyboard-interactive'); }

      return callback({
        type: 'keyboard-interactive',
        username: user,
        // The server sends its own questions -- a TOTP code, a security
        // question. Ask each one in turn and send back the answers.
        prompt: async (_name, _instructions, _lang, prompts, finish) => {
          const responses = [];
          for (const prompt of prompts) {
            const response = await promptForInput({
              message: `(${target}) ${String(prompt.prompt).trim()}`,
              password: !prompt.echo
            });
            if (response === null) {
              keyboardRetries = 0;
              break;
            }
            responses.push(response);
          }
          keyboardRetries--;
          finish(responses);
        }
      });
    }

    logger.error(`No authentication method left for ${target}`);
    return callback(false);
  };
}

module.exports = { createAuthHandler, singleKeyAgent, PASSWORD_RETRY_COUNT };
