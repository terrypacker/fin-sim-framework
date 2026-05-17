import { WorkbenchShell }     from '../visualization/workbench/workbench-shell.js';
import { WorkbenchComponent } from '../visualization/workbench/component.js';
import { WB_EVENTS }          from '../visualization/workbench/workbench-runtime.js';

/* ── Demo Plugins ────────────────────────────────────────────────── */

class TimelinePlugin extends WorkbenchComponent {
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

class GraphPlugin extends WorkbenchComponent {
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

class MonteCarloPlugin extends WorkbenchComponent {
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

class InspectorPlugin extends WorkbenchComponent {
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

class LogPlugin extends WorkbenchComponent {
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
    log.className = 'wb-muted';
    log.style.cssText = 'font-size:11px;margin:0;padding:8px;overflow:auto;max-height:300px';
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

/* ── Boot ────────────────────────────────────────────────────────── */

const DEFAULT_LAYOUT = {
  sizes: [1, 2, 1],
  left:   { tabs: ['timeline', 'graph'], active: 'timeline'   },
  center: { tabs: ['montecarlo'],        active: 'montecarlo' },
  right:  { tabs: ['inspector'],         active: 'inspector'  },
  bottom: { tabs: ['log'],               active: 'log'        },
  bottomSize: 200,
  bottomCollapsed: false,
};

document.addEventListener('DOMContentLoaded', () => {
  const shell = new WorkbenchShell({
    defaultLayout: DEFAULT_LAYOUT,
    plugins: [
      { id: 'timeline',   title: 'Timeline',    component: TimelinePlugin   },
      { id: 'graph',      title: 'Graph',       component: GraphPlugin      },
      { id: 'montecarlo', title: 'Monte Carlo', component: MonteCarloPlugin },
      { id: 'inspector',  title: 'Inspector',   component: InspectorPlugin  },
      { id: 'log',        title: 'Log',         component: LogPlugin        },
    ],
  });

  shell.init(document.getElementById('workbench-root'));

  const runtime = shell.runtime;
  let interval = null;

  document.getElementById('btnPlay').onclick = () => {
    if (runtime.sim.running) return;
    runtime.sim.running = true;
    interval = setInterval(() => {
      runtime.tick(runtime.sim.time + 1);
      document.getElementById('runtimeInfo').textContent = `time: ${runtime.sim.time}`;
    }, 800);
  };

  document.getElementById('btnStep').onclick = () => {
    runtime.tick(runtime.sim.time + 1);
    document.getElementById('runtimeInfo').textContent = `time: ${runtime.sim.time}`;
  };

  document.getElementById('btnReset').onclick = () => {
    clearInterval(interval);
    runtime.sim.running = false;
    runtime.tick(0);
    document.getElementById('runtimeInfo').textContent = 'time: 0';
  };

  document.getElementById('btnSave').onclick = () => {
    shell.saveLayout();
    alert('Layout saved');
  };

  document.getElementById('btnResetLayout').onclick = () => {
    shell.resetLayout();
  };
});
