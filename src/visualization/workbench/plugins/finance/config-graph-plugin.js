import { WorkbenchComponent } from '../../component.js';

/**
 * ConfigGraphPlugin — the pane the config graph is DISPLAYED in.
 *
 * It does not own the graph's DOM. `WorkbenchRuntime.graphHost()` does, because
 * `initScenario()` builds the view, the presenter and the animator against that element
 * whether or not this panel has ever been mounted — and a plugin's `render()` does not
 * run until its first mount. See `graphHost()` for the boot crash that came of minting
 * the element here.
 */
export class ConfigGraphPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
  }

  render() {
    return this._runtime.graphHost().outer;
  }
}
