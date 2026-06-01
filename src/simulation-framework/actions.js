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

import {SimGraphNode} from "../graph/sim-graph-node.js";

export const DEFAULT_ACTIONS = {
  RECORD_METRIC: 'RECORD_METRIC',
  RECORD_BALANCE: 'RECORD_BALANCE',
};

/**
 * Base class for all actions returned by Handlers and emitted via next:[].
 * Every action has a type discriminator consumed by the ReducerPipeline.
 *
 * id is null until assigned by ActionService._generateId() (config objects) or
 * ActionDefinition.instantiate() (runtime instances — gets a UUID).
 * type is the category discriminator used as the ReducerPipeline lookup key.
 *
 * Runtime-only parentage fields (set by Simulation.decorateAction):
 *   _instanceId       — UUID assigned when the instance enters the action queue
 *   _parentInstanceId — _instanceId of the action that emitted this one (null = top-level)
 *   _rootInstanceId   — _instanceId of the originating root action (null = this is root)
 */
export class Action extends SimGraphNode {
  static description = 'Base action carrying only a type discriminator and optional name.';
  static type        = 'Action';
  static category    = 'action';

  constructor(type, name) {
    super({id: null, kind: 'action', layer: 'config', name})
    this._instanceId      = null;  // UUID — assigned by instantiate() or decorateAction()
    this._parentInstanceId = null; // UUID of parent action (null = top-level)
    this._rootInstanceId  = null;  // UUID of root action (null = this is the root)
    this.type = type;
  }

  /** Always matches constructor.name — can never drift from the actual class. Don't let minification strip this out! */
  get actionClass() { return this.constructor.name; }

  static getDescription() {
    return this.description;
  }

  getDescription() {
    return this.constructor.getDescription();
  }

  toJSON() {
    return { __type: this.constructor.type, id: this.id, name: this.name, type: this.type };
  }

  static fromJSON(d, _ctx) {
    const a = new this(d.type, d.name);
    a.id = d.id;
    return a;
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
  static type        = 'FieldAction';

  constructor(type, name, fieldName = '') {
    super(type, name);
    this.fieldName  = fieldName;
  }

  toJSON() {
    return { ...super.toJSON(), fieldName: this.fieldName };
  }

  static fromJSON(d, _ctx) {
    const a = new this(d.type, d.name, d.fieldName ?? '');
    a.id = d.id;
    return a;
  }
}

export class FieldValueAction extends FieldAction {
  static description = 'Extends FieldAction with a value to write into the targeted state field.';
  static type        = 'FieldValueAction';

  constructor(type, name, fieldName = '', value = null) {
    super(type, name, fieldName);
    this.value  = value;
  }

  toJSON() {
    return { ...super.toJSON(), value: this.value };
  }

  static fromJSON(d, _ctx) {
    const a = new this(d.type, d.name, d.fieldName ?? '', d.value);
    a.id = d.id;
    return a;
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
  static type        = 'AmountAction';

  constructor(type, name, amount = 0) {
    super(type, name, 'amount', amount);
  }

  static fromJSON(d, _ctx) {
    const a = new this(d.type, d.name, d.value ?? 0);
    a.id = d.id;
    return a;
  }
}

/**
 * Captures a state field value into state.metrics so the chart can track it.
 * When called with no arguments it behaves as a pure pipeline-flush marker
 * (the BalanceSnapshotReducer is a no-op in that case).
 *
 * @param {string|null} [fieldPath]  Dot-separated path into state to read
 *                                   (e.g. 'accounts.usSavings.balance').
 * @param {string|null} [metricKey]  Key under state.metrics to write to.
 *                                   Defaults to fieldPath when omitted.
 */
export class RecordBalanceAction extends Action {
  static description = 'Captures a state field value into state.metrics[metricKey] for charting; with no args, acts as a no-op pipeline-flush marker.';
  static type        = 'RecordBalanceAction';
  constructor(fieldPath = null, metricKey = null) {
    super('RECORD_BALANCE');
    this.fieldPath = fieldPath;
    this.metricKey = metricKey ?? fieldPath;
  }
}

/**
 * Emits a named metric value for reporting.
 * Consumed by any NumericSumReducer (or custom reducer) registered for RECORD_METRIC.
 * key — metric name (e.g. 'us_savings_interest')
 * value — numeric amount to record
 */
export class RecordMetricAction extends FieldValueAction {
  static description = 'Records a named metric value for reporting; consumed by reducers registered for RECORD_METRIC.';
  static type        = 'RecordMetricAction';
  constructor(key, value) {
    super('RECORD_METRIC', `Record Metric for ${key}`, key, value);
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
  static type        = 'ScriptedAction';

  constructor(type, name, fieldName = '', script = '// return computed value\nreturn 0;') {
    super(type, name, fieldName, null);
    this._script = script;
    this._fn = null;  // not serialized — recompiled on first getValue() call
  }

  get script() { return this._script; }
  set script(v) { this._script = v; this._fn = null; }  // invalidate cache on edit

  toJSON() {
    return { ...super.toJSON(), script: this._script };
  }

  static fromJSON(d, _ctx) {
    const a = new this(d.type, d.name, d.fieldName ?? '', d.script ?? '');
    a.id = d.id;
    return a;
  }

  _compile() {
    if (!this._fn) {
      try {
        // eslint-disable-next-line no-new-func
        this._fn = new Function('state', 'date', 'sourceEvent', 'handlerContext', 'me', this.script);
      } catch (e) {
        console.error('ScriptedAction compile error:', e);
        this._fn = () => ({});
        throw e;
      }
    }
  }

  _compileExecute(state, date, sourceEvent, handlerContext) {
    this._compile();
    return this._fn(state, date, sourceEvent, handlerContext, this);
  }

  transform(state, {date, sourceEvent, handlerContext, me}) {
    try {
      return this._compileExecute(state, date, sourceEvent, handlerContext);
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
 * Also used by ActionDefinition.instantiate() to construct Action instances.
 */
export const ACTION_CLASSES = {
  AmountAction,
  Action,
  FieldAction,
  FieldValueAction,
  RecordBalanceAction,
  RecordMetricAction,
  ScriptedAction
};

// ─── UUID helper ───────────────────────────────────────────────────────────────

export const generateActionId = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

// ─── ActionDefinition ──────────────────────────────────────────────────────────

/**
 * Represents a configured action to be emitted at runtime.
 *
 * Separates the declaration (what type of action, with what config)
 * from the instantiation (the actual Action object created during simulation).
 *
 * Used by HandlerEntry.generatedActionDefinitions and
 * Reducer.generatedActionDefinitions to produce Action instances at runtime
 * without holding direct references to Action configuration objects.
 *
 * @property {string} id      - Stable identity for graph referencing (UUID)
 * @property {string} type    - Action type discriminator (routes to reducers)
 * @property {object} config  - Plain data describing how to construct the Action.
 *                              Values may be functions: (context) => value,
 *                              resolved at instantiate() time.
 *                              Must include actionClass (e.g. 'AmountAction').
 */
export class ActionDefinition {
  constructor({ type, config = {} }) {
    this.id     = generateActionId();
    this.type   = type;
    this.config = config;
  }

  /**
   * Create an ActionDefinition from an existing Action instance,
   * capturing its class and properties as static config.
   *
   * @param {Action} action
   * @returns {ActionDefinition}
   */
  static fromAction(action) {
    const config = { actionClass: action.actionClass };
    if (action.id        !== undefined) config._actionId  = action.id;
    if (action.name      !== undefined) config.name      = action.name;
    if (action.kind      !== undefined) config.kind      = action.kind;
    if (action.fieldName !== undefined) config.fieldName = action.fieldName;
    if (action.value     !== undefined) config.value     = action.value;
    if (action._script   !== undefined) config.script    = action._script;
    if (action.key       !== undefined) config.key       = action.key;
    if (action.fieldPath !== undefined) config.fieldPath = action.fieldPath;
    if (action.metricKey !== undefined) config.metricKey = action.metricKey;
    return new ActionDefinition({ type: action.type, config });
  }

  /**
   * Instantiate a concrete Action from this definition.
   *
   * Config values are resolved in order of precedence:
   *   1. Function  — called with `context`
   *   2. Expression string starting with `$` — compiled and evaluated with
   *      ($data, $state, $meta, $date, $sim) bound from context.
   *      e.g. `$data.amount`, `$state.salary * 0.3`
   *   3. Any other value — used as-is
   *
   * @param {object} [context] - Runtime context ({ date, state, data, meta, sim, ... })
   * @returns {Action}
   */
  instantiate(context = {}) {
    const resolved = {};
    for (const [k, v] of Object.entries(this.config)) {
      if (typeof v === 'function') {
        resolved[k] = v(context);
      } else if (typeof v === 'string' && v.startsWith('$')) {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('$data', '$state', '$meta', '$date', '$sim', `return ${v}`);
          resolved[k] = fn(
            context.data  ?? {},
            context.state ?? {},
            context.meta  ?? {},
            context.date  ?? null,
            context.sim   ?? null,
          );
        } catch (e) {
          console.warn(`ActionDefinition: expression error for field "${k}" = "${v}":`, e.message);
          resolved[k] = v; // fall back to raw string
        }
      } else {
        resolved[k] = v;
      }
    }
    const { actionClass, ...props } = resolved;
    const Cls = ACTION_CLASSES[actionClass ?? 'Action'];
    if (!Cls) throw new Error(`ActionDefinition: unknown actionClass "${actionClass ?? 'Action'}"`);
    const instance = Object.create(Cls.prototype);
    instance.id              = null;             // no service-registered config ID
    instance._instanceId      = generateActionId(); // UUID for runtime tracking
    instance._parentInstanceId = null;
    instance._rootInstanceId  = null;
    Object.assign(instance, props);
    instance.type = this.type;  // definition's type discriminator always wins
    return instance;
  }
}
