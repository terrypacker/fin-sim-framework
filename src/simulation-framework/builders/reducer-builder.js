/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
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
    this._name             = defaultName;
    this._priority         = defaultPriority;
    this._reducedActions   = [];
    this._generatedActions = [];
  }

  name(v)           { this._name = v;             return this; }
  priority(v)       { this._priority = v;          return this; }
  reduceAction(a)   { this._reducedActions.push(a);   return this; }
  generateAction(a) { this._generatedActions.push(a); return this; }

  _apply(reducer) {
    reducer.reducedActions   = [...this._reducedActions];
    reducer.generatedActions = [...this._generatedActions];
    return reducer;
  }
}

class BaseFieldReducerBuilder extends BaseReducerBuilder {
  constructor(defaultName, defaultPriority, defaultFieldName) {
    super(defaultName, defaultPriority);
    this._fieldName = defaultFieldName;
  }
  fieldName(v) { this._fieldName = v; return this; }
}

class NoOpReducerBuilder extends BaseReducerBuilder {
  constructor() { super('No-Op', PRIORITY.LOGGING + 5); }
  build() { return this._apply(new NoOpReducer(this._name, this._priority)); }
}

class FieldReducerBuilder extends BaseFieldReducerBuilder {
  constructor(fieldName) { super('Field Logger', PRIORITY.METRICS, fieldName); }
  build() { return this._apply(new FieldReducer(this._name, this._priority, this._fieldName)); }
}

class ArrayReducerBuilder extends BaseFieldReducerBuilder {
  constructor(fieldName) {
    super('Array Reducer', PRIORITY.METRICS, fieldName);
  }
  build() { return this._apply(new ArrayReducer(this._name, this._priority, this._fieldName)); }
}

class NumericSumReducerBuilder extends BaseFieldReducerBuilder {
  constructor(fieldName) {
    super('Sum Reducer', PRIORITY.METRICS, fieldName);
  }
  build() { return this._apply(new NumericSumReducer(this._name, this._priority, this._fieldName)); }
}

class MultiplicativeReducerBuilder extends BaseFieldReducerBuilder {
  constructor(fieldName) {
    super('Multiplicative Metric Logger', PRIORITY.METRICS, fieldName);
  }
  build() { return this._apply(new MultiplicativeReducer(this._name, this._priority, this._fieldName)); }
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
