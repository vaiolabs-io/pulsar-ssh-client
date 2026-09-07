const { promptForInput, promptForChoice } = require('../lib/ui/prompt');

function keydown(element, key) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true
  });
  element.dispatchEvent(event);
  return event;
}

function currentInput() {
  return document.querySelector('.pulsar-ssh-client-input input');
}

// A modal panel lives on the workspace element, which specs do not attach to
// the document by default -- and focus() does nothing on a detached element.
function attachWorkspace() {
  jasmine.attachToDOM(atom.views.getView(atom.workspace));
}

describe('promptForInput', () => {
  beforeEach(attachWorkspace);

  it('shows an input and focuses it', () => {
    const promise = promptForInput({ message: 'Password for ci@build' });

    const input = currentInput();
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);

    keydown(input, 'Escape');
    waitsForPromise(() => promise);
  });

  it('masks a password', () => {
    const promise = promptForInput({ message: 'Password', password: true });
    expect(currentInput().type).toBe('password');
    keydown(currentInput(), 'Escape');
    waitsForPromise(() => promise);
  });

  it('resolves with the typed value when Enter is pressed', () => {
    let resolved;
    const promise = promptForInput({ message: 'Password' })
      .then(value => { resolved = value; });

    const input = currentInput();
    input.value = 'hunter2';
    keydown(input, 'Enter');

    waitsForPromise(() => promise);
    runs(() => expect(resolved).toBe('hunter2'));
  });

  it('resolves null when Escape is pressed', () => {
    let resolved = 'unset';
    const promise = promptForInput({ message: 'Password' })
      .then(value => { resolved = value; });

    keydown(currentInput(), 'Escape');

    waitsForPromise(() => promise);
    runs(() => expect(resolved).toBe(null));
  });

  it('accepts an empty value as a deliberate answer', () => {
    // Distinct from dismissing: '' is an answer, null is a refusal.
    let resolved = 'unset';
    const promise = promptForInput({ message: 'Password' })
      .then(value => { resolved = value; });

    const input = currentInput();
    input.value = '';
    keydown(input, 'Enter');

    waitsForPromise(() => promise);
    runs(() => expect(resolved).toBe(''));
  });

  it('survives losing focus without cancelling itself', () => {
    // A password manager, devtools or the window manager taking focus must
    // not throw away a half-typed password.
    let resolved = 'unset';
    const promise = promptForInput({ message: 'Password' })
      .then(value => { resolved = value; });

    const input = currentInput();
    input.value = 'half-typed';
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));

    expect(resolved).toBe('unset');
    expect(currentInput()).toBeTruthy();

    input.focus();
    keydown(input, 'Enter');

    waitsForPromise(() => promise);
    runs(() => expect(resolved).toBe('half-typed'));
  });

  it('removes the panel once answered', () => {
    const promise = promptForInput({ message: 'Password' });
    keydown(currentInput(), 'Escape');

    waitsForPromise(() => promise);
    runs(() => expect(currentInput()).toBe(null));
  });

  it('does not leave the password in the DOM', () => {
    let captured = null;
    const promise = promptForInput({ message: 'Password', password: true })
      .then(value => { captured = value; });

    const input = currentInput();
    input.value = 'hunter2';
    keydown(input, 'Enter');

    waitsForPromise(() => promise);
    runs(() => {
      expect(captured).toBe('hunter2');
      expect(input.value).toBe('');
    });
  });
});

describe('promptForChoice', () => {
  beforeEach(attachWorkspace);

  it('resolves with the clicked choice', () => {
    let resolved;
    const promise = promptForChoice({
      message: 'Unknown host key',
      choices: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Connect once', value: 'once' }
      ]
    }).then(value => { resolved = value; });

    const buttons = [...document.querySelectorAll('.pulsar-ssh-client-choice button')];
    expect(buttons.length).toBe(2);
    buttons.find(b => b.textContent === 'Connect once').click();

    waitsForPromise(() => promise);
    runs(() => expect(resolved).toBe('once'));
  });

  it('resolves null on Escape', () => {
    let resolved = 'unset';
    const promise = promptForChoice({
      message: 'Unknown host key',
      choices: [{ label: 'Cancel', value: 'cancel' }]
    }).then(value => { resolved = value; });

    keydown(document.querySelector('.pulsar-ssh-client-choice'), 'Escape');

    waitsForPromise(() => promise);
    runs(() => expect(resolved).toBe(null));
  });
});
