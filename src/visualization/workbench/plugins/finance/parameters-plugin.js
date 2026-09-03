import { WorkbenchComponent } from '../../component.js';

/**
 * Parameters panel — the scenario's parameter list, its filter, and the
 * parameter-level import/export controls.
 *
 * Split out of ScenarioPlugin so the list can use a wide centre pane. The DOM
 * ids are unchanged: ScenarioTabView still wires them by id, so both panels
 * are driven by the same view/presenter pair.
 */
export class ParametersPlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill';
    root.innerHTML = `
    <div class="param-filter-row">
      <input id="paramsFilter" class="param-filter" type="text"
             placeholder="Filter parameters (e.g. inflation, wage, retirement)…" />
      <div id="paramsFilterFields" class="param-filter-fields"></div>
    </div>
    <div id="paramsList"></div>
    <div class="wb-scenario-param-add">
      <button class="btn btn-sm" id="addParamBtn">+ Add Parameter</button>
    </div>
    <div class="node-body">
      <button class="btn btn-sm" id="downloadCsvBtn">Download Params CSV</button>
      <label class="btn btn-sm wb-upload-label">
        Upload Params CSV
        <input type="file" id="uploadCsvFileInput" accept=".csv,text/csv" class="wb-hidden" />
      </label>
    </div>
    `;
    return root;
  }
}
