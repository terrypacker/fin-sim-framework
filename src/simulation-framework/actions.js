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
  constructor(type, name) {
    this.id   = null;  // Assigned by ActionService after construction
    this.type = type;
    this.name = name;
  }
}

export class FieldAction extends Action {
  constructor(type, name, fieldName) {
    super(type, name);
    this.fieldName  = fieldName;
  }
}

export class FieldValueAction extends FieldAction {
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
  constructor(type, name, amount) {
    super(type, name, 'amount', amount);
  }
}

/**
 * Replaces a metric value into state.metrics.
 * Used by the generic RECORD_METRIC reducer.
 */
export class RecordMetricAction extends FieldValueAction {
  constructor(type = 'RECORD_METRIC', name, fieldName, value) {
    super(type, name, 'metrics.' + fieldName, value);
  }
}

/**
 * Pushes a named metric value into an array within state.metrics.
 * Used by the generic RECORD_ARRAY_METRIC reducer registered in every financial scenario.
 */
export class RecordArrayMetricAction extends RecordMetricAction {
  constructor(name, fieldName, value) {
    super('RECORD_ARRAY_METRIC', name, fieldName, value);
  }
}

/**
 * Records a named metric value into state.metrics.
 * Used by the generic RECORD_NUMERIC_SUM_METRIC.
 */
export class RecordNumericSumMetricAction extends RecordMetricAction {
  constructor(name, fieldName, value) {
    super('RECORD_NUMERIC_SUM_METRIC', name, fieldName, value);
  }
}

/**
 * Multiplies the current metric by this value and replaces it in state.metrics.
 * Used by the generic RECORD_MULTIPLICATIVE_METRIC reducer.
 */
export class RecordMultiplicativeMetricAction extends RecordMetricAction {
  constructor(name, fieldName, value) {
    super('RECORD_MULTIPLICATIVE_METRIC', name, fieldName, value);
  }
}


/**
 * Marker action that triggers the RECORD_BALANCE no-op reducer.
 * Runs last in the pipeline so the resulting ActionNode stateAfter
 * reflects the fully-updated state for that event.
 */
export class RecordBalanceAction extends Action {
  constructor() {
    super('RECORD_BALANCE');
  }
}
