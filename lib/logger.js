// Log lines for the "SSH Client" output, mirrored to the devtools console.
//
// Upstream open-remote-ssh logs into a vscode OutputChannel; Pulsar has no
// equivalent, so lines are buffered here and rendered by the log panel.

const MAX_LINES = 2000;

class Logger {
  constructor() {
    this.lines = [];
    this.emitters = new Set();
  }

  onDidLog(callback) {
    this.emitters.add(callback);
    return { dispose: () => this.emitters.delete(callback) };
  }

  trace(message) { this.append('trace', message); }
  info(message) { this.append('info', message); }
  warn(message) { this.append('warn', message); }
  error(message) { this.append('error', message); }

  append(level, message) {
    const text = message instanceof Error ? (message.stack || message.message) : String(message);
    const line = { level, text, time: new Date() };

    this.lines.push(line);
    if (this.lines.length > MAX_LINES) { this.lines.shift(); }

    if (atom.inDevMode()) { console.log(`[ssh-client] ${level}: ${text}`); }
    for (const emitter of this.emitters) { emitter(line); }
  }

  getLines() { return this.lines.slice(); }

  clear() { this.lines = []; }
}

module.exports = new Logger();
