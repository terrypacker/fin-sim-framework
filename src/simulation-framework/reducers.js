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

import {FieldValueAction} from "./actions.js";

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

  /**
   * Register a Reducer instance, storing a back-reference so it can be found
   * and removed later (e.g. on priority or action-type change).
   */
  registerReducer(actionType, reducer) {
    if (!this.map.has(actionType)) this.map.set(actionType, []);
    const list = this.map.get(actionType);
    list.push({
      fn:      (s, a, d) => reducer.reduce(s, a, d),
      priority: reducer.priority,
      name:     reducer.name,
      reducer               // back-reference for unregisterAllForReducer
    });
    list.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove every pipeline entry that was registered from the given Reducer
   * instance. Used before re-registering after a UI-driven property change.
   */
  unregisterAllForReducer(reducer) {
    for (const [actionType, entries] of this.map) {
      const filtered = entries.filter(e => e.reducer !== reducer);
      if (filtered.length < entries.length) {
        if (filtered.length === 0) {
          this.map.delete(actionType);
        } else {
          this.map.set(actionType, filtered);
        }
      }
    }
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
    this.generatedActions = [];
    this.reducedActions = [];
  }

  /** @abstract */
  reduce(state, _action, _date) {
    throw new Error(`${this.constructor.name}.reduce() not implemented`);
  }

  /**
   * Helper to create a copy of the current state and ensure we have any next actions ready
   *
   * @param currentState
   * @param toAdd
   * @param next
   * @returns {*&{next: *[]}}
   */
  newState(currentState, toAdd, next) {
    const nextArray = next ? [...next, ...this.generatedActions] : [...this.generatedActions];
    return {
      ...currentState,
      ...toAdd,
      next: nextArray
    }
  }

  /**
   * Convenience: register this reducer instance with a ReducerPipeline.
   * Uses registerReducer so a back-reference is stored, enabling
   * unregisterAllForReducer to find and remove this entry later.
   */
  registerWith(pipeline, actionType) {
    pipeline.registerReducer(actionType, this);
    return this;
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
    return this.newState(state);  //Pickup next actions
  }
}

/**
 * Reducer that is places a field in the state
 */
export class FieldReducer extends Reducer {
  constructor(name, priority, fieldName = null) {
    super(`${name} for ${fieldName}`, priority);
    if (fieldName == null) {
      // Executes if variable is null or undefined
      throw new Error('Must have field name defined for Field Reducer');
    }
    this.fieldName = fieldName;
  }

  getStateValue(state, action) {
    return action.value ? action.value :
        action.fieldName ? this.getValueByPath(state, action.fieldName) : this.getValueByPath(state, this.fieldName);
  }

  getValueByPath(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }

  /**
   * Set the value at the path and return a new full copy of  obj, for immutable state
   * @param obj
   * @param path
   * @param value
   * @returns {{}}
   */
  setValueByPath(obj, path, value) {
    const parts = Array.isArray(path) ? path : path.split('.');

    const isIndex = (key) => {
      return typeof key === 'number' || String(Number(key)) === key;
    };

    const setRecursive = (current, i) => {
      const key = parts[i];
      const last = i === parts.length - 1;

      // Determine existing value
      const existing = current ?? (isIndex(key) ? [] : {});

      // Clone container (array or object)
      let clone;
      if (Array.isArray(existing)) {
        clone = [...existing];
      } else {
        clone = { ...existing };
      }

      if (last) {
        clone[key] = value;
        return clone;
      }

      const nextKey = parts[i + 1];
      const nextIsIndex = isIndex(nextKey);

      clone[key] = setRecursive(
          existing[key] !== undefined
              ? existing[key]
              : nextIsIndex
                  ? []
                  : {},
          i + 1
      );

      return clone;
    };

    return setRecursive(obj, 0);
  }

  reduce(state, action, date) {
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.fieldName, this.getStateValue(state, action))
  }

}

/**
 * Produce a field for the state
 */
export class StateFieldReducer extends FieldReducer {
  constructor(name = 'State Field', priority = PRIORITY.POSITION_UPDATE, fieldName,
      generate = (state, action, date) => 0) {
    super(name, priority, fieldName);
    this.generate = generate;
  }

  reduce(state, action, date) {
    const value = this.generate(state, action, date);
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.fieldName, value);
  }
}

/**
 * Produce a field in state.metrics[this.fieldName] get the value for the metric by:
 * action.value if defined or state.metrics[this.fieldName]
 */
export class MetricReducer extends FieldReducer {
  constructor(name = 'Metric Logger', priority = PRIORITY.METRICS, metricName) {
    super(name, priority, 'metrics.' + metricName);
  }

  reduce(state, action) {
    const metricValue = this.getStateValue(state, action);
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.fieldName, metricValue);
  }
}

/**
 * Append a value to an array field in state.metrics[this.fieldName] get the value for the metric by:
 * action.value if defined or state.metrics[this.fieldName]
 */
export class ArrayMetricReducer extends MetricReducer {

  constructor(name = 'Array Metric Logger', priority = PRIORITY.METRICS,
     fieldName) {
    super(name, priority, fieldName);
  }

  reduce(state, action) {
    const list = this.getValueByPath(state, this.fieldName) || [];
    const value = this.getStateValue(state, action);
    const newList = [...list, value];
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.fieldName, newList);
  }
}


export class NumericSumMetricReducer extends MetricReducer {

  constructor(name = 'Sum Metric Logger', priority = PRIORITY.METRICS,
      metricName = null) {
    super(name, priority, metricName);
  }

  reduce(state, action) {
    const initialValue = this.getValueByPath(state, this.fieldName) || 0;
    const value = this.getStateValue(state, action) || 0;
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.fieldName, initialValue + value);
  }
}

export class MultiplicativeMetricReducer extends FieldReducer {

  constructor(name = 'Multiplicative Metric Logger', priority = PRIORITY.METRICS,
      mulitplierMetric = null) {
    super(name, priority, mulitplierMetric);
  }

  reduce(state, action) {
    const initialValue = this.getValueByPath(state, this.fieldName) || 0;
    const value = this.getStateValue(state, action);
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.fieldName, initialValue * value);
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
  constructor({ accountService, accountKey, getAmount = a => a.amount }, name = 'Account Transaction',
      priority = PRIORITY.CASH_FLOW) {
    super(name, priority);
    this.accountService = accountService;
    this.accountKey     = accountKey;
    this.getAmount      = getAmount;
  }

  reduce(state, action, date) {
    this.accountService.transaction(state[this.accountKey], this.getAmount(action), date);
    return this.newState(state);  //Pickup next actions
  }
}

/**
 * A reducer that repeats another reducer,
 * reducer - what to repeat
 * countField state field . separated to get the count to repeat
 * count - number of times to repeat
 */
export class RepeatingReducer extends Reducer {

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
