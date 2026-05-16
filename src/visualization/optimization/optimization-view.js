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
  constructor() {
    super();
    this._configPane  = document.getElementById('optConfigPane');
    this._resultsPane = document.getElementById('optResultsPane');
    this._runsPane    = document.getElementById('optRunsPane');
  }

  /** Container for OptConfigPanel */
  get configPane()  { return this._configPane;  }

  /** Container for OptResultsPanel */
  get resultsPane() { return this._resultsPane; }

  /** Container for OptRunsPanel */
  get runsPane()    { return this._runsPane;    }
}
