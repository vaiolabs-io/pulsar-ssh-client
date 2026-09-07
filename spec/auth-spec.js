const { createAuthHandler } = require('../lib/ssh/auth');

function attachWorkspace() {
  jasmine.attachToDOM(atom.views.getView(atom.workspace));
}

function currentInput() {
  return document.querySelector('.pulsar-ssh-client-input input');
}

function keydown(element, key) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function answerPrompt(text) {
  const input = currentInput();
  input.value = text;
  keydown(input, 'Enter');
}

function handlerFor(methods) {
  return createAuthHandler({
    user: 'ci',
    hostname: 'build',
    identityKeys: [],
    preferredAuthentications: methods,
    agentSock: undefined
  });
}

describe('createAuthHandler', () => {
  beforeEach(attachWorkspace);

  it('starts with "none", to learn what the server accepts', () => {
    const handler = handlerFor(['password']);
    let result = null;

    waitsForPromise(() => new Promise(resolve => {
      handler(null, false, value => { result = value; resolve(); });
    }));

    runs(() => {
      expect(result.type).toBe('none');
      expect(result.username).toBe('ci');
    });
  });

  it('sends the password the user actually typed', () => {
    // This is the path that was broken: the prompt appeared but Enter did
    // nothing, so authentication could never proceed.
    const handler = handlerFor(['password']);
    let result = null;

    const answered = new Promise(resolve => {
      handler(['password'], false, value => { result = value; resolve(); });
    });

    waitsFor('the password prompt', () => currentInput() !== null, 3000);
    runs(() => answerPrompt('hunter2'));
    waitsForPromise(() => answered);

    runs(() => {
      expect(result.type).toBe('password');
      expect(result.username).toBe('ci');
      expect(result.password).toBe('hunter2');
    });
  });

  it('gives up rather than sending an empty password when dismissed', () => {
    const handler = handlerFor(['password']);
    let result = 'unset';

    const answered = new Promise(resolve => {
      handler(['password'], false, value => { result = value; resolve(); });
    });

    waitsFor('the password prompt', () => currentInput() !== null, 3000);
    runs(() => keydown(currentInput(), 'Escape'));
    waitsForPromise(() => answered);

    runs(() => expect(result).toBe(false));
  });

  it('retries a rejected password up to three times, then stops', () => {
    const handler = handlerFor(['password']);
    const results = [];

    function attempt() {
      return new Promise(resolve => {
        handler(['password'], false, value => { results.push(value); resolve(); });
      });
    }

    // Three prompts...
    for (let i = 0; i < 3; i++) {
      let done = null;
      runs(() => { done = attempt(); });
      waitsFor(`prompt ${i + 1}`, () => currentInput() !== null, 3000);
      runs(() => answerPrompt(`wrong${i}`));
      waitsForPromise(() => done);
    }

    // ...and then it refuses rather than prompting forever.
    waitsForPromise(() => attempt());

    runs(() => {
      expect(results.length).toBe(4);
      expect(results.slice(0, 3).map(r => r.password)).toEqual(['wrong0', 'wrong1', 'wrong2']);
      expect(results[3]).toBe(false);
      expect(currentInput()).toBe(null);
    });
  });

  it('asks each keyboard-interactive question in turn', () => {
    const handler = handlerFor(['keyboard-interactive']);
    let result = null;

    waitsForPromise(() => new Promise(resolve => {
      handler(['keyboard-interactive'], false, value => { result = value; resolve(); });
    }));

    let answers = null;
    runs(() => {
      expect(result.type).toBe('keyboard-interactive');
      result.prompt('', '', '', [
        { prompt: 'Password: ', echo: false },
        { prompt: 'Verification code: ', echo: true }
      ], responses => { answers = responses; });
    });

    waitsFor('the first question', () => currentInput() !== null, 3000);
    runs(() => {
      expect(currentInput().type).toBe('password');   // echo false
      answerPrompt('hunter2');
    });

    waitsFor('the second question', () => currentInput() !== null, 3000);
    runs(() => {
      expect(currentInput().type).toBe('text');       // echo true
      answerPrompt('123456');
    });

    waitsFor('the answers', () => answers !== null, 3000);
    runs(() => expect(answers).toEqual(['hunter2', '123456']));
  });

  it('honours PreferredAuthentications by refusing a method not listed', () => {
    const handler = handlerFor(['publickey']);
    let result = 'unset';

    waitsForPromise(() => new Promise(resolve => {
      handler(['password', 'keyboard-interactive'], false, value => {
        result = value;
        resolve();
      });
    }));

    // No keys were supplied and password is not preferred, so there is
    // nothing left to try. It must not prompt.
    runs(() => {
      expect(result).toBe(false);
      expect(currentInput()).toBe(null);
    });
  });
});
