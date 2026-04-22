/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export class ReducerPipeline {
  constructor() {
    this.map = new Map(); // actionType -> [{priority, fn}]
  }

  register(actionType, fn, priority = 100, name = 'anonymous') {
    if (!this.map.has(actionType)) {
      this.map.set(actionType, []);
    }

    const list = this.map.get(actionType);

    list.push({ fn, priority, name });

    // Keep sorted (lowest runs first)
    list.sort((a, b) => a.priority - b.priority);
  }

  get(actionType) {
    return this.map.get(actionType) || [];
  }
}

export const PRIORITY = {
  PRE_PROCESS: 10,

  // Core financial mechanics
  CASH_FLOW: 20,
  POSITION_UPDATE: 30,
  COST_BASIS: 40,

  // Tax layer
  TAX_CALC: 60,
  TAX_APPLY: 70,

  // Derived / reporting
  METRICS: 90,
  LOGGING: 100
};

// ─── Base Reducer class ────────────────────────────────────────────────────────

/**
 * Base class for all reducer implementations.
 * Subclasses override reduce(state, action, date) and are registered via
 * registerWith(pipeline, actionType).
 */
export class Reducer {
  constructor(name = 'anonymous', priority = PRIORITY.LOGGING) {
    this.name     = name;
    this.priority = priority;
  }

  /** @abstract */
  reduce(state, _action, _date) {
    throw new Error(`${this.constructor.name}.reduce() not implemented`);
  }

  /**
   * Convenience: register this reducer instance with a ReducerPipeline.
   */
  registerWith(pipeline, actionType) {
    pipeline.register(actionType, (s, a, d) => this.reduce(s, a, d), this.priority, this.name);
  }
}

// ─── Common reducer subclasses ─────────────────────────────────────────────────

/**
 * A no-op reducer that returns state unchanged.
 * Used as a pipeline marker (e.g. RECORD_BALANCE) so that the resulting
 * ActionNode captures the fully-updated stateAfter for that event.
 */
export class NoOpReducer extends Reducer {
  constructor(name = 'No-Op', priority = PRIORITY.LOGGING + 5) {
    super(name, priority);
  }

  reduce(state) {
    return state;
  }
}

/**
 * Produce a field for the state
 */
export class StateFieldReducer extends Reducer {
  constructor(name = 'State Field', priority = PRIORITY.POSITION_UPDATE, fieldName = null, generate = (state, action, date) => 0) {
    super(name, priority);
    this.fieldName = fieldName;
    this.generate = generate;
  }

  reduce(state, action, date) {
    return {
      ... state,
      [this.fieldName]: this.generate(state, action, date)
    };
  }
}

/**
 * Appends a value to the metrics array at state.metrics[action.name].
 * Works with any action that carries `name` and `value` fields —
 * e.g. actions produced by RecordArrayMetricAction.
 */
export class ArrayMetricReducer extends Reducer {

  static fromField(fieldName = null) {
    return new ArrayMetricReducer(name = 'Array Metric Logger', PRIORITY.METRICS, fieldName);
  }
  constructor(name = 'Array Metric Logger', priority = PRIORITY.METRICS, fieldName = null) {
    super(name, priority);
    this.fieldName = fieldName;
  }

  reduce(state, action) {
    const list = state.metrics[action.name] || [];
    const value = this.fieldName == null ? action.value : state[this.fieldName];
    return {
      ...state,
      metrics: { ...state.metrics, [action.name]: [...list, value] }
    };
  }
}

/**
 * Sums a value to the metric sum at state.metrics[action.name].
 *
 * state.metrics[action.name] = state.metrics[action.name] + action.value
 *
 * Works with any action that carries `name` and `value` fields —
 * e.g. actions produced by RecordArrayMetricAction.
 *
 * You can optionally supply another metric name to use as the metric addend:
 * state.metrics[action.name] = state.metrics[metricName] + action.value
 */
export class NumericSumMetricReducer extends Reducer {

  static fromMetric(metricName = null) {
    return new NumericSumMetricReducer('Sum Metric Logger', PRIORITY.METRICS, metricName);
  }

  constructor(name = 'Sum Metric Logger', priority = PRIORITY.METRICS, metricName = null) {
    super(name, priority);
    this.metricName = metricName;
  }

  reduce(state, action) {
    const sum = this.metricName == null ? state.metrics[action.name] || 0 : state.metrics[this.metricName];
    const value = Number(action.value || 0);
    return {
      ...state,
      metrics: { ...state.metrics, [action.name]: sum + value }
    };
  }
}

/**
 * Multiply a metric by the action value and places at state.metrics[action.name].
 *
 * state.metrics[action.name] = state.metrics[action.name] * action.value
 *
 * Works with any action that carries `name` and `value` fields —
 * e.g. actions produced by RecordMultiplicativeMetricAction.
 *
 * You can optionally supply another metric name to use as the multiplier:
 * state.metrics[action.name] = state.metrics[metricName] * action.value
 */
export class MultiplicativeMetricReducer extends Reducer {

  static fromMetric(metricName = null) {
    return new MultiplicativeMetricReducer('Multiplicative Metric Logger', PRIORITY.METRICS, metricName);
  }

  constructor(name = 'Multiplicative Metric Logger', priority = PRIORITY.METRICS, mulitplierMetric = null) {
    super(name, priority);
    this.mulitplierMetric = mulitplierMetric;
  }

  reduce(state, action) {
    const metricValue = this.mulitplierMetric == null ? state.metrics[action.name] || 0 : state.metrics[this.mulitplierMetric];
    const actionValue = Number(action.value || 0);
    return {
      ...state,
      metrics: { ...state.metrics, [action.name]: metricValue * actionValue }
    };
  }
}

/**
 * Saves a value to the metric at state.metrics[action.name].
 * Works with any action that carries `name` and `value` fields —
 * e.g. actions produced by RecordArrayMetricAction.
 */
export class MetricReducer extends Reducer {
  constructor(name = 'Metric Logger', priority = PRIORITY.METRICS) {
    super(name, priority);
  }

  reduce(state, action) {
    return {
      ...state,
      metrics: { ...state.metrics, [action.name]: action.value }
    };
  }
}

/**
 * Applies an AccountService transaction to a named account in state,
 * then returns the updated state.
 *
 * @param {object}         opts
 * @param {AccountService} opts.accountService - Service used to apply the transaction
 * @param {string}         opts.accountKey     - Key into state, e.g. 'savingsAccount'
 * @param {Function}       [opts.getAmount]    - Maps action → amount (default: a => a.amount)
 */
export class AccountTransactionReducer extends Reducer {
  constructor({ accountService, accountKey, getAmount = a => a.amount }, name = 'Account Transaction', priority = PRIORITY.CASH_FLOW) {
    super(name, priority);
    this.accountService = accountService;
    this.accountKey     = accountKey;
    this.getAmount      = getAmount;
  }

  reduce(state, action, date) {
    this.accountService.transaction(state[this.accountKey], this.getAmount(action), date);
    return { ...state };
  }
}

/**
 * A reducer that repeats another reducer,
 * reducer - what to repeat
 * countField state field . separated to get the count to repeat
 * count - number of times to repeat
 */
export class RepeatingReducer extends Reducer {

  static fromReducer(reducers = [], countField = 'value', count = null) {
    return new RepeatingReducer(`Repeating reducer: ${reducers.map(v => v.name).join('-->')}`, PRIORITY.METRICS, reducers, countField, count);
  }

  constructor(name = 'Repeating Reducer', priority = PRIORITY.METRICS,
      reducers, countField = 'value', count = null) {
    super(name, priority);
    this.reducers = reducers;
    this.countField = countField;
    this.count = count;
  }

  reduce(state, action, date) {
    const count = typeof action._repeaterCounter === 'undefined' ? this.count == null ? this.countField == null ? 0 : action[this.countField] : this.count : action._repeaterCounter;
    if( count <= 0) {
      return {... state};
    }
    let newState = { ...state }
    for(let i=0; i<this.reducers.length; i++) {
      newState = this.reducers[i].reduce(newState, action, date);
    }

    return {
      state: newState,
      next: [
        {
          ...action, //TODO Need to strip out the _ base fields
          _repeaterCounter: count - 1
        }
      ]
    };
  }
}


