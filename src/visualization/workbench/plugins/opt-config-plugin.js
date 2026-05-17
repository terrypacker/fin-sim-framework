import { WorkbenchComponent } from '../component.js';

export class OptConfigPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    const inner = document.createElement('div');
    inner.id = 'optConfigPane';
    root.appendChild(inner);
    return root;
  }
}
