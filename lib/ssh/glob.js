// Expand a shell-style glob against the filesystem.
//
// Only what OpenSSH's `Include` actually needs: `*`, `?` and `[...]` matched
// per path segment. `**` is not supported -- ssh_config(5) documents
// Include with patterns such as `config.d/*` and `ssh_config.d/*.conf`, and
// pulling in a full glob library for that is not worth the dependency.

const fs = require('fs');
const path = require('path');

function segmentToRegExp(segment) {
  let pattern = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') { pattern += '[^/]*'; }
    else if (ch === '?') { pattern += '[^/]'; }
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) { pattern += '\\['; }
      else {
        let set = segment.slice(i + 1, close);
        if (set.startsWith('!')) { set = `^${set.slice(1)}`; }
        pattern += `[${set}]`;
        i = close;
      }
    } else { pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp(`^${pattern}$`);
}

function hasMagic(segment) {
  return /[*?[]/.test(segment);
}

async function readdirSafe(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

// Returns absolute paths of existing files matching `pattern`, resolved
// against `cwd` when the pattern is relative.
async function glob(pattern, cwd) {
  const absolute = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
  const normalized = path.normalize(absolute);
  const { root } = path.parse(normalized);
  const segments = normalized.slice(root.length).split(path.sep).filter(Boolean);

  let candidates = [root];
  for (const segment of segments) {
    const next = [];
    if (!hasMagic(segment)) {
      for (const dir of candidates) { next.push(path.join(dir, segment)); }
    } else {
      const matcher = segmentToRegExp(segment);
      for (const dir of candidates) {
        for (const entry of await readdirSafe(dir)) {
          // A leading dot must be matched explicitly, as the shell does.
          if (entry.name.startsWith('.') && !segment.startsWith('.')) { continue; }
          if (matcher.test(entry.name)) { next.push(path.join(dir, entry.name)); }
        }
      }
    }
    candidates = next;
  }

  const results = [];
  for (const candidate of candidates) {
    try {
      if ((await fs.promises.stat(candidate)).isFile()) { results.push(candidate); }
    } catch { /* pattern matched something that is gone */ }
  }
  return results.sort();
}

module.exports = { glob };
