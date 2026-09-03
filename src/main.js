import '../assets/css/tokens.css';
import '../assets/css/base.css';
import '../assets/css/typography.css';
import '../assets/css/components.css';
import '../assets/css/app-shell.css';
import '../assets/css/workbench.css';
import '../assets/css/plugins/config-builder.css';
import '../assets/css/plugins/config-graph.css';
import '../assets/css/plugins/timeline.css';
import '../assets/css/plugins/state-panel.css';
import '../assets/css/plugins/finance-cards.css';
import '../assets/css/plugins/inspector.css';
import '../assets/css/plugins/modals.css';
import '../assets/css/plugins/journal-report.css';
import '../assets/css/plugins/optimization.css';
import '../assets/css/plugins/monte-carlo.css';
import '../assets/css/plugins/scenario-compare.css';
import '../assets/css/plugins/decision-graph.css';
import '../assets/css/plugins/cross-action-query.css';
import '../assets/css/plugins/holdings.css';
import '../assets/css/plugins/securities.css';
import '../assets/css/plugins/allocation.css';
import '../assets/css/plugins/spending.css';
import '../assets/css/plugins/liquidity-pools.css';
import '../assets/css/plugins/paycheque.css';
import '../assets/css/plugins/mpc-cockpit.css';

import { SimulationWorkbench } from './apps/simulation-workbench.js';
import { ServiceRegistry }      from './services/service-registry.js';

document.addEventListener('DOMContentLoaded', () => {
  const app = new SimulationWorkbench();
  app.initView();
  app.initScenario();

  // Expose debug handles for console benchmarking.
  window.ServiceRegistry = ServiceRegistry;
  window.__app = app;
});
