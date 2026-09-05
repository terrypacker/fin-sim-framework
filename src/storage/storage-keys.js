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
 * Every key the app persists through a StorageAdapter.
 *
 * This is the canonical list, and it is what the localStorage → IndexedDB
 * migration copies across, so a new persisted store MUST be added here or its
 * data will not follow the user to the new backend.
 *
 * Deliberately NOT included, and still read straight from localStorage:
 *
 *   `sim-workbench-layout*`  (workbench/layout-model.js)   — a few KB
 *   `finsim.displaySettings` (visualization/app-display-settings.js) — a few bytes
 *
 * Both are tiny, and displaySettings is read by an inline script in index.html
 * before any module loads, to set the theme without a flash. Neither contributes
 * to the quota pressure that motivated the move, and routing them through an
 * adapter that must be hydrated first would cost that flash.
 */
export const STORAGE_KEYS = Object.freeze({
  SCENARIOS:        'fin-sim-scenarios',
  DECISION_GRAPHS:  'fin-sim-decision-graphs',
  DG_RESULTS:       'fin-sim-dg-results',
  DECISION_RECORDS: 'fin-sim-decisions',
});

/** @type {string[]} */
export const ALL_STORAGE_KEYS = Object.freeze(Object.values(STORAGE_KEYS));
