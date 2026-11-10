import { hostPanePlugin } from './host-pane-plugin.js';

/**
 * The Dashboard's five cards. The RUNTIME owns them (see `WorkbenchRuntime.paneHost`):
 * `DashCardsComponent` writes into them on every simulation event, open or not. They used
 * to be minted in `render()` and found with `getElementById`, so a closed Dashboard threw
 * on `null` once per render while the sim ran.
 */
export const DASHBOARD_TEMPLATE = `
      <div class="dash-card"><div class="dc-label">Current Date</div><div class="dc-value" id="cardCurrentDate">-</div></div>
      <div class="dash-card"><div class="dc-label">Total Events</div><div class="dc-value" id="cardEventExecutions">&#x2014;</div></div>
      <div class="dash-card"><div class="dc-label">Total Handlers</div><div class="dc-value" id="cardHandlerExecutions">&#x2014;</div></div>
      <div class="dash-card"><div class="dc-label">Total Actions</div><div class="dc-value" id="cardActionExecutions">&#x2014;</div></div>
      <div class="dash-card"><div class="dc-label">Total Reducers</div><div class="dc-value" id="cardReducerExecutions">&#x2014;</div></div>
    `;

/** The Dashboard's host options: one place, because the app and the plugin both ask. */
export const DASHBOARD_HOST = { outerClass: '', innerClass: 'fin-dash-cards', template: DASHBOARD_TEMPLATE };

export const DashboardPlugin = hostPanePlugin('dashCards', DASHBOARD_HOST);
