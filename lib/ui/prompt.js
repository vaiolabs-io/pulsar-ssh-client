// Modal prompts. Pulsar has no equivalent of vscode's showInputBox, so these
// are built from a workspace modal panel.
//
// Every prompt resolves to null when dismissed, and callers must treat that as
// "the user declined" -- never as an empty password.

const { CompositeDisposable } = require('atom');

function createModal(className) {
  const element = document.createElement('div');
  element.classList.add('pulsar-ssh-client-modal', className);
  return element;
}

function addText(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) { node.className = className; }
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

/**
 * Ask for a line of text. `password: true` masks it and keeps it out of the
 * DOM's value history.
 *
 * Resolves to the entered string, or null if the user pressed escape or
 * clicked away.
 */
function promptForInput({ message, detail, password = false, placeholder = '' }) {
  return new Promise(resolve => {
    const element = createModal('pulsar-ssh-client-input');
    addText(element, 'div', 'pulsar-ssh-client-message', message);
    if (detail) { addText(element, 'div', 'pulsar-ssh-client-detail', detail); }

    const input = document.createElement('input');
    input.type = password ? 'password' : 'text';
    input.className = 'input-text native-key-bindings';
    input.placeholder = placeholder;
    element.appendChild(input);

    const panel = atom.workspace.addModalPanel({ item: element });
    const subscriptions = new CompositeDisposable();
    let settled = false;

    const finish = (value) => {
      if (settled) { return; }
      settled = true;
      subscriptions.dispose();
      panel.destroy();
      // Do not leave a password sitting in a detached DOM node.
      input.value = '';
      resolve(value);
    };

    subscriptions.add(atom.commands.add(input, {
      'core:confirm': () => finish(input.value),
      'core:cancel': () => finish(null)
    }));
    subscriptions.add(panel.onDidChangeVisible(visible => {
      if (!visible) { finish(null); }
    }));

    input.addEventListener('blur', () => {
      // Blur fires while devtools steals focus; ignore unless still attached.
      if (document.hasFocus()) { finish(null); }
    });

    input.focus();
  });
}

/**
 * Ask a question with explicit buttons. `choices` is an array of
 * {label, value, className}. Resolves to the chosen value, or null.
 */
function promptForChoice({ message, detail, choices }) {
  return new Promise(resolve => {
    const element = createModal('pulsar-ssh-client-choice');
    addText(element, 'div', 'pulsar-ssh-client-message', message);
    if (detail) { addText(element, 'pre', 'pulsar-ssh-client-detail', detail); }

    const buttons = document.createElement('div');
    buttons.className = 'pulsar-ssh-client-buttons';
    element.appendChild(buttons);

    const panel = atom.workspace.addModalPanel({ item: element });
    const subscriptions = new CompositeDisposable();
    let settled = false;

    const finish = (value) => {
      if (settled) { return; }
      settled = true;
      subscriptions.dispose();
      panel.destroy();
      resolve(value);
    };

    for (const choice of choices) {
      const button = document.createElement('button');
      button.className = `btn ${choice.className || ''}`.trim();
      button.textContent = choice.label;
      button.addEventListener('click', () => finish(choice.value));
      buttons.appendChild(button);
    }

    subscriptions.add(atom.commands.add(element, {
      'core:cancel': () => finish(null)
    }));

    const firstButton = buttons.querySelector('button');
    if (firstButton) { firstButton.focus(); }
  });
}

module.exports = { promptForInput, promptForChoice };
