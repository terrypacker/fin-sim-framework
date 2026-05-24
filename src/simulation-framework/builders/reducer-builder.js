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
  MetricReducer,
  ArrayMetricReducer,
  NumericSumMetricReducer,
  MultiplicativeMetricReducer,
  RepeatingReducer,
  StateFieldReducer,
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

class NoOpReducerBuilder extends BaseReducerBuilder {
  constructor() { super('No-Op', PRIORITY.LOGGING + 5); }
  build() { return this._apply(new NoOpReducer(this._name, this._priority)); }
}

class FieldReducerBuilder extends BaseReducerBuilder {
  constructor() { super('Field Logger', PRIORITY.METRICS); this._fieldName = null; }
  fieldName(v) { this._fieldName = v; return this; }
  build() { return this._apply(new FieldReducer(this._name, this._priority, this._fieldName)); }
}

class StateFieldReducerBuilder extends BaseReducerBuilder {
  constructor() { super('State Field Logger', PRIORITY.POSITION_UPDATE); this._fieldName = null; }
  fieldName(v) { this._fieldName = v; return this; }
  build() { return this._apply(new FieldReducer(this._name, this._priority, this._fieldName)); }
}

class MetricReducerBuilder extends BaseReducerBuilder {
  constructor(metricName) {
    super('Metric Logger', PRIORITY.METRICS);
    this._metricName = metricName;
  }
  build() { return this._apply(new MetricReducer(this._name, this._priority, this._metricName)); }
}

class ArrayMetricReducerBuilder extends BaseReducerBuilder {
  constructor(fieldName) {
    super('Array Metric Logger', PRIORITY.METRICS);
    this._fieldName = fieldName;
  }
  build() { return this._apply(new ArrayMetricReducer(this._name, this._priority, this._fieldName)); }
}

class NumericSumMetricReducerBuilder extends BaseReducerBuilder {
  constructor(metricName) {
    super('Sum Metric Logger', PRIORITY.METRICS);
    this._metricName = metricName;
  }
  build() { return this._apply(new NumericSumMetricReducer(this._name, this._priority, this._metricName)); }
}

class MultiplicativeMetricReducerBuilder extends BaseReducerBuilder {
  constructor(metricName) {
    super('Multiplicative Metric Logger', PRIORITY.METRICS);
    this._metricName = metricName;
  }
  build() { return this._apply(new MultiplicativeMetricReducer(this._name, this._priority, this._metricName)); }
}

class RepeatingReducerBuilder extends BaseReducerBuilder {
  constructor() {
    super('Repeating Reducer', PRIORITY.METRICS);
    this._reducers   = [];
    this._countField = 'value';
    this._count      = null;
  }

  reducers(v)   { this._reducers = v;    return this; }
  countField(v) { this._countField = v;  return this; }
  count(v)      { this._count = v;       return this; }

  build() {
    return this._apply(
      new RepeatingReducer(this._name, this._priority, this._reducers, this._countField, this._count)
    );
  }
}

export class ReducerBuilder {
  static noOp()                   { return new NoOpReducerBuilder(); }
  static field()                  { return new FieldReducerBuilder(); }
  static stateField() { return new StateFieldReducerBuilder(); }
  static metric(metricName)       { return new MetricReducerBuilder(metricName); }
  static arrayMetric(fieldName)   { return new ArrayMetricReducerBuilder(fieldName); }
  static numericSum(metricName)   { return new NumericSumMetricReducerBuilder(metricName); }
  static multiplicative(metricName) { return new MultiplicativeMetricReducerBuilder(metricName); }
  static repeating()              { return new RepeatingReducerBuilder(); }
}
