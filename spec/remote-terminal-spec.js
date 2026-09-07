const { EventEmitter } = require('events');
const { RemoteTerminal, TERMINAL_URI_PREFIX } = require('../lib/ui/remote-terminal');

// A stand-in for an ssh2 shell channel.
class FakeShellStream extends EventEmitter {
  constructor() {
    super();
    this.written = '';
    this.windows = [];
    this.ended = false;
    this.stderr = new EventEmitter();
  }
  write(data) { this.written += data; }
  setWindow(rows, cols, height, width) { this.windows.push({ rows, cols, height, width }); }
  end() { this.ended = true; }
}

class FakeConnection {
  constructor(name, { failWith = null } = {}) {
    this.name = name;
    this.failWith = failWith;
    this.stream = new FakeShellStream();
    this.shellOptions = null;
  }
  shell(options) {
    this.shellOptions = options;
    if (this.failWith) { return Promise.reject(new Error(this.failWith)); }
    return Promise.resolve(this.stream);
  }
}

// The shell is opened asynchronously; wait until it is attached.
function waitForShell(terminal) {
  waitsFor('the shell to attach', () => terminal.stream !== null, 3000);
}

describe('RemoteTerminal', () => {
  let terminal, connection;

  beforeEach(() => {
    connection = new FakeConnection('ci@build:2222');
    // xterm needs a laid-out element to measure itself.
    jasmine.attachToDOM(document.createElement('div'));
  });

  afterEach(() => {
    if (terminal) { terminal.destroy(); terminal = null; }
  });

  it('describes itself as a pane item', () => {
    terminal = new RemoteTerminal(connection);
    expect(terminal.getTitle()).toBe('Terminal — ci@build:2222');
    expect(terminal.getURI()).toBe(`${TERMINAL_URI_PREFIX}ci%40build%3A2222`);
    expect(terminal.getDefaultLocation()).toBe('bottom');
    expect(terminal.getAllowedLocations()).toContain('bottom');
  });

  it('asks for a pty with a real terminal type', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    runs(() => {
      expect(connection.shellOptions.term).toBe('xterm-256color');
      expect(connection.shellOptions.cols).toBeGreaterThan(0);
      expect(connection.shellOptions.rows).toBeGreaterThan(0);
    });
  });

  it('sends what the user types to the remote', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    runs(() => {
      // onData is what xterm fires for real keystrokes.
      terminal.terminal.input('ls -la\r');
      expect(connection.stream.written).toBe('ls -la\r');
    });
  });

  it('writes remote output to the screen', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    let written = null;
    runs(() => {
      spyOn(terminal.terminal, 'write').andCallFake(data => { written = data; });
      connection.stream.emit('data', Buffer.from('total 0\r\n'));
      expect(String(written)).toBe('total 0\r\n');
    });
  });

  it('writes remote stderr to the screen as well', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    let written = null;
    runs(() => {
      spyOn(terminal.terminal, 'write').andCallFake(data => { written = data; });
      connection.stream.stderr.emit('data', Buffer.from('permission denied\r\n'));
      expect(String(written)).toBe('permission denied\r\n');
    });
  });

  it('tells the remote pty when the pane is resized', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    runs(() => {
      connection.stream.windows.length = 0;
      terminal.fit();

      expect(connection.stream.windows.length).toBeGreaterThan(0);
      const last = connection.stream.windows[connection.stream.windows.length - 1];
      expect(last.rows).toBe(terminal.terminal.rows);
      expect(last.cols).toBe(terminal.terminal.cols);
    });
  });

  it('says so when the session ends', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    let line = null;
    runs(() => {
      spyOn(terminal.terminal, 'writeln').andCallFake(text => { line = text; });
      connection.stream.emit('close');

      expect(String(line)).toContain('session ended');
      expect(terminal.stream).toBe(null);
    });
  });

  it('reports a failure to open a shell in the pane', () => {
    const failing = new FakeConnection('ci@build:2222', { failWith: 'administratively prohibited' });
    terminal = new RemoteTerminal(failing);

    let line = null;
    spyOn(terminal.terminal, 'writeln').andCallFake(text => { line = text; });

    waitsFor('the failure to render', () => line !== null, 3000);

    runs(() => {
      expect(String(line)).toContain('administratively prohibited');
    });
  });

  it('closes the channel when the pane is closed', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    runs(() => {
      const stream = connection.stream;
      terminal.destroy();
      terminal = null;

      expect(stream.ended).toBe(true);
    });
  });

  it('ignores remote output arriving after it is destroyed', () => {
    terminal = new RemoteTerminal(connection);
    waitForShell(terminal);

    runs(() => {
      const stream = connection.stream;
      terminal.destroy();

      // A late packet must not touch a disposed xterm.
      expect(() => stream.emit('data', Buffer.from('late\r\n'))).not.toThrow();
      terminal = null;
    });
  });
});
