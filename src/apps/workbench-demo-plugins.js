import { WorkbenchComponent } from '../visualization/workbench/component.js';
import { WB_EVENTS }          from '../visualization/workbench/workbench-runtime.js';

export class TimelinePlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this.runtime = runtime;
    this._events = [
      { id: 'e1', year: '2028', title: 'Roth Conversion' },
      { id: 'e2', year: '2029', title: 'Semi Retirement'  },
      { id: 'e3', year: '2031', title: 'FIRE'             },
    ];
  }

  render() {
    const root = document.createElement('div');

    const hdr = document.createElement('div');
    hdr.className = 'wb-card';
    hdr.innerHTML = '<b>Timeline</b><div class="wb-muted">Runtime Journal View</div>';
    root.appendChild(hdr);

    this._events.forEach(ev => {
      const row = document.createElement('div');
      row.className = 'wb-card wb-event-row'
        + (this.runtime.selection?.id === ev.id ? ' selected' : '');
      row.innerHTML = `<b>${ev.title}</b><div class="wb-muted">${ev.year}</div>`;
      row.onclick = () => this.runtime.select({ type: 'event', id: ev.id, data: ev });
      root.appendChild(row);
    });

    return root;
  }

  onInit() {
    this.runtime.bus.subscribe(WB_EVENTS.SELECTION_CHANGED, () => this.rerender());
  }
}

export class GraphPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this.runtime = runtime;
  }

  render() {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="wb-card">
        <b>Execution Graph</b>
        <div class="wb-muted">Selection: ${this.runtime.selection?.id ?? 'none'}</div>
      </div>
      <div class="wb-card wb-muted">Drag nodes here (future phase)</div>
    `;
    return root;
  }

  onInit() {
    this.runtime.bus.subscribe(WB_EVENTS.SELECTION_CHANGED, () => this.rerender());
  }
}

export class MonteCarloPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this.runtime = runtime;
  }

  render() {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="wb-card"><b>Monte Carlo</b></div>
      <div class="wb-card">
        <div class="wb-muted">Success Rate</div>
        <div class="wb-metric">92%</div>
      </div>
      <div class="wb-card">
        <div class="wb-muted">Median Net Worth</div>
        <div class="wb-metric">$8.1M</div>
      </div>
    `;
    return root;
  }
}

export class InspectorPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this.runtime = runtime;
  }

  render() {
    const sel = this.runtime.selection;
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="wb-card">
        <b>Inspector</b>
        <div class="wb-muted">Selection: ${sel ? JSON.stringify(sel) : 'none'}</div>
      </div>
    `;
    return root;
  }

  onInit() {
    this.runtime.bus.subscribe(WB_EVENTS.SELECTION_CHANGED, () => this.rerender());
  }
}

export class LogPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this.runtime = runtime;
    this._lines = [];
  }

  render() {
    const root = document.createElement('div');

    const hdr = document.createElement('div');
    hdr.className = 'wb-card';
    hdr.innerHTML = `<b>Runtime Log</b><div class="wb-muted">time=${this.runtime.sim.time}</div>`;
    root.appendChild(hdr);

    const log = document.createElement('pre');
    log.className = 'wb-muted wb-demo-log';
    log.textContent = this._lines.slice(-50).join('\n') || '(no events yet)';
    root.appendChild(log);

    return root;
  }

  onInit() {
    this.runtime.bus.subscribe(WB_EVENTS.RUNTIME_TICK, ({ time }) => {
      this._lines.push(`tick  time=${time}`);
      if (this.mounted) this.rerender();
    });
    this.runtime.bus.subscribe(WB_EVENTS.SELECTION_CHANGED, ({ selection }) => {
      this._lines.push(`select  id=${selection?.id ?? 'none'}`);
      if (this.mounted) this.rerender();
    });
  }
}
