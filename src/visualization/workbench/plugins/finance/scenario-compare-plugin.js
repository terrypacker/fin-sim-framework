import { WorkbenchComponent } from '../../component.js';

export class ScenarioComparePlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    const inner = document.createElement('div');
    inner.id = 'scenarioComparePane';
    inner.className = 'sc-pane-fill';
    root.appendChild(inner);
    return root;
  }
}
