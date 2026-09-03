import { WorkbenchComponent } from '../../component.js';

/**
 * ChartPlugin — the chart's chip strip, failure banner and ECharts viz.
 *
 * Unlike the plain shims this keeps a `render()` of its own, because the pane holds three
 * children rather than one. The VIZ div still comes from `WorkbenchRuntime.paneHost()`:
 * `ChartView` captures it at `initScenario()` and guards with `if (!this.container) return`,
 * so minting it here meant that a reader whose layout had this tab closed got a chart that
 * was permanently dead for the session — silently, and even after reopening the tab. Same
 * root cause as the boot crash, milder symptom.
 */
export class ChartPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
  }

  render() {
    const { outer: root, inner: vizWrap } =
      this._runtime.paneHost('chartContainer', { outerClass: 'wb-chart-root', innerClass: 'wb-chart-viz' });

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

    // Prepended so the order stays chips → banner → viz: the viz div is already the
    // host's child. Idempotent because the host outlives this panel's mounts.
    if (!root.querySelector('#chartActiveSeries')) root.prepend(activeSeries, failureBanner);

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
