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
import { HandlerEntry }      from '../../simulation-framework/handlers.js';

// ─── PeriodAdvanceReducer base + per-country subclasses ───────────────────────

class PeriodAdvanceReducerBase extends Reducer {
  static cc;
  static actionType;

  constructor() {
    const cc = new.target.cc;
    super(`${cc} Period Advance`, PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = [new.target.actionType];
  }

  reduce(state, action) {
    return this.newState(state, {
      currentPeriods: { ...state.currentPeriods, [this.constructor.cc]: action.period },
    });
  }
}

/**
 * Updates state.currentPeriods.US when a US_PERIOD_ADVANCE action fires.
 * Also sets state.usFilingSingle based on state.deceased: once any person has
 * died the surviving spouse files single starting the following tax year
 * (design/27 §7 / Step 19).
 * Runs at PRE_PROCESS priority so the correct period and filing status are in
 * state before any tax or cash-flow reducers run on the same step.
 */
export class UsPeriodAdvanceReducer extends PeriodAdvanceReducerBase {
  static type       = 'UsPeriodAdvanceReducer';
  static category   = 'reducer';
  static cc         = 'US';
  static actionType = 'US_PERIOD_ADVANCE';
  static description = 'Updates state.currentPeriods.US to the new period when a US_PERIOD_ADVANCE action fires at a year boundary. Sets usFilingSingle=true when state.deceased is non-empty.';

  reduce(state, action) {
    const usFilingSingle = Object.keys(state.deceased ?? {}).length > 0;
    return this.newState(state, {
      currentPeriods: { ...state.currentPeriods, [this.constructor.cc]: action.period },
      usFilingSingle,
    });
  }
}

/**
 * Updates state.currentPeriods.AU when an AU_PERIOD_ADVANCE action fires.
 */
export class AuPeriodAdvanceReducer extends PeriodAdvanceReducerBase {
  static type       = 'AuPeriodAdvanceReducer';
  static category   = 'reducer';
  static cc         = 'AU';
  static actionType = 'AU_PERIOD_ADVANCE';
  static description = 'Updates state.currentPeriods.AU to the new period when an AU_PERIOD_ADVANCE action fires at a year boundary.';
}

// ─── PeriodAdvanceHandler base + per-country subclasses ───────────────────────

class PeriodAdvanceHandlerBase extends HandlerEntry {
  static cc;
  static actionType;

  constructor() {
    super(null, `${new.target.cc} Period Advance`);
    this.generatedActionTypes = [new.target.actionType];
  }

  call({ data, date }) {
    const { periods } = data;
    const ts = date.getTime();
    const period = periods.find(p => p.startMs <= ts && ts < p.endMs);
    if (!period) return [];
    return [{ type: this.constructor.actionType, period }];
  }
}

/**
 * Converts the scheduled PERIOD_ADVANCE_US event into a US_PERIOD_ADVANCE action
 * so UsPeriodAdvanceReducer updates state.currentPeriods.US.
 *
 * SimulationSync wires this via the static eventType property.
 */
export class UsPeriodAdvanceHandler extends PeriodAdvanceHandlerBase {
  static type       = 'UsPeriodAdvanceHandler';
  static category   = 'handler';
  static cc         = 'US';
  static actionType = 'US_PERIOD_ADVANCE';
  static eventType  = 'PERIOD_ADVANCE_US';
  static description = 'Dispatches a US_PERIOD_ADVANCE action from the scheduled PERIOD_ADVANCE_US event so UsPeriodAdvanceReducer updates state.currentPeriods.US.';
}

/**
 * Converts the scheduled PERIOD_ADVANCE_AU event into an AU_PERIOD_ADVANCE action
 * so AuPeriodAdvanceReducer updates state.currentPeriods.AU.
 */
export class AuPeriodAdvanceHandler extends PeriodAdvanceHandlerBase {
  static type       = 'AuPeriodAdvanceHandler';
  static category   = 'handler';
  static cc         = 'AU';
  static actionType = 'AU_PERIOD_ADVANCE';
  static eventType  = 'PERIOD_ADVANCE_AU';
  static description = 'Dispatches an AU_PERIOD_ADVANCE action from the scheduled PERIOD_ADVANCE_AU event so AuPeriodAdvanceReducer updates state.currentPeriods.AU.';
}
