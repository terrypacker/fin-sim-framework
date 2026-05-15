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
 * MonteCarloView — DOM anchor provider for the MC tab.
 *
 * Holds references to the three sub-pane container elements.
 * Sub-panel components (McConfigPanel, McResultsPanel, McRunsPanel) mount
 * directly into these panes and manage their own content.
 */
export class MonteCarloView extends BaseComponent {
  constructor() {
    super();
    this._configPane  = document.getElementById('mcConfigPane');
    this._resultsPane = document.getElementById('mcResultsPane');
    this._runsPane    = document.getElementById('mcRunsPane');
  }

  /** Container for McConfigPanel */
  get configPane()  { return this._configPane;  }

  /** Container for McResultsPanel */
  get resultsPane() { return this._resultsPane; }

  /** Container for McRunsPanel (Session 5) */
  get runsPane()    { return this._runsPane;    }
}
