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
import '../assets/css/plugins/watchlist.css';
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
import '../assets/css/plugins/help.css';

import { SimulationWorkbench } from './apps/simulation-workbench.js';
import { ServiceRegistry }      from './services/service-registry.js';
import { hydrateAppStorage, getAppStorage, clearMigratedLegacyKeys,
         requestPersistentStorage } from './storage/create-storage.js';
import { registerServiceWorker } from './pwa/register-service-worker.js';

const STORAGE_STATUS = {
  'persisted':   { text: 'Storage: persistent',
                   title: 'The browser will not clear saved scenarios to free space' },
  'best-effort': { text: 'Storage: may be cleared',
                   title: 'The browser may clear saved scenarios under disk pressure or after '
                        + 'long disuse. Installing the app usually makes storage persistent; '
                        + 'Download JSON keeps a copy either way.' },
};

/** Status-bar note on whether saved scenarios are safe from eviction. */
function showStorageStatus(el, result) {
  const s = STORAGE_STATUS[result];
  if (!el || !s) return;
  el.textContent = s.text;
  el.title       = s.title;
  el.classList.toggle('storage-at-risk', result === 'best-effort');
  el.hidden = false;
}

document.addEventListener('DOMContentLoaded', async () => {
  // MUST complete before anything constructs ServiceRegistry: the scenario,
  // decision-graph and decision-record registries all load from storage in their
  // constructors, so an un-hydrated adapter would read as an empty profile and
  // then persist that emptiness over the user's real data.
  const storage = await hydrateAppStorage();
  console.info(`[storage] backend: ${storage.backendName}`);

  const app = new SimulationWorkbench();
  app.initView();
  app.initScenario();

  registerServiceWorker({ statusEl: document.getElementById('appUpdateStatus') });
  if (storage.backendName !== 'memory') {
    requestPersistentStorage().then(r => showStorageStatus(document.getElementById('storageStatus'), r));
  }

  // Expose debug handles for console benchmarking.
  window.ServiceRegistry = ServiceRegistry;
  window.__app = app;
  window.__storage = { getAppStorage, clearMigratedLegacyKeys };
});
