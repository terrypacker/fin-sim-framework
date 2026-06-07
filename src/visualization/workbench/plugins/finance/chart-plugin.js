import { WorkbenchComponent } from '../../component.js';

export class ChartPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }

  render() {
    const root = document.createElement('div');
    root.className = 'wb-chart-root';

    // Active-series chip strip (R7.3) — shows charted paths with click-to-remove.
    const activeSeries = document.createElement('div');
    activeSeries.id = 'chartActiveSeries';
    activeSeries.className = 'wb-chart-active-series';

    const failureBanner = document.createElement('div');
    failureBanner.id = 'failureBanner';
    failureBanner.className = 'failure-banner';
    failureBanner.style.cssText = 'display:none';
    failureBanner.innerHTML = `
      <span class="failure-banner-icon">&#x26A0;</span>
      <span>SCENARIO FAILED &#x2014; OUT OF FUNDS</span>
      <span class="failure-banner-deficit">
        shortfall: <span id="failureBannerDeficit">&#x2014;</span>
        over <span id="failureBannerMonths">&#x2014;</span> months
      </span>
      <span id="failureBannerDate" class="failure-banner-date"></span>
    `;

    // ECharts owns this div — no canvas needed.
    const vizWrap = document.createElement('div');
    vizWrap.className = 'wb-chart-viz';
    vizWrap.id = 'chartContainer';

    root.appendChild(activeSeries);
    root.appendChild(failureBanner);
    root.appendChild(vizWrap);

    return root;
  }

  onActivate() {
    // Safety-net resize in case the ResizeObserver missed the visibility change.
    window.dispatchEvent(new Event('resize'));
  }

  onAdopt(_fromPane, _toPane) {
    window.dispatchEvent(new Event('resize'));
  }
}
