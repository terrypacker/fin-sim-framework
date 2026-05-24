import '../assets/css/base.css';
import '../assets/css/themes/developer.css';
import '../assets/css/fin-sim.css';
import '../assets/css/workbench.css';
import '../assets/css/plugins/config-builder.css';
import '../assets/css/plugins/config-graph.css';
import '../assets/css/plugins/timeline.css';
import '../assets/css/plugins/state-panel.css';
import '../assets/css/plugins/dashboard.css';
import '../assets/css/plugins/chart.css';
import '../assets/css/plugins/inspector.css';
import '../assets/css/plugins/modals.css';
import '../assets/css/plugins/journal-report.css';
import '../assets/css/plugins/optimization.css';
import '../assets/css/plugins/monte-carlo.css';

import { SimulationWorkbench } from './apps/simulation-workbench.js';

document.addEventListener('DOMContentLoaded', () => {
  const app = new SimulationWorkbench();
  app.initView();
  app.initScenario();
});
