import { WorkbenchRuntime, WB_EVENTS } from '../visualization/workbench/workbench-runtime.js';
import { WorkbenchChannel, WB_PANEL }  from '../visualization/workbench/workbench-channel.js';
import {
  TimelinePlugin,
  GraphPlugin,
  MonteCarloPlugin,
  InspectorPlugin,
  LogPlugin,
} from './workbench-demo-plugins.js';

const PLUGINS = {
  timeline:   { title: 'Timeline',    component: TimelinePlugin   },
  graph:      { title: 'Graph',       component: GraphPlugin      },
  montecarlo: { title: 'Monte Carlo', component: MonteCarloPlugin },
  inspector:  { title: 'Inspector',   component: InspectorPlugin  },
  log:        { title: 'Log',         component: LogPlugin        },
};

const CHANNEL_EVENTS = [
  WB_EVENTS.SELECTION_CHANGED,
  WB_EVENTS.RUNTIME_TICK,
  WB_EVENTS.SCENARIO_READY,
];

document.addEventListener('DOMContentLoaded', () => {
  const params     = new URLSearchParams(location.search);
  const tabId      = params.get('tab') ?? '';
  const sourcePane = params.get('source') ?? 'left';
  const descriptor = PLUGINS[tabId];

  if (!descriptor) {
    document.body.textContent = `Unknown panel: "${tabId}"`;
    return;
  }

  document.title = descriptor.title + ' — Workbench Panel';
  const titleEl = document.getElementById('wb-panel-title');
  if (titleEl) titleEl.textContent = descriptor.title;

  const runtime = new WorkbenchRuntime();
  const channel = new WorkbenchChannel('sim-workbench-demo');
  channel.attachBus(runtime.bus, CHANNEL_EVENTS);

  const root = document.getElementById('wb-panel-root');
  const plugin = new descriptor.component(runtime);
  plugin.mount(root);

  window.addEventListener('beforeunload', () => {
    channel.post({ type: WB_PANEL.CLOSING, tabId, sourcePane });
    channel.close();
  });
});
