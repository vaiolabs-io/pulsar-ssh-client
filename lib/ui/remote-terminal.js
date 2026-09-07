// A shell on the remote host, in a Pulsar pane.
//
// Neither of Pulsar's terminal options can carry this. The bundled terminal
// package's service is only { run(commands), open() } -- the shell binary
// comes from config, and there is no way to hand it a stream. Spawning a local
// `ssh host` in someone else's terminal would work, but it authenticates a
// second time, which on a 2FA host means a second code.
//
// So this is xterm.js wired straight to a shell channel on the connection we
// already have. The pty is allocated by the remote sshd, so no node-pty and
// nothing to compile.

const { Emitter } = require('atom');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const logger = require('../logger');

const URI_PREFIX = 'atom://pulsar-ssh-client/terminal/';

// xterm ships its own stylesheet; a package cannot @import it from Less.
let stylesheetDisposable = null;
function ensureStylesheet() {
  if (stylesheetDisposable) { return; }
  const cssPath = require.resolve('@xterm/xterm/css/xterm.css');
  stylesheetDisposable = atom.themes.requireStylesheet(cssPath);
}

// Follow the editor's own font settings, so the terminal does not look pasted in.
function terminalFontSettings() {
  return {
    fontFamily: atom.config.get('editor.fontFamily') || 'monospace',
    fontSize: atom.config.get('editor.fontSize') || 14
  };
}

class RemoteTerminal {
  constructor(connection) {
    ensureStylesheet();

    this.connection = connection;
    this.emitter = new Emitter();
    this.stream = null;
    this.destroyed = false;

    this.element = document.createElement('div');
    this.element.classList.add('pulsar-ssh-client-terminal');

    const { fontFamily, fontSize } = terminalFontSettings();
    this.terminal = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      // Enough history to scroll back through a build log.
      scrollback: 5000,
      allowProposedApi: true
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.element);

    // The pane has no size until it is laid out, so fit on resize as well.
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.element);

    this.start();
  }

  getTitle() { return `Terminal — ${this.connection.name}`; }
  getURI() { return `${URI_PREFIX}${encodeURIComponent(this.connection.name)}`; }
  getIconName() { return 'terminal'; }
  getDefaultLocation() { return 'bottom'; }
  getAllowedLocations() { return ['bottom', 'center', 'left', 'right']; }

  onDidDestroy(callback) { return this.emitter.on('did-destroy', callback); }

  async start() {
    try {
      this.terminal.writeln(`Connecting to ${this.connection.name}…`);

      this.stream = await this.connection.shell({
        term: 'xterm-256color',
        cols: this.terminal.cols,
        rows: this.terminal.rows
      });

      this.terminal.clear();

      // Remote output to the screen.
      this.stream.on('data', data => {
        if (!this.destroyed) { this.terminal.write(data); }
      });
      if (this.stream.stderr) {
        this.stream.stderr.on('data', data => {
          if (!this.destroyed) { this.terminal.write(data); }
        });
      }

      // Typing to the remote.
      this.inputDisposable = this.terminal.onData(data => {
        if (this.stream && !this.destroyed) { this.stream.write(data); }
      });

      this.stream.on('close', () => {
        if (this.destroyed) { return; }
        this.terminal.writeln('\r\n\x1b[90m[session ended]\x1b[0m');
        this.stream = null;
      });

      this.fit();
      this.terminal.focus();
    } catch (err) {
      logger.error(`Could not open a shell on ${this.connection.name}: ${err.message}`);
      this.terminal.writeln(`\r\n\x1b[31mCould not open a shell: ${err.message}\x1b[0m`);
    }
  }

  /** Match the pty to the pane, so full-screen programs line up. */
  fit() {
    if (this.destroyed) { return; }

    try {
      this.fitAddon.fit();
    } catch {
      // fit throws while the element has no size; the next resize handles it.
      return;
    }

    if (this.stream && typeof this.stream.setWindow === 'function') {
      // ssh2 wants pixel dimensions too; 0 tells the far side to ignore them.
      this.stream.setWindow(this.terminal.rows, this.terminal.cols, 0, 0);
    }
  }

  destroy() {
    if (this.destroyed) { return; }
    this.destroyed = true;

    this.resizeObserver.disconnect();
    if (this.inputDisposable) { this.inputDisposable.dispose(); }
    if (this.stream) {
      try { this.stream.end(); } catch { /* already gone */ }
      this.stream = null;
    }
    this.terminal.dispose();

    this.emitter.emit('did-destroy');
    this.emitter.dispose();
    this.element.remove();
  }
}

module.exports = { RemoteTerminal, TERMINAL_URI_PREFIX: URI_PREFIX };
