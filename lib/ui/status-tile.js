// A status bar tile showing which host is connected.

const connectionManager = require('../connection-manager');

function createStatusTile(statusBar) {
  const element = document.createElement('div');
  element.classList.add('inline-block', 'pulsar-ssh-client-status');

  const icon = document.createElement('span');
  icon.classList.add('icon', 'icon-radio-tower');
  element.appendChild(icon);

  const label = document.createElement('span');
  element.appendChild(label);

  element.addEventListener('click', () => {
    atom.commands.dispatch(atom.views.getView(atom.workspace), 'pulsar-ssh-client:connect-to-host');
  });

  const render = () => {
    const connections = connectionManager.getConnections();
    if (connections.length === 0) {
      element.style.display = 'none';
      return;
    }
    element.style.display = '';
    label.textContent = connections.length === 1
      ? ` ${connections[0].name}`
      : ` ${connections.length} hosts`;
    element.title = connections.map(c => c.name).join('\n');
  };

  render();
  const subscription = connectionManager.onDidChange(render);
  const tile = statusBar.addRightTile({ item: element, priority: 100 });

  return {
    dispose() {
      subscription.dispose();
      tile.destroy();
    }
  };
}

module.exports = { createStatusTile };
