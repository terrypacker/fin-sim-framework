import { WorkbenchComponent } from '../../component.js';

export class DgConfigPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    const inner = document.createElement('div');
    inner.id = 'dgConfigPane';
    root.appendChild(inner);
    return root;
  }
}
