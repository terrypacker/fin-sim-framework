import { WorkbenchComponent } from '../component.js';

export class ConfigGraphPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const outer = document.createElement('div');
    outer.className = 'wb-graph-outer';

    const graphRoot = document.createElement('div');
    graphRoot.id = 'graphRoot';

    const graphViewport = document.createElement('div');
    graphViewport.id = 'graphViewport';

    const graphEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    graphEdges.id = 'graphEdges';

    const graphNodes = document.createElement('div');
    graphNodes.id = 'graphNodes';

    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';

    graphViewport.appendChild(graphEdges);
    graphViewport.appendChild(graphNodes);
    graphViewport.appendChild(selectionBox);
    graphRoot.appendChild(graphViewport);
    outer.appendChild(graphRoot);

    return outer;
  }
}
