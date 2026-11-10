import { hostPanePlugin } from './host-pane-plugin.js';

/**
 * Parameters panel — the scenario's parameter list, its filter, and the
 * parameter-level import/export controls.
 *
 * Split out of ScenarioPlugin so the list can use a wide centre pane. Both panels
 * are driven by the same ScenarioTabView/presenter pair, which finds their elements
 * by id inside the two runtime hosts.
 *
 * The RUNTIME owns this markup (see `WorkbenchRuntime.paneHost`). `ScenarioTabView` wires
 * it once at boot and renders into it for the whole session, so with the markup minted in
 * `render()` a reader whose layout had this tab closed at boot got controls that stayed dead
 * after reopening it: an empty scenario dropdown, buttons that did nothing.
 */
export const PARAMETERS_PANEL_TEMPLATE = `
    <div class="param-filter-row">
      <input id="paramsFilter" class="param-filter" type="text"
             placeholder="Filter parameters (e.g. inflation, wage, retirement)…" />
      <div id="paramsFilterFields" class="param-filter-fields"></div>
    </div>
    <div id="paramsRunGuard" class="param-run-guard" hidden></div>
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

/** Host options: one place, because the app and the plugin both ask. */
export const PARAMETERS_PANEL_HOST = { template: PARAMETERS_PANEL_TEMPLATE };

export const ParametersPlugin = hostPanePlugin('parametersPane', PARAMETERS_PANEL_HOST);
