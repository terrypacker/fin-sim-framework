import { WorkbenchComponent } from '../component.js';

export class DashboardPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'fin-dash-cards';
    root.innerHTML = `
      <div class="dash-card"><div class="dc-label">Current Date</div><div class="dc-value" id="cardCurrentDate">-</div></div>
      <div class="dash-card"><div class="dc-label">Total Events</div><div class="dc-value" id="cardEventExecutions">&#x2014;</div></div>
      <div class="dash-card"><div class="dc-label">Total Handlers</div><div class="dc-value" id="cardHandlerExecutions">&#x2014;</div></div>
      <div class="dash-card"><div class="dc-label">Total Actions</div><div class="dc-value" id="cardActionExecutions">&#x2014;</div></div>
      <div class="dash-card"><div class="dc-label">Total Reducers</div><div class="dc-value" id="cardReducerExecutions">&#x2014;</div></div>
    `;
    return root;
  }
}
