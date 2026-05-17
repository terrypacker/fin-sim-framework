import { WorkbenchComponent } from '../component.js';

export class ScenarioPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    root.innerHTML = `
    <div class="node-header">Scenario</div>
    <div class="node-field">
      <select id="scenarioSelect" class="wb-full-width"></select>
    </div>
    <div class="wb-scenario-btn-row">
      <button class="btn btn-sm" id="loadScenarioBtn">Load</button>
      <button class="btn btn-sm" id="newScenarioBtn">+ New</button>
      <button class="btn btn-sm btn-warn" id="deleteScenarioBtn">Delete</button>
    </div>
    <div class="node-header">Name</div>
    <div class="node-field">
      <input id="scenarioName" placeholder="Scenario name" />
    </div>
    <div class="node-header">Simulation Period</div>
    <div class="node-field">
      <label>Start</label>
      <input type="date" id="simStartInput"/>
    </div>
    <div class="node-field">
      <label>End</label>
      <input type="date" id="simEndInput"/>
    </div>
    <div class="node-header">Initial State (JSON)</div>
    <div class="node-field">
      <textarea id="initialStateJson" rows="5" class="wb-scenario-textarea"></textarea>
    </div>
    <div class="node-header">Parameters</div>
    <div id="paramsList"></div>
    <div class="wb-scenario-param-add">
      <button class="btn btn-sm" id="addParamBtn">+ Add Parameter</button>
    </div>
    <div class="node-header">Storage</div>
    <div class="node-body">
      <button class="btn" id="rebuildBtn">&#x21BA; Rebuild Simulation</button>
      <button class="btn btn-sm" id="saveScenarioBtn">Save to Browser</button>
      <button class="btn btn-sm" id="downloadJsonBtn">Download JSON</button>
      <label class="btn btn-sm wb-upload-label">
        Upload JSON
        <input type="file" id="uploadJsonFileInput" accept=".json" class="wb-hidden" />
      </label>
    </div>
    `;
    return root;
  }
}
