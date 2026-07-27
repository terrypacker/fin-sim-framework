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

import assert   from 'node:assert/strict';

export const Assert = {
  datesEqual: (d1, d2) => {
    assert.ok(d1.getUTCFullYear() === d2.getUTCFullYear(), `Years do not match, expected ${d1.getUTCFullYear()} but was ${d2.getUTCFullYear()}`);
    assert.ok(d1.getUTCMonth() === d2.getUTCMonth(), `Months do not match, expected ${d1.getUTCMonth()} but was ${d2.getUTCMonth()}`);
    assert.ok(d1.getUTCDate() === d2.getUTCDate(), `Days do not match, expected ${d1.getUTCDate()} but was ${d2.getUTCDate()}`);
  }
};

// ─── AU per-person income (design 76) ────────────────────────────────────────
//
// Design 76 Gap B moved AU-assessable income off the household scalars and onto
// per-person maps. These read a person's slice *including* any unattributed
// household residue, so a test states the economics ("this event is AU-assessable
// to Terry") without restating the migration.
//
// Prefer the per-person form over the total: a total passes under every wrong
// split, which is exactly how the even-split bug survived for so long.

/** Total AU ordinary income assessed to `personKey`, plus any household residue. */
export const auOrdinaryFor = (state, personKey = 'primary') =>
  (state.auPersonOrdinaryIncomeYTD?.[personKey] ?? 0) + (state.auOrdinaryIncomeYTD ?? 0);

/** Total AU capital gains assessed to `personKey`, plus any household residue. */
export const auGainsFor = (state, personKey = 'primary') =>
  (state.auPersonCapitalGainsYTD?.[personKey] ?? 0) + (state.auCapitalGainsYTD ?? 0);

/**
 * Assert an event produced NO AU-assessable income anywhere.
 *
 * Checks the per-person maps as well as the scalars: post-design-76 a
 * scalar-only assertion would pass even if the amount leaked into a per-person
 * map, which is precisely the regression worth catching.
 */
export function assertNoAuIncome(assert, state, msg = '') {
  const sum = m => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
  assert.strictEqual((state.auOrdinaryIncomeYTD ?? 0) + sum(state.auPersonOrdinaryIncomeYTD), 0,
    `${msg} expected no AU ordinary income (scalar or per-person)`);
  assert.strictEqual((state.auCapitalGainsYTD ?? 0) + sum(state.auPersonCapitalGainsYTD), 0,
    `${msg} expected no AU capital gains (scalar or per-person)`);
}
