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

import {
  NoOpReducer,
  FieldReducer,
  ArrayReducer,
  NumericSumReducer,
  MultiplicativeReducer,
  RepeatingReducer,
  PRIORITY,
} from '../reducers.js';

class BaseReducerBuilder {
  constructor(defaultName, defaultPriority) {
    this._name                = defaultName;
    this._priority            = defaultPriority;
    this._reducedActionTypes  = [];  // string[] — types this reducer handles
    this._generatedActionTypes = []; // string[] — declared types for graph edges
    this._generatedActionDefs  = []; // ActionDefinition[] — runtime instantiation
  }

  name(v)     { this._name = v;     return this; }
  priority(v) { this._priority = v; return this; }

  /** Declare an action type this reducer handles (pipeline routing key). */
  reduceActionType(type) {
    if (!this._reducedActionTypes.includes(type)) {
      this._reducedActionTypes.push(type);
    }
    return this;
  }

  /**
   * Declare a type string this reducer may emit (graph edge metadata).
   * Use when you want to document an output type without a full definition.
   */
  generateActionType(type) {
    if (!this._generatedActionTypes.includes(type)) {
      this._generatedActionTypes.push(type);
    }
    return this;
  }

  /**
   * Add an ActionDefinition for runtime emission via newState().
   * Also registers the definition's type in generatedActionTypes automatically.
   */
  generateActionDef(def) {
    this._generatedActionDefs.push(def);
    if (!this._generatedActionTypes.includes(def.type)) {
      this._generatedActionTypes.push(def.type);
    }
    return this;
  }

  _apply(reducer) {
    reducer.reducedActionTypes       = [...this._reducedActionTypes];
    reducer.generatedActionTypes     = [...this._generatedActionTypes];
    reducer.generatedActionDefinitions = [...this._generatedActionDefs];
    return reducer;
  }
}

class BaseFieldReducerBuilder extends BaseReducerBuilder {
  constructor(defaultName, defaultPriority, defaultFieldName) {
    super(defaultName, defaultPriority);
    this._fieldName = defaultFieldName;
  }
  fieldName(v) { this._fieldName = v; return this; }

  _apply(reducer) {
    const r = super._apply(reducer);
    r.fieldName = this._fieldName;
    return r;
  }
}

class BaseFieldValueReducerBuilder extends BaseFieldReducerBuilder {
  constructor(defaultName, defaultPriority, defaultFieldName, defaultValue) {
    super(defaultName, defaultPriority, defaultFieldName);
    this._value = defaultValue;
  }
  value(v) { this._value = v; return this; }

  _apply(reducer) {
    const r = super._apply(reducer);
    r.value = this._value;
    return r;
  }
}

class NoOpReducerBuilder extends BaseReducerBuilder {
  constructor() { super('No-Op', PRIORITY.LOGGING + 5); }
  build() { return this._apply(new NoOpReducer(this._name, this._priority)); }
}

class FieldReducerBuilder extends BaseFieldReducerBuilder {
  constructor(fieldName) { super('Field Logger', PRIORITY.METRICS, fieldName); }
  build() { return this._apply(new FieldReducer(this._name, this._priority, this._fieldName)); }
}

class ArrayReducerBuilder extends BaseFieldValueReducerBuilder {
  constructor(fieldName) {
    super('Array Reducer', PRIORITY.METRICS, fieldName, null);
  }
  build() { return this._apply(new ArrayReducer(this._name, this._priority, this._fieldName, this._value)); }
}

class NumericSumReducerBuilder extends BaseFieldValueReducerBuilder {
  constructor(fieldName) {
    super('Sum Reducer', PRIORITY.METRICS, fieldName, null);
  }
  build() { return this._apply(new NumericSumReducer(this._name, this._priority, this._fieldName, this._value)); }
}

class MultiplicativeReducerBuilder extends BaseFieldValueReducerBuilder {
  constructor(fieldName) {
    super('Multiplicative Metric Logger', PRIORITY.METRICS, fieldName, null);
  }
  build() { return this._apply(new MultiplicativeReducer(this._name, this._priority, this._fieldName, this._value)); }
}

class RepeatingReducerBuilder extends BaseFieldReducerBuilder {
  constructor(fieldName) {
    super('Repeating Reducer', PRIORITY.METRICS, fieldName = 'value');
    this._reducers   = [];
    this._count      = null;
  }

  reducers(v)   { this._reducers = v;    return this; }
  count(v)      { this._count = v;       return this; }
  build() {
    return this._apply(
      new RepeatingReducer(this._name, this._priority, this._reducers, this._fieldName, this._count)
    );
  }
}

export class ReducerBuilder {
  static noOp()                   { return new NoOpReducerBuilder(); }
  static field(fieldName)                  { return new FieldReducerBuilder(fieldName); }
  static array(fieldName)   { return new ArrayReducerBuilder(fieldName); }
  static numericSum(fieldName)   { return new NumericSumReducerBuilder(fieldName); }
  static multiplicative(fieldName) { return new MultiplicativeReducerBuilder(fieldName); }
  static repeating(fieldName)              { return new RepeatingReducerBuilder(fieldName); }
}
