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
  Action,
  FieldAction,
  FieldValueAction,
  AmountAction,
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

class SimpleActionBuilder {
  constructor(type, defaultName) {
    this._type = type;
    this._name = defaultName;
  }

  type(v)      { this._type = v;      return this; }
  name(v)      { this._name = v;      return this; }

  build() {
    return new Action(this._type, this._name);
  }
}
class FieldActionBuilder extends SimpleActionBuilder {
  constructor(type, defaultName, defaultFieldName) {
    super(type, defaultName)
    this._fieldName = defaultFieldName;
  }

  fieldName(v) { this._fieldName = v; return this; }

  build() {
    return new FieldAction(this._type, this._name, this._fieldName);
  }
}

class FieldValueActionBuilder extends FieldActionBuilder {
  constructor(type, defaultName, defaultField, defaultValue) {
    super(type, defaultName, defaultField)
    this._value = defaultValue;
  }

  value(v) { this._value = v; return this; }

  build() {
    return new FieldValueAction(this._type, this._name, this._fieldName, this._value);
  }
}

class RecordBalanceActionBuilder {
  build() {
    return new RecordBalanceAction();
  }
}

export class ActionBuilder {
  static amount()              { return new AmountActionBuilder(); }
  static action(type) { return new SimpleActionBuilder(type); }
  static fieldAction(type, fieldName) { return new FieldActionBuilder(type, fieldName); }
  static fieldValueAction(type, fieldName, value) { return new FieldValueActionBuilder(type, fieldName, value); }
  static recordBalance()       { return new RecordBalanceActionBuilder(); }
}
