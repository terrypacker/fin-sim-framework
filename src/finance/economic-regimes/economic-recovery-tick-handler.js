/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';

/**
 * EconomicRecoveryTickHandler — handles ECONOMIC_RECOVERY_TICK one-off events.
 *
 * Each tick fires RECOMPUTE_REGIMES so RegimeApplyReducer updates the current
 * recovery factors between period boundaries. RegimeApplyReducer automatically
 * drops fully-recovered regimes from the stack — no explicit REMOVE_REGIME_APPLY
 * is needed from this handler.
 */
export class EconomicRecoveryTickHandler extends HandlerEntry {
  static type      = 'EconomicRecoveryTickHandler';
  static eventType = 'ECONOMIC_RECOVERY_TICK';
  static description = 'Fires RECOMPUTE_REGIMES on each recovery tick so effective rates are updated between period boundaries.';

  constructor() {
    super(null, 'Economic Recovery Tick');
    this.generatedActionTypes = ['RECOMPUTE_REGIMES'];
  }

  call() {
    return [{ type: 'RECOMPUTE_REGIMES' }];
  }
}
