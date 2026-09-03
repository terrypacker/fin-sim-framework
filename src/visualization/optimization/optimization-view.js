/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';

/**
 * OptimizationView — DOM anchor provider for the Optimization tab.
 *
 * Holds references to the three sub-pane container elements.
 * Sub-panel components (OptConfigPanel, OptResultsPanel, OptRunsPanel) mount
 * directly into these panes and manage their own content.
 */
export class OptimizationView extends BaseComponent {
  /**
   * @param {{ hostFor?: (id: string) => HTMLElement }} [opts]
   *   Resolver for the three pane elements. `WorkbenchApp` passes
   *   `WorkbenchRuntime.paneHost`, whose lifetime is the SESSION — a plugin's `render()`
   *   runs on its first MOUNT, so looking these up in the document returned `null` for
   *   anyone whose layout had the tab closed, and the panel constructors below
   *   dereference it. Falls back to `getElementById` so a caller with real DOM (a test,
   *   an embedder) needs no runtime.
   */
  constructor({ hostFor = null } = {}) {
    super();
    const host = hostFor ?? ((id) => document.getElementById(id));
    this._configPane  = host('optConfigPane');
    this._resultsPane = host('optResultsPane');
    this._runsPane    = host('optRunsPane');
  }

  /** Container for OptConfigPanel */
  get configPane()  { return this._configPane;  }

  /** Container for OptResultsPanel */
  get resultsPane() { return this._resultsPane; }

  /** Container for OptRunsPanel */
  get runsPane()    { return this._runsPane;    }
}
