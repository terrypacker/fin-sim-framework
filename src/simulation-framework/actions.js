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

export const DEFAULT_ACTIONS = {
  RECORD_METRIC: 'RECORD_METRIC',
  RECORD_BALANCE: 'RECORD_BALANCE',
};

/**
 * Base class for all actions returned by Handlers and emitted via next:[].
 * Every action has a type discriminator consumed by the ReducerPipeline.
 *
 * id is null until assigned by ActionService._generateId().
 * type is the category discriminator used as the ReducerPipeline lookup key.
 * These are intentionally separate: id uniquely identifies the action instance;
 * type identifies which reducers should process it.
 */
export class Action {
  static description = 'Base action carrying only a type discriminator and optional name.';

  constructor(type, name) {
    this.id   = null;  // Assigned by ActionService after construction
    this.type = type;
    this.name = name;
  }

  get kind() { return 'action'; }

  /** Always matches constructor.name — can never drift from the actual class. Don't let minification strip this out! */
  get actionClass() { return this.constructor.name; }

  static getDescription() {
    return this.description;
  }

  getDescription() {
    return this.constructor.getDescription();
  }

  /**
   * Optionally transform the action by generating more actions
   * @param state
   * @param date
   * @param sourceEvent
   * @param handlerContext
   * @param me - this action
   * @return [] of next actions after the scheduled actions
   */
  transform(state, {date, sourceEvent, handlerContext, me}) {
    //No Op by default
  }
}

export class FieldAction extends Action {
  static description = 'Extends Action with a fieldName targeting a specific state field.';

  constructor(type, name, fieldName) {
    super(type, name);
    this.fieldName  = fieldName;
  }
}

export class FieldValueAction extends FieldAction {
  static description = 'Extends FieldAction with a value to write into the targeted state field.';

  constructor(type, name, fieldName, value) {
    super(type, name, fieldName);
    this.value  = value;
  }
}

/**
 * Action carrying a monetary or numeric amount.
 * Covers cash credits/debits, gain realizations, tax computations, etc.
 * provide a name if you want to reference a metric in the reducer
 *
 * Examples: ADD_CASH, REMOVE_CASH, SALARY_CREDIT, INTEREST_CREDIT,
 *           ASSET_PROCEEDS, INCOME_TAX_PAYMENT, REALIZE_GAIN,
 *           CALCULATE_CAPITAL_GAINS_TAX
 */
export class AmountAction extends FieldValueAction {
  static description = 'Carries a monetary or numeric amount (fieldName fixed to "amount"); used for cash flows, gains, and tax payments.';

  constructor(type, name, amount) {
    super(type, name, 'amount', amount);
  }
}

/**
 * Marker action that triggers the RECORD_BALANCE no-op reducer.
 * Runs last in the pipeline so the resulting ActionNode stateAfter
 * reflects the fully-updated state for that event.
 */
export class RecordBalanceAction extends Action {
  static description = 'Marker action that triggers a no-op pipeline flush, capturing a fully-updated stateAfter snapshot for the current event.';
  constructor() {
    super('RECORD_BALANCE');
  }
}

/**
 * An action whose value is computed at reduce-time by a user-supplied JS script.
 * Intended for rapid prototyping before promoting logic into a dedicated class.
 *
 * Script signature:
 *   (state, reducers, date, this) => <empty>
 *   The script can modify the action itself or decide to alter the state or reducers.
 *
 * The script is called prior to a reducer acting on it but the list of reducers is already known.
 *
 * The compiled function is cached in _fn and intentionally NOT serialized,
 * so deserialization triggers a clean recompile — making replays safe.
 */
export class ScriptedAction extends FieldValueAction {
  static description = 'Prototype action: supply a JS script to compute the value at reduce-time. Script receives (state, date).';

  constructor(type, name, fieldName = '', script = '// return computed value\nreturn 0;') {
    super(type, name, fieldName, null);
    this._script = script;
    this._fn = null;  // not serialized — recompiled on first getValue() call
  }

  get script() { return this._script; }
  set script(v) { this._script = v; this._fn = null; }  // invalidate cache on edit

  _compile() {
    if (!this._fn) {
      try {
        // eslint-disable-next-line no-new-func
        this._fn = new Function('state', 'date', 'sourceEvent', 'handlerContext', 'me', this.script);
      } catch (e) {
        console.error('ScriptedAction compile error:', e);
        this._fn = () => null;
      }
    }
    return this._fn;
  }

  transform(state, {date, sourceEvent, handlerContext, me}) {
    try {
      this._compile()(state, date, sourceEvent, handlerContext, this);
    } catch (e) {
      console.error('ScriptedAction runtime error:', e);
    }
  }
}

// ─── Class registry ────────────────────────────────────────────────────────────

/**
 * Maps actionClass string → class.
 * Used by ActionService.replaceAction to instantiate the correct subclass
 * when the user changes the type of an existing action in the UI.
 */
export const ACTION_CLASSES = {
  AmountAction,
  Action,
  FieldAction,
  FieldValueAction,
  RecordBalanceAction,
  ScriptedAction
};
