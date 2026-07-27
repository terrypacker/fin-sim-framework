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
 * Published-base guard — a standing check against half-applied statutory updates.
 *
 * Every bug found in the 2026-07-20 tax audit had the same shape: a rate change
 * that also moved thresholds, where only ONE half landed. AU Stage 3 paired the
 * old 32.5% rate with the new $135k ceiling; the AU 2024 module kept the entire
 * FY2023-24 ladder under a comment claiming Stage 3. Asserting rates alone, or
 * thresholds alone, misses all of it — each half looks right in isolation.
 *
 * Tax authorities publish their schedules as cumulative "$X plus Yc for each $1
 * over $Z" tables. That base amount X is the tax at threshold Z, so it encodes
 * every rate AND every threshold below it in a single number. Reproducing X from
 * the module's own bracket table is therefore an end-to-end check that no
 * arrangement of half-right constants can pass.
 *
 * These figures are transcribed from the authority, NOT from this codebase's
 * output — that is the whole point. Re-deriving them from the modules would make
 * the test circular and worthless. When adding a tax year, copy the base amounts
 * out of the source document and add a row here.
 *
 * Tolerance is $1: authorities round published bases to the dollar (Hawaii's 2025
 * MFJ base at $96,000 prints as $5,078 but is exactly $5,078.40). A wrong rate
 * moves these by hundreds or thousands, so the slack costs no sensitivity.
 *
 * Run with: node --test tests/unit/tax-rates-published-bases.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { applyBracketsDetailed } from '../../src/finance/tax/bracket-schedule.js';

import { AuTaxRates2024 } from '../../src/finance/tax/au/au-tax-rates-2024.js';
import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';
import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';

import { HiStateTaxRates2025 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2025.js';
import { HiStateTaxRates2026 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2026.js';
import { HiStateTaxRates2027 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2027.js';
import { HiStateTaxRates2028 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2028.js';
import { HiStateTaxRates2029 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2029.js';
import { HiStateTaxRates2030 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2030.js';
import { HiStateTaxRates2031 } from '../../src/finance/tax/state/hi/hi-state-tax-rates-2031.js';

import { TaxSettleService }      from '../../src/finance/tax-settle-service.js';
import { StateTaxSettleService } from '../../src/finance/tax/state/state-tax-settle-service.js';

const DOLLAR = 1;

/**
 * Assert a bracket table reproduces the authority's published cumulative base
 * amounts. `bases` maps threshold → published "$X plus Yc over $Z" amount.
 */
function assertPublishedBases(label, brackets, bases) {
  for (const [threshold, published] of Object.entries(bases)) {
    const z      = Number(threshold);
    const actual = applyBracketsDetailed(z, brackets).tax;
    assert.ok(
      Math.abs(actual - published) < DOLLAR,
      `${label}: tax at $${z.toLocaleString()} is ${actual.toFixed(2)}, `
      + `authority publishes $${published.toLocaleString()}`,
    );
  }
}

// ── Australia ────────────────────────────────────────────────────────────────
// Source: ATO "Tax rates – Australian resident" / "Tax rates – foreign resident".

// Stage 3, unchanged across FY2024-25 and FY2025-26.
const AU_RESIDENT_STAGE3 = { 45_000: 4_288, 135_000: 31_288, 190_000: 51_638 };
// FY2026-27: first band 16% → 15%.
const AU_RESIDENT_FY2027 = { 45_000: 4_020, 135_000: 31_020, 190_000: 51_370 };
// FY2027-28: first band 15% → 14%.
const AU_RESIDENT_FY2028 = { 45_000: 3_752, 135_000: 30_752, 190_000: 51_102 };

test('AU resident brackets reproduce the ATO published base amounts', () => {
  assertPublishedBases('AU 2024 resident', new AuTaxRates2024()._brackets, AU_RESIDENT_STAGE3);
  assertPublishedBases('AU 2025 resident', new AuTaxRates2025()._brackets, AU_RESIDENT_STAGE3);
  assertPublishedBases('AU 2026 resident', new AuTaxRates2026()._brackets, AU_RESIDENT_FY2027);
  assertPublishedBases('AU 2027 resident', new AuTaxRates2027()._brackets, AU_RESIDENT_FY2028);
});

test('AU foreign-resident brackets reproduce the ATO published base amount', () => {
  // "$40,500 plus 37c for each $1 over $135,000" — this single figure is what
  // pins the first rate at 30% (135,000 × 0.30). The pre-Stage-3 32.5% that used
  // to sit here produced 43,875 and would fail loudly.
  const bases = { 135_000: 40_500 };
  for (const m of [new AuTaxRates2024(), new AuTaxRates2025(), new AuTaxRates2026(), new AuTaxRates2027()]) {
    assertPublishedBases(`AU ${m.year} foreign resident`, m._nonResidentBrackets, bases);
  }
});

// ── Hawaii ───────────────────────────────────────────────────────────────────
// Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024). Brackets step
// in 2025 / 2027 / 2029; the intervening years inherit them unchanged, so each
// schedule is asserted against every module that should be using it.

const HI_MFJ_2025 = {
  19_200: 269, 28_800: 576, 38_400: 1_104, 48_000: 1_718, 72_000: 3_350,
  96_000: 5_078, 250_000: 16_782, 350_000: 24_682, 450_000: 32_932,
  550_000: 41_932, 650_000: 51_932,
};
const HI_SINGLE_2025 = {
  9_600: 134, 14_400: 288, 19_200: 552, 24_000: 859, 36_000: 1_675,
  48_000: 2_539, 125_000: 8_391, 175_000: 12_341, 225_000: 16_466,
  275_000: 20_966, 325_000: 25_966,
};
const HI_MFJ_2027 = {
  28_800: 403, 38_400: 710, 48_000: 1_238, 72_000: 2_774, 96_000: 4_406,
  250_000: 15_494, 350_000: 23_094, 450_000: 30_994, 550_000: 39_244,
  650_000: 48_244, 800_000: 63_244,
};
const HI_SINGLE_2027 = {
  14_400: 202, 19_200: 355, 24_000: 619, 36_000: 1_387, 48_000: 2_203,
  125_000: 7_747, 175_000: 11_547, 225_000: 15_497, 275_000: 19_622,
  325_000: 24_122, 400_000: 31_622,
};
const HI_MFJ_2029 = {
  38_400: 538, 48_000: 845, 72_000: 2_165, 96_000: 3_701, 250_000: 14_173,
  350_000: 21_373, 450_000: 28_973, 550_000: 36_873, 650_000: 45_123,
  800_000: 58_623, 950_000: 73_623,
};
const HI_SINGLE_2029 = {
  19_200: 269, 24_000: 422, 36_000: 1_082, 48_000: 1_850, 125_000: 7_086,
  175_000: 10_686, 225_000: 14_486, 275_000: 18_436, 325_000: 22_561,
  400_000: 29_311, 475_000: 36_811,
};

test('HI brackets reproduce the DOTAX Announcement 2024-03 base amounts', () => {
  const schedules = [
    [[new HiStateTaxRates2025(), new HiStateTaxRates2026()],                        HI_MFJ_2025, HI_SINGLE_2025],
    [[new HiStateTaxRates2027(), new HiStateTaxRates2028()],                        HI_MFJ_2027, HI_SINGLE_2027],
    [[new HiStateTaxRates2029(), new HiStateTaxRates2030(), new HiStateTaxRates2031()], HI_MFJ_2029, HI_SINGLE_2029],
  ];
  for (const [modules, mfj, single] of schedules) {
    for (const m of modules) {
      assertPublishedBases(`HI ${m.year} MFJ`,    m._brackets_mfj,    mfj);
      assertPublishedBases(`HI ${m.year} single`, m._brackets_single, single);
    }
  }
});

// ── Coverage ─────────────────────────────────────────────────────────────────
//
// The published-base check only guards years that HAVE a module. The other half
// of the audit was years with no module at all: `_getModule`'s highest-year-≤
// fallback always returns something, so a missing year silently files on a stale
// table instead of failing. This asserts each jurisdiction actually reaches the
// default scenario's start year rather than being carried there by the fallback.

const DEFAULT_SIM_START_YEAR = 2026;

test('every jurisdiction has a rates module for the default sim start year', () => {
  const federal = new TaxSettleService();
  for (const cc of ['US', 'AU']) {
    const years = federal._yearsFor(cc);
    assert.ok(years.includes(DEFAULT_SIM_START_YEAR),
      `${cc} has no ${DEFAULT_SIM_START_YEAR} module — it would fall back to ${years.filter(y => y <= DEFAULT_SIM_START_YEAR).pop()}`);
  }

  // States file on the US calendar year. SD levies no income tax, so its single
  // module is year-agnostic and correctly needs no per-year update.
  const stateSvc = new StateTaxSettleService();
  const yearsFor = code => Object.keys(stateSvc._modules)
    .filter(k => k.startsWith(code + '_'))
    .map(k => parseInt(k.split('_')[1], 10));
  for (const code of ['HI']) {
    assert.ok(yearsFor(code).includes(DEFAULT_SIM_START_YEAR),
      `${code} has no ${DEFAULT_SIM_START_YEAR} module`);
  }
});
