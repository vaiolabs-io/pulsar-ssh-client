/*
 * Checks the things that live outside JavaScript and so break silently:
 * the Less stylesheet, the menu JSON, and whether the dock items actually
 * pick up their styles once rendered in a real window.
 *
 * Less that fails to compile and menu JSON that fails to parse both leave the
 * package "active" with the asset simply missing.
 */

describe('package assets', () => {
  let pkg;

  beforeEach(() => {
    waitsForPromise(() => atom.packages.activatePackage('pulsar-ssh-client'));
    runs(() => { pkg = atom.packages.getActivePackage('pulsar-ssh-client'); });
  });

  it('is active', () => {
    expect(pkg).toBeTruthy();
  });

  it('compiled and loaded its stylesheet', () => {
    expect(pkg.stylesheets.length).toBeGreaterThan(0);
  });

  it('parsed and loaded its menu', () => {
    expect(pkg.menus.length).toBeGreaterThan(0);
  });

  it('applies its styles to the tree once rendered', () => {
    let item = null;

    waitsForPromise(() =>
      atom.workspace.open('atom://pulsar-ssh-client/tree').then(result => { item = result; }));

    runs(() => {
      expect(item.getTitle()).toBe('Remote');
      jasmine.attachToDOM(item.element);

      // If the Less had failed to compile this would be 'visible'.
      expect(window.getComputedStyle(item.element).overflow).toBe('auto');
      item.destroy();
    });
  });

  it('shows the empty state before anything is connected', () => {
    let item = null;

    waitsForPromise(() =>
      atom.workspace.open('atom://pulsar-ssh-client/tree').then(result => { item = result; }));

    runs(() => {
      const empty = item.element.querySelector('.pulsar-ssh-client-empty');
      expect(empty).toBeTruthy();
      expect(empty.querySelector('button').textContent).toContain('Connect to Host');
      item.destroy();
    });
  });

  it('does not open a terminal for a host that is not connected', () => {
    let item = null;

    waitsForPromise(() =>
      atom.workspace.open('atom://pulsar-ssh-client/terminal/nobody%40offline')
        .then(result => { item = result; }));

    // No connection, so the opener declines and Pulsar falls through.
    runs(() => {
      expect(item && item.getTitle && item.getTitle().startsWith('Terminal')).toBeFalsy();
    });
  });
});
