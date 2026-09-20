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
 * NODE_EDITORS — the config-graph node kinds, and where each kind's edit form comes from
 * (design 111 §3).
 *
 * This is deliberately ONE registry doing two jobs, and the second is what keeps the first
 * honest:
 *
 * 1. **The Nodes panel renders from it.** `ConfigurationListComponent` builds its kind
 *    dropdown from `label`, which it used to hold in a private `KIND_LABELS` of its own.
 * 2. **The help generator reads from it.** `collectNodes()` resolves each kind's fields
 *    through `templates` / `specs` and emits them as tier 1.
 *
 * Design 108 §2.1 measured what happens to a table that exists only to be documentation:
 * three of them had drifted, every one because a commit added the thing and nothing failed.
 * A registry the UI renders from cannot drift that way — a kind removed from here vanishes
 * from the panel, which is not a failure anyone ships.
 *
 * `templates` names `<template>` ids in `index.html`, exactly as `_getTemplate()` clones
 * them at runtime, including the per-subtype config sub-editors (an Action's fields are its
 * own three plus whichever of the four sub-editors its class selects). `specs` names a
 * module export for the sections that build their fields in JS instead — with `idPrefix`
 * when the rendered `data-id` is not the field name, as the payroll section's is not.
 *
 * What it deliberately does NOT name: the repeating row tables inside the Account editor
 * (holdings, loans) and the other row-list sub-editors. A row's columns want column help,
 * which is a different affordance from a node field — see design 111 §9.
 */
export const NODE_EDITORS = Object.freeze({
  person: {
    label: 'People',
    templates: ['tpl-person-editor'],
    // The payroll elections (design 95) are rendered by `PayrollSection` from its own
    // declarative meta, under `pe_`-prefixed ids. Thirteen real controls on this form:
    // leaving them out would let the gate call Person documented with a third of it silent.
    specs: [{ module: 'src/finance/payroll/payroll-election-meta.js#PAYROLL_ELECTION_META',
              idPrefix: 'pe_' }],
  },
  account: {
    label: 'Accounts',
    templates: ['tpl-account-editor'],
  },
  'real-property': {
    label: 'Real Property',
    templates: ['tpl-real-property-editor'],
  },
  collectible: {
    label: 'Collectibles',
    templates: ['tpl-collectible-editor'],
  },
  company: {
    label: 'Company Equity',
    templates: ['tpl-company-equity-editor'],
  },
  bequest: {
    label: 'Inheritance',
    specs: [{ module: 'src/visualization/assets/bequest-editor.js#BEQUEST_FORM_FIELDS' }],
  },
  security: {
    label: 'Securities',
    specs: [{ module: 'src/visualization/assets/security-editor.js#SECURITY_FORM_FIELDS' }],
  },
  event: {
    label: 'Events',
    templates: ['tpl-event-editor', 'tpl-event-series-editor', 'tpl-event-one-off-editor'],
  },
  handler: {
    label: 'Handlers',
    templates: ['tpl-handler-editor'],
  },
  action: {
    label: 'Actions',
    templates: ['tpl-action-editor', 'tpl-amount-action-editor', 'tpl-field-action-editor',
                'tpl-field-value-action-editor', 'tpl-scripted-action-editor'],
  },
  reducer: {
    label: 'Reducers',
    templates: ['tpl-reducer-editor', 'tpl-account-transaction-reducer-editor',
                'tpl-field-reducer-editor', 'tpl-field-value-reducer-editor',
                'tpl-scripted-reducer-editor'],
  },
});

/** Kind → dropdown label, the shape the Nodes panel wants. */
export const NODE_KIND_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(NODE_EDITORS).map(([kind, e]) => [kind, e.label])));
