const { CompositeDisposable } = require('atom');

let subscriptions = null;

module.exports = {
  activate() {
    subscriptions = new CompositeDisposable();
  },

  deactivate() {
    if (subscriptions) { subscriptions.dispose(); subscriptions = null; }
  },

  consumeStatusBar(_statusBar) {
    return null;
  }
};
