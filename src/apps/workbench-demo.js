import { WorkbenchShell }   from '../visualization/workbench/workbench-shell.js';
import {
  TimelinePlugin,
  GraphPlugin,
  MonteCarloPlugin,
  InspectorPlugin,
  LogPlugin,
} from './workbench-demo-plugins.js';

/* ── Boot ────────────────────────────────────────────────── */

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
    panelUrl:    'workbench-panel.html',
    channelName: 'sim-workbench-demo',
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
