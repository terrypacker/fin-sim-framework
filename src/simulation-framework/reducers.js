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
  static description = 'Abstract base class for all reducers; subclasses implement reduce(state, action, date) and register against an action type.';

  constructor(name = 'anonymous', priority = PRIORITY.LOGGING) {
    this.id       = null;
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

  get kind() { return 'reducer'; }

  /** Always matches constructor.name — can never drift from the actual class. Don't let minification strip this out! */
  get reducerType() { return this.constructor.name; }

  static getDescription() {
    return this.description;
  }

  getDescription() {
    return this.constructor.getDescription();
  }

}

// ─── Common reducer subclasses ─────────────────────────────────────────────────

/**
 * A no-op reducer that returns state unchanged.
 * Used as a pipeline marker (e.g. RECORD_BALANCE) so that the resulting
 * ActionNode captures the fully-updated stateAfter for that event.
 */
export class NoOpReducer extends Reducer {
  static description = 'Returns state unchanged.';

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
  static description = 'Replaces the value at state[fieldName] with the action value or the existing state value.  If no field name it uses the fieldName field value of the action';

  constructor(name = 'Field Reducer', priority, fieldName = null) {
    super(name, priority);
    this.fieldName = fieldName;
  }

  /**
   * Get the path to the field, priority giving to our field name
   * @param action
   */
  getFieldPath(action) {
    if(this.fieldName == null) {
      return action.fieldName;
    }else {
      return this.fieldName;
    }
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
    const metricValue = this.getStateValue(state, action);
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.getFieldPath(action), this.getStateValue(state, action))
  }

}

/**
 * Append a value to an array field in state[this.fieldName] get the value for the metric by:
 * action.value if defined or state[this.fieldName]
 */
export class ArrayReducer extends FieldReducer {
  static description = 'Appends the action value to the array at state[fieldName], initialising the array if absent.';

  constructor(name = 'Array Reducer', priority = PRIORITY.METRICS,
     fieldName) {
    super(name, priority, fieldName);
  }

  reduce(state, action) {
    const list = this.getValueByPath(state, this.getFieldPath(action)) || [];
    const value = this.getStateValue(state, action);
    const newList = [...list, value];
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.getFieldPath(action), newList);
  }
}

export class NumericSumReducer extends FieldReducer {
  static description = 'Accumulates a running numeric total at state[fieldName] by adding each action value to the existing sum.';

  constructor(name = 'Sum Reducer', priority = PRIORITY.METRICS,
      fieldName = null) {
    super(name, priority, fieldName);
  }

  reduce(state, action) {
    const initialValue = this.getValueByPath(state, this.getFieldPath(action)) || 0;
    const value = this.getStateValue(state, action) || 0;
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.getFieldPath(action), initialValue + value);
  }
}

export class MultiplicativeReducer extends FieldReducer {
  static description = 'Multiplies the current value at state[fieldName] by the action value, accumulating a compounding product over time.';

  constructor(name = 'Multiplicative Reducer', priority = PRIORITY.METRICS,
      fieldName = null) {
    super(name, priority, fieldName);
  }

  reduce(state, action) {
    const initialValue = this.getValueByPath(state, this.getFieldPath(action)) || 0;
    const value = this.getStateValue(state, action);
    const newState = this.newState(state);  //Pickup next actions
    return this.setValueByPath(newState, this.getFieldPath(action), initialValue * value);
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
  static description = 'Applies a debit or credit transaction to a named account in state via AccountService, then returns the updated state.';

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
// ─── Class registry ────────────────────────────────────────────────────────────

/**
 * Maps reducerType string → class.
 * Used by ReducerService.replaceReducer to instantiate the correct subclass
 * when the user changes the type of an existing reducer in the UI.
 */
export const REDUCER_CLASSES = {};  // populated after class declarations below

export class RepeatingReducer extends FieldReducer {
  static description = 'Runs a set of child reducers N times in sequence (N from the action or a fixed count), re-emitting the action each iteration via next[].';

  constructor(name = 'Repeating Reducer', priority = PRIORITY.METRICS,
      reducers, fieldName = 'value', count = null) {
    super(name, priority, fieldName);
    this.reducers = reducers;
    this.count = count;
  }

  reduce(state, action, date) {
    const count = typeof action._repeaterCounter === 'undefined' ? this.count == null ? this.fieldName == null ? 0 : action[this.fieldName] : this.count : action._repeaterCounter;
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

/**
 * A reducer whose logic is a user-supplied JS script string.
 * Intended for rapid prototyping before promoting logic into a dedicated class.
 *
 * Script signature (fieldName set):
 *   (state, action, date) => value
 *   The returned value is written to state at fieldName via setValueByPath.
 *
 * Script signature (no fieldName):
 *   (state, action, date) => partialState
 *   The returned object is spread into the current state.
 *
 * If the action is a ScriptedAction it exposes getValue(state, date); this
 * reducer calls that instead of action.value when both are scripted.
 *
 * The compiled function is cached in _fn and intentionally NOT serialized,
 * so deserialization triggers a clean recompile — making replays safe.
 */
export class ScriptedReducer extends FieldReducer {
  static description = 'Prototype reducer: supply a JS script instead of a baked-in class. Script receives (state, action, date).';

  constructor(name = 'Scripted Reducer', priority = PRIORITY.POSITION_UPDATE,
      fieldName = '', script = '// return value (if fieldName set) or partial state object\nreturn {};') {
    super(name, priority, fieldName);
    this._script = script;
    this._fn = null;  // not serialized — recompiled on first reduce() call
  }

  get script() { return this._script; }
  set script(v) { this._script = v; this._fn = null; }  // invalidate cache on edit

  _compile() {
    if (!this._fn) {
      try {
        // eslint-disable-next-line no-new-func
        this._fn = new Function('state', 'action', 'date', this.script);
      } catch (e) {
        console.error('ScriptedReducer compile error:', e);
        this._fn = () => ({});
      }
    }
    return this._fn;
  }

  reduce(state, action, date) {
    let result;
    try {
      result = this._compile()(state, action, date);
    } catch (e) {
      console.error('ScriptedReducer runtime error:', e);
      return this.newState(state);
    }
    const base = this.newState(state);
    //TODO is this ok?
    const path = this.getFieldPath(action);
    if (path) {
      return this.setValueByPath(base, path, result);
    }
    return { ...base, ...(result ?? {}) };
  }
}

// Populate registry after all classes are declared
Object.assign(REDUCER_CLASSES, {
  NoOpReducer,
  FieldReducer,
  ScriptedReducer,
  ArrayReducer,
  NumericSumReducer,
  MultiplicativeReducer,
  AccountTransactionReducer,
  RepeatingReducer,
});
