import { WorkbenchComponent } from '../../component.js';

export class McResultsPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    const inner = document.createElement('div');
    inner.id = 'mcResultsPane';
    root.appendChild(inner);
    return root;
  }
}
