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
 * evt-real-property.test.mjs
 * Tests for Real Property events: EVT-33 and EVT-34
 *
 * EVT-33  Australian House Sale  into checking  US: capital gain, AU: always NR withholding rate, FTC
 * EVT-34  US House Sale          into checking  US: capital gain after $500K exemption,
 *                                                AU: TODO (??) if resident, FTC
 *
 * Run with: node --test tests/evt-real-property.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account } from '../src/finance/account.js';
import { Simulation } from '../src/simulation-framework/simulation.js';
import { TaxService } from '../src/finance/tax-service.js';
import { PeriodService } from '../src/finance/period/period-service.js';
import { buildUsCalendarYear, buildAuFiscalYear, applyTo } from '../src/finance/period/period-builder.js';

// Jan 1 2026: US calendar year 2026, AU fiscal year starting Jul 1 2025 (FY2025-26).
function buildMixedPeriodService() {
  const ps = new PeriodService();
  applyTo(ps, buildUsCalendarYear(2026));
  applyTo(ps, buildAuFiscalYear(2025));
  return ps;
}

function buildRealPropertySim({
  initialChecking  = 5000,
  isAuResident     = false,
} = {}) {
  const initialState = {
    checkingAccount: new Account(initialChecking),
    isAuResident,
    usCapitalGainsYTD:           0,
    auCapitalGainsYTD:           0,
    auNonResidentWithholdingYTD: 0,
    ftcYTD:                      0,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });
  // EVT-33 (AU house) + EVT-34 (US house) — needs both country modules
  const svc = new TaxService().registerWith(sim, ['AU', 'US'], buildMixedPeriodService());

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-33: Australian House Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-33: AU house sale credits full sale proceeds to checking', () => {
  const { sim } = buildRealPropertySim({ initialChecking: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_HOUSE_SALE',
    data: { salePrice: 800000, costBasis: 400000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 850000); // 50000 + 800000
});

test('EVT-33: AU house sale records US capital gain (sale price - cost basis)', () => {
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_HOUSE_SALE',
    data: { salePrice: 800000, costBasis: 400000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 400000);
});

test('EVT-33: AU house sale is always AU taxable at non-resident withholding rate', () => {
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_HOUSE_SALE',
    data: { salePrice: 800000, costBasis: 400000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 400000);
});

test('EVT-33: AU house sale generates a Foreign Tax Credit', () => {
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_HOUSE_SALE',
    data: { salePrice: 800000, costBasis: 400000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU house sale');
});

test('EVT-33: AU house sale with no gain has zero capital gains tax exposure', () => {
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_HOUSE_SALE',
    data: { salePrice: 400000, costBasis: 400000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-34: US House Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-34: US house sale credits full sale proceeds to checking', () => {
  const { sim } = buildRealPropertySim({ initialChecking: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'US_HOUSE_SALE',
    data: { salePrice: 1200000, costBasis: 200000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 1250000); // 50000 + 1200000
});

test('EVT-34: US house sale applies $500K primary residence exemption to capital gain', () => {
  // gain = 1000000 - 200000 = 800000; after 500K exemption = 300000
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'US_HOUSE_SALE',
    data: { salePrice: 1000000, costBasis: 200000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 300000);
});

test('EVT-34: US house sale with gain under $500K has zero taxable capital gain', () => {
  // gain = 600000 - 200000 = 400000; after 500K exemption = 0
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'US_HOUSE_SALE',
    data: { salePrice: 600000, costBasis: 200000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
});

test('EVT-34: US house sale with no gain has zero capital gains exposure', () => {
  const { sim } = buildRealPropertySim();
  sim.schedule({ date: new Date(2026, 0, 15), type: 'US_HOUSE_SALE',
    data: { salePrice: 400000, costBasis: 400000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
});

// TODO (EVT-34): AU tax treatment for a US house sale when the person is an AU resident is
// unresolved (CSV: "??"). When clarified, add assertions here for auCapitalGainsYTD or
// auNonResidentWithholdingYTD as applicable.
