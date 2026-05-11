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
 * Semantic role identifiers for all accounts in the simulation state.
 *
 * A role describes what an account *is* (its function), independent of its
 * state property name or who owns it.  Handlers and reducers use role +
 * ownerId to look up accounts via StateRegistry rather than hard-coding
 * state key strings.
 *
 * Naming convention: kebab-case strings that read as account descriptions.
 */
export const ACCOUNT_ROLES = Object.freeze({
  US_SAVINGS:   'us-savings',
  FIXED_INCOME: 'fixed-income',
  US_STOCK:     'us-stock',
  IRA:          'ira',
  K401:         'k401',
  ROTH:         'roth-ira',
  AU_SAVINGS:   'au-savings',
  AU_STOCK:     'au-stock',
  SUPER:        'super',
});
