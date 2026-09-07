/*
 * Prove TextBuffer honours a duck-typed file object, with no local disk involved.
 *
 * text-buffer marks setFile() "Experimental" and there is no known shipping
 * consumer, so this pins the contract the remote filesystem is built on.
 * If this spec fails on a future Pulsar, the SFTP-backed design is broken.
 */

const { Readable, Writable } = require('stream');

// The duck type @pulsar-edit/text-buffer documents at src/text-buffer.js:556.
class FakeRemoteFile {
  constructor(path, contents) {
    this.path = path;
    this.contents = contents;
    this.written = null;
  }

  getPath() { return this.path; }
  existsSync() { return true; }

  createReadStream() {
    return Readable.from([Buffer.from(this.contents, 'utf8')]);
  }

  createWriteStream() {
    const chunks = [];
    const self = this;
    return new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
      final(cb) { self.written = Buffer.concat(chunks).toString('utf8'); cb(); }
    });
  }
}

describe('TextBuffer with a custom file object', () => {
  let TextBuffer;

  beforeEach(() => {
    TextBuffer = atom.workspace.buildTextEditor().getBuffer().constructor;
  });

  it('exposes a TextBuffer class with a static load()', () => {
    expect(typeof TextBuffer).toBe('function');
    expect(typeof TextBuffer.load).toBe('function');
  });

  it('loads text through createReadStream()', () => {
    const file = new FakeRemoteFile('ssh://host/tmp/hello.txt', 'line one\nline two\n');
    let buffer = null;

    waitsForPromise(() => TextBuffer.load(file).then(b => { buffer = b; }));

    runs(() => {
      expect(buffer.getText()).toBe('line one\nline two\n');
      expect(buffer.getPath()).toBe('ssh://host/tmp/hello.txt');
      expect(buffer.getLineCount()).toBe(3);
    });
  });

  it('saves text through createWriteStream()', () => {
    const file = new FakeRemoteFile('ssh://host/tmp/hello.txt', 'before\n');
    let buffer = null;

    waitsForPromise(() => TextBuffer.load(file).then(b => { buffer = b; }));

    runs(() => {
      buffer.setText('after\nedited\n');
      expect(buffer.isModified()).toBe(true);
    });

    waitsForPromise(() => buffer.save());

    runs(() => {
      expect(file.written).toBe('after\nedited\n');
      expect(buffer.isModified()).toBe(false);
    });
  });

  it('retargets an existing buffer with setFile()', () => {
    // buffer.load() as an instance method is deprecated, so static
    // TextBuffer.load(file) is the supported route. setFile() is what we need
    // for save-as and rename: it must redirect the save path to the new file.
    const first = new FakeRemoteFile('ssh://host/tmp/first.txt', 'first contents\n');
    const second = new FakeRemoteFile('ssh://host/tmp/second.txt', '');
    let buffer = null;

    waitsForPromise(() => TextBuffer.load(first).then(b => { buffer = b; }));

    runs(() => {
      expect(buffer.getText()).toBe('first contents\n');
      buffer.setFile(second);
      expect(buffer.getPath()).toBe('ssh://host/tmp/second.txt');
      buffer.setText('moved\n');
    });

    waitsForPromise(() => buffer.save());

    runs(() => {
      expect(second.written).toBe('moved\n');
      expect(first.written).toBe(null);
    });
  });

  it('opens such a buffer in a real TextEditor', () => {
    const file = new FakeRemoteFile('ssh://host/tmp/editor.txt', 'in an editor\n');
    let editor = null;

    waitsForPromise(() => TextBuffer.load(file).then(buffer => {
      editor = atom.workspace.buildTextEditor({ buffer });
    }));

    runs(() => {
      expect(editor.getText()).toBe('in an editor\n');
      expect(editor.getPath()).toBe('ssh://host/tmp/editor.txt');
    });
  });

  it('reaches the editor through atom.workspace.open() via an opener', () => {
    const file = new FakeRemoteFile('ssh://host/tmp/opened.txt', 'via opener\n');
    const disposable = atom.workspace.addOpener((uri) => {
      if (uri !== 'ssh://host/tmp/opened.txt') { return undefined; }
      return TextBuffer.load(file).then(
        buffer => atom.workspace.buildTextEditor({ buffer })
      );
    });
    let editor = null;

    waitsForPromise(() =>
      atom.workspace.open('ssh://host/tmp/opened.txt').then(e => { editor = e; })
    );

    runs(() => {
      expect(editor.getText()).toBe('via opener\n');
      expect(editor.getPath()).toBe('ssh://host/tmp/opened.txt');
      expect(atom.workspace.getActiveTextEditor()).toBe(editor);
      disposable.dispose();
    });
  });
});
