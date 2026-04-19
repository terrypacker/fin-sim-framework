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
 */
export class Action {
  constructor(type) {
    this.type = type;
  }
}

/**
 * Action carrying a monetary or numeric amount.
 * Covers cash credits/debits, gain realizations, tax computations, etc.
 *
 * Examples: ADD_CASH, REMOVE_CASH, SALARY_CREDIT, INTEREST_CREDIT,
 *           ASSET_PROCEEDS, INCOME_TAX_PAYMENT, REALIZE_GAIN,
 *           CALCULATE_CAPITAL_GAINS_TAX
 */
export class AmountAction extends Action {
  constructor(type, amount) {
    super(type);
    this.amount = amount;
  }
}

/**
 * Records a named metric value into state.metrics.
 * Used by the generic RECORD_METRIC reducer registered in every scenario.
 */
export class RecordMetricAction extends Action {
  constructor(name, value) {
    super('RECORD_METRIC');
    this.name  = name;
    this.value = value;
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
