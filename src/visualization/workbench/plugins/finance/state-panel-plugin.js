import { hostPanePlugin } from './host-pane-plugin.js';

/**
 * The State panel's markup. The RUNTIME owns it (see `WorkbenchRuntime.paneHost`) so the
 * panel can be closed without taking the state view down: `StatePanelView` renders into
 * it on every step and the app clears it on every rebuild, whether or not the tab is open.
 * It used to be minted in `render()` and found with `getElementById`, so with the tab
 * closed a sim step or a scenario import threw on `null`.
 */
export const STATE_PANEL_TEMPLATE = `
      <input id="lsp-panel-filter" class="lsp-panel-filter" type="text"
             placeholder="Filter fields (e.g. marketValue, balance, USD_AUD)…" />
      <label class="lsp-watchlist-picker" title="The watchlist a checkbox adds to. The chart plots its charted fields.">
        <span>Checking adds to</span>
        <select id="lsp-watchlist-select"></select>
      </label>
      <label class="lsp-text-toggle" title="Ids, symbols, labels and other text that does not change during a run. A filter that matches one shows it anyway.">
        <input id="lsp-show-text" type="checkbox" /> <span>Show text fields</span>
      </label>
      <div class="data-section-title lsp-state-toggle" id="stateSectionHeader">
        <span>State</span><span class="lsp-collapse-icon">&#x25BC;</span>
      </div>
      <div id="currentStateContent"></div>
    `;

/** The State panel's host options: one place, because the app and the plugin both ask. */
export const STATE_PANEL_HOST = { innerClass: '', template: STATE_PANEL_TEMPLATE };

export const StatePanelPlugin = hostPanePlugin('liveStatePanel', STATE_PANEL_HOST);
