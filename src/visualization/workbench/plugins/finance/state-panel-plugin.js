import { WorkbenchComponent } from '../../component.js';

export class StatePanelPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    root.innerHTML = `
      <div id="liveStatePanel">
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
