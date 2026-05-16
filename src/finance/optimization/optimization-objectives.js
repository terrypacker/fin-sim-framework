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
 * Param type constants for optimization configs.
 *
 * ENUM       — discrete set of explicit values (e.g., bracket rates)
 * INTEGER    — integer range [min, max] stepped by step
 * CONTINUOUS — continuous range [min, max] stepped by step (discretised for grid search)
 */
export const OPT_PARAM_TYPES = {
  ENUM:       'enum',
  INTEGER:    'integer',
  CONTINUOUS: 'continuous',
};

/**
 * Named optimization objectives for IntlRetirementOptimizer.
 *
 * Each entry has:
 *   label     — human-readable name for UI
 *   direction — 'maximize' | 'minimize'
 *   evaluate  — (result) => number  where result is the object returned by
 *               IntlRetirementOptimizer._runOne()
 *
 * The optimizer always maximises internally; a 'minimize' direction causes
 * scores to be negated before ranking.
 */
export const OPTIMIZATION_OBJECTIVES = {
  MAX_NET_WORTH: {
    label:     'Maximize Final Net Worth (USD)',
    direction: 'maximize',
    evaluate:  result => result.finalNetWorthUsd,
  },

  MAX_ROTH_BALANCE: {
    label:     'Maximize Final Roth Balance (USD)',
    direction: 'maximize',
    evaluate:  result => result.rothFinalBalance,
  },

  MIN_DEFICIT: {
    label:     'Minimize Cumulative Deficit',
    direction: 'minimize',
    evaluate:  result => result.cumulativeDeficit,
  },
};
