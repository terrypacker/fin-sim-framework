/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkbenchComponent } from '../../component.js';

/**
 * `hostPanePlugin(id)` — a panel that DISPLAYS a component it does not own.
 *
 * Most panels in this package are not components at all: they are a place to put one. The
 * real thing — the configuration list, the inspector, the Monte Carlo panels, the decision
 * graph — is built by `WorkbenchApp.initScenario()` and lives for the session. The panel's
 * only job is to show it.
 *
 * These used to mint their own `<div id="…">` in `render()`, and the app found it with
 * `getElementById`. That coupling is the bug: **`render()` runs on a panel's first MOUNT**,
 * so a tab the user had closed contributed no DOM, `getElementById` returned `null`, and a
 * constructor that dereferences it threw UNCAUGHT during boot — taking the scenario list
 * and everything else after it down. The symptom ("no scenarios") pointed nowhere near the
 * cause (a layout key).
 *
 * So ownership moved to `WorkbenchRuntime.paneHost()`, whose lifetime is the session rather
 * than the panel's visibility, and these panels adopt the element instead of creating it.
 * Closing a tab still removes it from view; it no longer destroys it.
 *
 * @param {string} id        the host element id — also what the stylesheets select on
 * @param {object} [opts]    forwarded to `paneHost` (`outerClass`, `innerClass`)
 * @returns {typeof WorkbenchComponent} a plugin class taking the runtime
 */
export function hostPanePlugin(id, opts = undefined) {
  return class HostPanePlugin extends WorkbenchComponent {
    constructor(runtime) {
      super();
      this._runtime = runtime;
    }

    render() {
      return this._runtime.paneHost(id, opts).outer;
    }
  };
}
