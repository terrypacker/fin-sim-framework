import { WorkbenchComponent } from '../../component.js';

/**
 * Scenario panel — scenario selection, identity, simulation period, and
 * whole-scenario storage. The parameter list lives in ParametersPlugin.
 */
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
      <button class="btn btn-sm" id="newScenarioBtn"
              title="Copy the current scenario into a new editable user scenario.">Copy</button>
      <button class="btn btn-sm" id="newBlankScenarioBtn"
              title="Create an empty scenario — no persons, accounts, or parameters — as a blank canvas to add and link nodes by hand.">+ New</button>
      <button class="btn btn-sm btn-warn" id="deleteScenarioBtn">Delete</button>
    </div>
    <div class="wb-scenario-btn-row">
      <button class="btn btn-sm" id="resetDefaultsBtn"
              title="Replace this scenario's persons, accounts, properties, and parameters with the reference defaults. The scenario record (name, id) is preserved.">Reset to Defaults</button>
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
