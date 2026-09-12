import { WorkbenchComponent } from '../../component.js';

export class StatePanelPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    root.innerHTML = `
      <div id="liveStatePanel">
        <input id="lsp-panel-filter" class="lsp-panel-filter" type="text"
               placeholder="Filter fields (e.g. marketValue, balance, USD_AUD)…" />
        <label class="lsp-text-toggle" title="Ids, symbols, labels and other text that does not change during a run. A filter that matches one shows it anyway.">
          <input id="lsp-show-text" type="checkbox" /> <span>Show text fields</span>
        </label>
        <div class="data-section-title">Metrics</div>
        <div id="cumulativeMetricsContent"></div>
        <div class="data-section-title lsp-state-toggle" id="stateSectionHeader">
          <span>State</span><span class="lsp-collapse-icon">&#x25B6;</span>
        </div>
        <div id="currentStateContent" style="display:none"></div>
      </div>
    `;
    return root;
  }
}
