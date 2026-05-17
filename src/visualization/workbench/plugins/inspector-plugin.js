import { WorkbenchComponent } from '../component.js';

export class InspectorPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    const inner = document.createElement('div');
    inner.id = 'graphNodeEditPane';
    inner.className = 'wb-plugin-fill';
    root.appendChild(inner);
    return root;
  }
}
