import { WorkbenchComponent } from '../../component.js';

export class ConfigGraphPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const outer = document.createElement('div');
    outer.className = 'wb-graph-outer';

    const graphRoot = document.createElement('div');
    graphRoot.id = 'graphRoot';

    outer.appendChild(graphRoot);
    return outer;
  }
}
