/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { NeStateTaxRates2024 } from './ne-state-tax-rates-2024.js';

/**
 * NeStateTaxRates2025 — Nebraska individual income tax, tax year 2025.
 *
 * LB 754 rate glide: the top marginal rate steps down from 5.84% (2024) to
 * 5.20% (2025), continuing toward a flat 3.99% by 2027. This is the canonical
 * "new year, new module" case for the state engine — only the top bracket rate
 * changes, so the module subclasses 2024 and overrides the bracket tables.
 */
export class NeStateTaxRates2025 extends NeStateTaxRates2024 {
  get year() { return 2025; }

  constructor() {
    super();
    this._brackets_mfj = [
      [      0, 0.0246],
      [  7_390, 0.0351],
      [ 44_310, 0.0501],
      [ 71_360, 0.0520],   // top rate steps 5.84% → 5.20%
    ];
    this._brackets_single = [
      [      0, 0.0246],
      [  3_700, 0.0351],
      [ 22_170, 0.0501],
      [ 35_690, 0.0520],
    ];
  }
}
