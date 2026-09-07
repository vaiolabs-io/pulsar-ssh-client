// Pick a host to connect to.
//
// The list is every concrete Host in ssh_config, plus whatever the user types.
// Typing is not a fallback -- a host reachable by name or address need not be
// in ssh_config at all.

const SelectListView = require('atom-select-list');

const { SSHConfiguration } = require('../ssh/ssh-config');
const connectionManager = require('../connection-manager');

async function loadHostItems() {
  const config = await SSHConfiguration.loadFromFS();

  return config.getAllConfiguredHosts().map(host => {
    const hostConfig = config.getHostConfiguration(host);
    const parts = [];
    if (hostConfig.User) { parts.push(hostConfig.User); }
    if (hostConfig.HostName && hostConfig.HostName !== host) { parts.push(hostConfig.HostName); }
    if (hostConfig.Port) { parts.push(`port ${hostConfig.Port}`); }
    if (hostConfig.ProxyJump) { parts.push(`via ${hostConfig.ProxyJump}`); }

    return {
      host,
      detail: parts.join(' · '),
      connected: connectionManager.isConnected(host)
    };
  });
}

/**
 * Show the picker. Resolves to the chosen host string, or null if dismissed.
 */
function selectHost() {
  return new Promise(resolve => {
    let panel = null;
    let settled = false;

    const finish = (value) => {
      if (settled) { return; }
      settled = true;
      if (panel) { panel.destroy(); }
      selectList.destroy();
      if (previouslyFocused) { previouslyFocused.focus(); }
      resolve(value);
    };

    const previouslyFocused = document.activeElement;

    const selectList = new SelectListView({
      items: [],
      emptyMessage: 'No hosts in ~/.ssh/config — type a hostname',
      loadingMessage: 'Reading ~/.ssh/config…',

      elementForItem: (item) => {
        const element = document.createElement('li');
        element.classList.add('two-lines');

        const primary = document.createElement('div');
        primary.classList.add('primary-line');
        primary.textContent = item.host;
        if (item.connected) {
          const badge = document.createElement('span');
          badge.classList.add('pulsar-ssh-client-connected');
          badge.textContent = 'connected';
          primary.appendChild(badge);
        }
        element.appendChild(primary);

        if (item.detail) {
          const secondary = document.createElement('div');
          secondary.classList.add('secondary-line');
          secondary.textContent = item.detail;
          element.appendChild(secondary);
        }
        return element;
      },

      filterKeyForItem: (item) => `${item.host} ${item.detail}`,

      didConfirmSelection: (item) => finish(item.host),

      // Anything typed that matches no host is still a valid destination.
      didConfirmEmptySelection: () => {
        const typed = selectList.getFilterQuery().trim();
        finish(typed || null);
      },

      didCancelSelection: () => finish(null)
    });

    panel = atom.workspace.addModalPanel({ item: selectList });
    selectList.focus();

    loadHostItems().then(
      items => selectList.update({ items, loadingMessage: null }),
      err => selectList.update({
        items: [],
        loadingMessage: null,
        errorMessage: `Could not read ssh config: ${err.message}`
      })
    );
  });
}

module.exports = { selectHost, loadHostItems };
