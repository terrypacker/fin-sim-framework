/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Static catalog of action templates.
 *
 * Templates are UI presets that the user selects when adding an ActionDefinition
 * to a Handler or Reducer.  They are never serialized or stored — they only exist
 * to populate the "Select template" picker and supply sensible defaultConfig values.
 *
 * Concept                Lives in Graph   Has ID     Executes
 * ActionTemplate         ❌               optional   ❌
 * ActionDefinition       ✅               UUID       ❌
 * Action instance        ❌ (ephemeral)   UUID       ✅
 *
 * @property {string} id            - Stable identifier for this template
 * @property {string} label         - Human-readable name shown in the UI picker
 * @property {string} actionClass   - Key in ACTION_CLASSES used by ActionDefinition.instantiate()
 * @property {object} defaultConfig - Initial config values for a new ActionDefinition.
 *                                    Values support expression strings ($data.x, $state.x * 0.3).
 */
export const ACTION_TEMPLATES = [
  {
    id:            'record-metric',
    label:         'Record Metric (RecordMetricAction)',
    actionClass:   'RecordMetricAction',
    defaultConfig: { key: '', value: 0 },
  },
  {
    id:            'transfer-amount',
    label:         'Transfer Amount (AmountAction)',
    actionClass:   'AmountAction',
    defaultConfig: { name: '', value: 0 },
  },
  {
    id:            'set-field-value',
    label:         'Set Field Value (FieldValueAction)',
    actionClass:   'FieldValueAction',
    defaultConfig: { fieldName: '', value: 0 },
  },
  {
    id:            'record-balance',
    label:         'Record Balance (RecordBalanceAction)',
    actionClass:   'RecordBalanceAction',
    defaultConfig: {},
  },
  {
    id:            'scripted',
    label:         'Scripted Action (ScriptedAction)',
    actionClass:   'ScriptedAction',
    defaultConfig: { fieldName: '', script: '// return computed value\nreturn 0;' },
  },
];
