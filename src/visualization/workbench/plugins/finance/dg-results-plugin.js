import { WorkbenchComponent } from '../../component.js';

export class DgResultsPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    const inner = document.createElement('div');
    inner.id = 'dgResultsPane';
    root.appendChild(inner);
    return root;
  }
}
