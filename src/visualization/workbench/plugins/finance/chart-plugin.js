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
/**
 * The chart's host, with its chip strip and failure banner, created with the host.
 *
 * Owned by the runtime for the same reason as the viz div: `ChartPresenter` renders the
 * chips and `StatePanelView` raises the banner whether or not this tab is open. They used
 * to be added on the panel's first mount, so a run that failed while the tab was closed
 * never showed the banner, even after reopening. Readers look inside `outer`; while the
 * tab is closed it is not in the document.
 *
 * @param {import('../../workbench-runtime.js').WorkbenchRuntime} runtime
 * @returns {{ outer: HTMLElement, inner: HTMLElement }} inner is the viz div
 */
export function chartHost(runtime) {
  const host = runtime.paneHost('chartContainer', { outerClass: 'wb-chart-root', innerClass: 'wb-chart-viz' });
  const root = host.outer;
  if (root.querySelector('#chartActiveSeries')) return host;

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

  // Prepended so the order stays chips → banner → viz: the viz div is already the host's child.
  root.prepend(activeSeries, failureBanner);
  return host;
}

export class ChartPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
  }

  render() {
    return chartHost(this._runtime).outer;
  }

  onActivate() {
    // Safety-net resize in case the ResizeObserver missed the visibility change.
    window.dispatchEvent(new Event('resize'));
  }

  onAdopt(_fromPane, _toPane) {
    window.dispatchEvent(new Event('resize'));
  }
}
