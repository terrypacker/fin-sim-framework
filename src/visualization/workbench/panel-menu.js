import { PLUGIN_CATEGORY_LABELS } from './plugin-sdk.js';

/**
 * PanelMenu — the header's "Panels" drop-down: every registered panel, grouped by
 * category, ticked when its tab is open.
 *
 * It exists because closing a tab used to be one-way: the only route back was resetting
 * the whole layout, which also threw away every other arrangement. Ticking a panel opens
 * it in its default pane and brings it to the front; unticking closes it exactly as its
 * tab's × does (the instance and its state survive either way — see
 * `WorkbenchShell.closePlugin`).
 *
 * The list is rebuilt every time the menu opens and after every toggle, straight from
 * `shell.listPanels()`, so it cannot drift from tabs closed or dragged in the meantime.
 *
 * @param {object} opts
 * @param {import('./workbench-shell.js').WorkbenchShell} opts.shell
 * @param {HTMLElement} opts.button   — the header button that toggles the menu
 * @param {() => Array<{ label: string, run: Function }>} [opts.footerActions]
 *        — layout actions listed under the panels (revert / reset), asked for on every
 *          render because which ones apply depends on the current template state
 */
export class PanelMenu {
  constructor({ shell, button, footerActions }) {
    this._shell  = shell;
    this._button = button;
    this._footerActions = footerActions
      ?? (() => [{ label: 'Reset to default layout', run: () => shell.resetLayout() }]);
    this._menu   = null;

    this._onDocPointer = (e) => {
      if (!this._menu?.contains(e.target) && !this._button.contains(e.target)) this.close();
    };
    this._onKey = (e) => { if (e.key === 'Escape') { this.close(); this._button.focus(); } };

    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => (this._menu ? this.close() : this.open()));
  }

  open() {
    if (this._menu) return;
    const menu = document.createElement('div');
    menu.className = 'panel-menu';
    menu.setAttribute('role', 'menu');
    this._menu = menu;
    this._renderItems();
    document.body.appendChild(menu);
    this._position();

    document.addEventListener('pointerdown', this._onDocPointer, true);
    document.addEventListener('keydown', this._onKey);
    this._button.setAttribute('aria-expanded', 'true');
    this._button.classList.add('btn-primary');
  }

  close() {
    if (!this._menu) return;
    this._menu.remove();
    this._menu = null;
    document.removeEventListener('pointerdown', this._onDocPointer, true);
    document.removeEventListener('keydown', this._onKey);
    this._button.setAttribute('aria-expanded', 'false');
    this._button.classList.remove('btn-primary');
  }

  /** Right-aligned under the button, clamped to the viewport. */
  _position() {
    const b = this._button.getBoundingClientRect();
    const m = this._menu;
    m.style.top  = `${Math.round(b.bottom + 4)}px`;
    const left = Math.min(b.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8);
    m.style.left = `${Math.max(8, Math.round(left))}px`;
  }

  _renderItems() {
    const menu = this._menu;
    menu.innerHTML = '';

    const panels = this._shell.listPanels();
    const open   = panels.filter(p => p.pane).length;

    const head = document.createElement('div');
    head.className = 'panel-menu-head';
    head.textContent = `Panels · ${open} of ${panels.length} open`;
    menu.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'panel-menu-cols';
    menu.appendChild(cols);

    const order = Object.keys(PLUGIN_CATEGORY_LABELS);
    const byCat = new Map();
    for (const p of panels) {
      if (!byCat.has(p.category)) byCat.set(p.category, []);
      byCat.get(p.category).push(p);
    }
    const cats = [...byCat.keys()].sort((a, b) => rank(order, a) - rank(order, b));

    for (const cat of cats) {
      const group = document.createElement('div');
      group.className = 'panel-menu-group';
      group.setAttribute('role', 'group');

      const label = document.createElement('div');
      label.className = 'panel-menu-label';
      label.textContent = PLUGIN_CATEGORY_LABELS[cat] ?? cat;
      group.appendChild(label);

      const items = byCat.get(cat).sort((a, b) => a.title.localeCompare(b.title));
      for (const p of items) group.appendChild(this._item(p));
      cols.appendChild(group);
    }

    const actions = this._footerActions();
    if (actions.length) {
      const foot = document.createElement('div');
      foot.className = 'panel-menu-foot';
      for (const { label, run } of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'panel-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = label;
        btn.addEventListener('click', () => { this.close(); run(); });
        foot.appendChild(btn);
      }
      menu.appendChild(foot);
    }
  }

  _item({ id, title, pane }) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'panel-menu-item';
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('aria-checked', String(!!pane));
    item.title = pane ? `Close ${title}` : `Open ${title}`;

    const box = document.createElement('span');
    box.className = 'panel-menu-check';
    box.textContent = pane ? '✓' : '';
    const text = document.createElement('span');
    text.textContent = title;
    item.append(box, text);

    item.addEventListener('click', () => {
      if (pane) this._shell.closePlugin(id);
      else      this._shell.openPlugin(id);
      this._renderItems();
    });
    return item;
  }
}

function rank(order, cat) {
  const i = order.indexOf(cat);
  return i === -1 ? order.length : i;
}
