import { WorkbenchComponent } from '../../component.js';

export class ChartPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }

  render() {
    const root = document.createElement('div');
    root.className = 'wb-chart-root';

    const filterContainer = document.createElement('div');
    filterContainer.id = 'chartFilterContainer';

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

    const vizWrap = document.createElement('div');
    vizWrap.className = 'viz-wrap wb-chart-viz';

    const canvas = document.createElement('canvas');
    canvas.id = 'chartCanvas';
    canvas.className = 'wb-chart-canvas';

    vizWrap.appendChild(canvas);
    root.appendChild(filterContainer);
    root.appendChild(failureBanner);
    root.appendChild(vizWrap);

    return root;
  }

  onMount() {
    const canvas = this.el?.querySelector('#chartCanvas');
    const wrap   = canvas?.parentElement;
    if (!canvas || !wrap) return;
    this._ro = new ResizeObserver(() => {
      canvas.width  = wrap.clientWidth;
      canvas.height = wrap.clientHeight;
    });
    this._ro.observe(wrap);
  }

  onUnmount() {
    this._ro?.disconnect();
    this._ro = null;
  }

  onAdopt(_fromPane, _toPane) {
    // Notify BaseApp's resize handler so Chart.js redraws in the new container.
    window.dispatchEvent(new Event('resize'));
  }
}
