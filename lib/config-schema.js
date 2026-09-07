// Settings, shown under Settings -> Packages -> pulsar-ssh-client.
//
// Upstream has twelve settings. Seven of them configure the download and
// version-matching of the VSCodium server binary, which this package does not
// install, so they are gone. What remains is what still means something.

module.exports = {
  configFile: {
    order: 1,
    type: 'string',
    default: '',
    title: 'SSH config file',
    description: 'Absolute path to a custom SSH config file. Leave empty to use `~/.ssh/config`.'
  },
  connectTimeout: {
    order: 2,
    type: 'integer',
    default: 60,
    minimum: 1,
    title: 'Connect timeout',
    description: 'Seconds to wait for a host to answer before giving up.'
  },
  defaultDirectory: {
    order: 3,
    type: 'string',
    default: '.',
    title: 'Default directory',
    description: 'Directory to open when connecting to a host. `.` means the login directory.'
  },
  showHiddenFiles: {
    order: 4,
    type: 'boolean',
    default: false,
    title: 'Show hidden files',
    description: 'Show entries beginning with a dot in the remote tree.'
  },
  keepaliveInterval: {
    order: 5,
    type: 'integer',
    default: 15,
    minimum: 0,
    title: 'Keepalive interval',
    description: 'Seconds between keepalive probes. `0` disables them, which means a dropped connection looks like a hang rather than an error.'
  }
};
