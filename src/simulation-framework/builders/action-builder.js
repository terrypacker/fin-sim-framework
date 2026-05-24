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
  AmountAction,
  RecordMetricAction,
  RecordArrayMetricAction,
  RecordNumericSumMetricAction,
  RecordMultiplicativeMetricAction,
  RecordBalanceAction,
} from '../actions.js';

class AmountActionBuilder {
  constructor() {
    this._type  = undefined;
    this._name  = undefined;
    this._value = 0;
  }

  type(v)  { this._type = v;  return this; }
  name(v)  { this._name = v;  return this; }
  value(v) { this._value = v; return this; }

  build() {
    return new AmountAction(this._type, this._name, this._value);
  }
}

class RecordMetricActionBuilder {
  constructor() {
    this._type      = 'RECORD_METRIC';
    this._name      = undefined;
    this._fieldName = undefined;
    this._value     = undefined;
  }

  type(v)      { this._type = v;      return this; }
  name(v)      { this._name = v;      return this; }
  fieldName(v) { this._fieldName = v; return this; }
  value(v)     { this._value = v;     return this; }

  build() {
    return new RecordMetricAction(this._type, this._name, this._fieldName, this._value);
  }
}

class RecordArrayMetricActionBuilder {
  constructor() {
    this._name      = undefined;
    this._fieldName = undefined;
    this._value     = undefined;
  }

  name(v)      { this._name = v;      return this; }
  fieldName(v) { this._fieldName = v; return this; }
  value(v)     { this._value = v;     return this; }

  build() {
    return new RecordArrayMetricAction(this._name, this._fieldName, this._value);
  }
}

class RecordNumericSumMetricActionBuilder {
  constructor() {
    this._name      = undefined;
    this._fieldName = undefined;
    this._value     = undefined;
  }

  name(v)      { this._name = v;      return this; }
  fieldName(v) { this._fieldName = v; return this; }
  value(v)     { this._value = v;     return this; }

  build() {
    return new RecordNumericSumMetricAction(this._name, this._fieldName, this._value);
  }
}

class RecordMultiplicativeMetricActionBuilder {
  constructor() {
    this._name      = undefined;
    this._fieldName = undefined;
    this._value     = undefined;
  }

  name(v)      { this._name = v;      return this; }
  fieldName(v) { this._fieldName = v; return this; }
  value(v)     { this._value = v;     return this; }

  build() {
    return new RecordMultiplicativeMetricAction(this._name, this._fieldName, this._value);
  }
}

class RecordBalanceActionBuilder {
  build() {
    return new RecordBalanceAction();
  }
}

export class ActionBuilder {
  static amount()              { return new AmountActionBuilder(); }
  static recordMetric()        { return new RecordMetricActionBuilder(); }
  static recordArrayMetric()   { return new RecordArrayMetricActionBuilder(); }
  static recordNumericSum()    { return new RecordNumericSumMetricActionBuilder(); }
  static recordMultiplicative(){ return new RecordMultiplicativeMetricActionBuilder(); }
  static recordBalance()       { return new RecordBalanceActionBuilder(); }
}
