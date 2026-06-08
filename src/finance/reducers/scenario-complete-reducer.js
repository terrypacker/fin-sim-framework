/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * Sets state.scenarioComplete = true when no living persons remain.
 *
 * Runs at METRICS priority so it runs after all cash-flow reducers in the
 * same chain have settled. The simulation run loop reads scenarioComplete
 * after each event and breaks early (design/27 §2.1 Path A — no queue mutation).
 */
export class ScenarioCompleteReducer extends Reducer {
  static description = 'Sets state.scenarioComplete when state.people is empty.';
  static type        = 'ScenarioCompleteReducer';
  static actionType  = 'SCENARIO_COMPLETE_CHECK';

  constructor() {
    super('Scenario Complete', PRIORITY.METRICS);
    this.reducedActionTypes = ['SCENARIO_COMPLETE_CHECK'];
  }

  reduce(state) {
    if (Object.keys(state.people ?? {}).length === 0) {
      return this.newState({ ...state, scenarioComplete: true });
    }
    return this.newState(state);
  }
}
