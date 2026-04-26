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
} from '../simulation-framework/actions.js';

/**
 * Centralized factory for creating Action instances.
 *
 * All concrete scenarios should create actions via this factory rather than
 * calling `new XxxAction(...)` directly. This ensures a single construction
 * path for both default setup (in buildSim / loadDefaults) and
 * deserialization (in ScenarioSerializer). Actions use action.type as their
 * graph node identity — the factory does not assign separate IDs.
 *
 * Available on BaseScenario instances as `this.actionFactory`.
 */
export class ActionFactory {

  amountAction(type, name, value = 0) {
    return new AmountAction(type, name, value);
  }

  recordMetricAction(type, name, fieldName, value) {
    return new RecordMetricAction(type, name, fieldName, value);
  }

  recordArrayMetricAction(name, fieldName, value) {
    return new RecordArrayMetricAction(name, fieldName, value);
  }

  recordNumericSumMetricAction(name, fieldName, value) {
    return new RecordNumericSumMetricAction(name, fieldName, value);
  }

  recordMultiplicativeMetricAction(name, fieldName, value) {
    return new RecordMultiplicativeMetricAction(name, fieldName, value);
  }

  recordBalanceAction() {
    return new RecordBalanceAction();
  }
}
