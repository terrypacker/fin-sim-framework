/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { CurrencyPair } from './fx-engine.js';

/**
 * USD ↔ AUD bidirectional currency pair.
 *
 * Canonical direction: USD → AUD.  The rate stored in state is "1 USD = N AUD".
 * For AUD → USD transfers the rate is inverted and the USD fee is converted to AUD.
 */
export class UsdAudPair extends CurrencyPair {
  static id           = 'USD_AUD';
  static fromCurrency = 'USD';
  static toCurrency   = 'AUD';
}
