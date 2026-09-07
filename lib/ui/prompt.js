// Modal prompts. Pulsar has no equivalent of vscode's showInputBox, so these
// are built from a workspace modal panel.
//
// Every prompt resolves to null when dismissed, and callers must treat that as
// "the user declined" -- never as an empty password.

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
    let settled = false;

    const finish = (value) => {
      if (settled) { return; }
      settled = true;
      panel.destroy();
      // Do not leave a password sitting in a detached DOM node.
      input.value = '';
      resolve(value);
    };

    // Handled directly rather than through atom.commands.
    //
    // Pulsar's keymap does not bind enter to core:confirm on a plain <input> --
    // only on things like atom-text-editor[mini] and .select-list. Subscribing
    // to core:confirm here therefore never fires, and the prompt cannot be
    // submitted at all. Escape happens to work because core:cancel is bound on
    // body, but relying on that for one key and not the other is worse than
    // handling both here.
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    });

    // Deliberately no blur handler. Cancelling on blur throws away a
    // half-typed password whenever a password manager, the devtools or the
    // window manager takes focus, and document.hasFocus() does not
    // distinguish those from a real dismissal.

    // The panel must be in the document before focus() will do anything.
    if (input.isConnected) {
      input.focus();
    } else {
      requestAnimationFrame(() => { if (!settled) { input.focus(); } });
    }
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
    let settled = false;

    const finish = (value) => {
      if (settled) { return; }
      settled = true;
      panel.destroy();
      resolve(value);
    };

    element.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    });

    for (const choice of choices) {
      const button = document.createElement('button');
      button.className = `btn ${choice.className || ''}`.trim();
      button.textContent = choice.label;
      button.addEventListener('click', () => finish(choice.value));
      buttons.appendChild(button);
    }

    const firstButton = buttons.querySelector('button');
    if (firstButton) {
      if (firstButton.isConnected) { firstButton.focus(); }
      else { requestAnimationFrame(() => { if (!settled) { firstButton.focus(); } }); }
    }
  });
}

module.exports = { promptForInput, promptForChoice };
