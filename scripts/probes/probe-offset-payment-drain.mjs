#!/usr/bin/env node
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
 * probe-offset-payment-drain.mjs — design 97 §20, integrity check 2.
 *
 * An arm that spends the offset in a down market and refills it afterwards is only a
 * measurement of THAT policy if the offset is not being drained by something else at the same
 * time. `resolveLoanCashKey` (design 54 P4) says it is: with no explicit `paymentSourceKey`
 * a loan direct-debits a same-currency offset linked to its property, in preference to the
 * ordinary cash resolver. That is realistic — an AU offset IS the account the mortgage debits
 * — and it is exactly why it must be pinned or measured rather than left to the default: the
 * facility would then shrink on the amortisation schedule in EVERY arm, crash or no crash,
 * and a study reading "the offset ran out" would be reading the direct debit.
 *
 * §19.2b already met this second-hand: the facility fell "at a flat rate in every arm, crash
 * or no crash". This probe separates the two causes.
 *
 * Two arms, one variable — where the mortgage payment is debited from:
 *   A  default          → the linked offset (what `resolveLoanCashKey` chooses)
 *   B  paymentSourceKey → an ordinary AU savings account
 *
 * Reported per year: the offset balance, the loan balance, and the FACILITY the pool graph
 * would see, which is `min(offset, loan)` (POOL_CAPACITY_MODE.OFFSET_CAP, §12.1) — the figure
 * that decides how much spending the backstop can actually absorb.
 *
 * Usage: node scripts/probes/probe-offset-payment-drain.mjs
 */

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { openSim, quiet }         from '../lib/run.mjs';

const OFFSET = 'auOffsetAccount';
const LOAN   = 'auHousePropertyLoan';   // synthesized from the property's mortgage (design 54 P2)

function build({ paymentSourceKey = null } = {}) {
  const cfg = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' });
  const house = cfg.realProperties.find(r => r.stateKey === 'auHouseProperty');
  house.mortgageBalance      = 400_000;
  house.monthlyMortgage      = 3_000;
  house.mortgageInterestRate = 0.05;
  if (paymentSourceKey) house.mortgagePaymentSourceKey = paymentSourceKey;
  cfg.accounts.push({
    __type: 'OffsetAccount', stateKey: OFFSET, type: 'offset',
    name: 'AU Offset', role: 'au-offset',
    balance: 300_000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
    offsetsPropertyKey: 'auHouseProperty',
    // Not a drawdown source: this probe is about the LOAN's debit, and an offset that
    // spending also draws would confound the two.
    drawdownPriority: null,
  });
  return cfg;
}

function run(cfg) {
  const rows = [];
  quiet(() => {
    const sim = openSim(cfg, {
      telemetry: 'off',
      samplerCadence: 'year-boundary',
      sampler: (state, date) => ({
        year:   new Date(date).getUTCFullYear(),
        offset: state?.[OFFSET]?.balance ?? null,
        loan:   state?.[LOAN]?.balance ?? null,
      }),
    });
    sim.stepTo(new Date(cfg.simEnd));
    rows.push(...sim.samples);
  });
  return rows;
}

const A = run(build());
const B = run(build({ paymentSourceKey: 'auSavingsAccount' }));

if (!A.length || A[0].loan == null) {
  console.log('\nNO LOAN AT KEY', LOAN, '— the mortgage did not synthesize; nothing measured.\n');
  process.exit(1);
}

const aud = (v) => v == null ? '—' : `A$${Math.round(v).toLocaleString()}`;
const facility = (r) => (r.offset == null || r.loan == null) ? null : Math.min(r.offset, Math.max(0, r.loan));

console.log('\nOFFSET DRAIN BY THE LOAN\'S OWN PAYMENT — one variable: where the mortgage debits');
console.log('\n            A: payment debits the OFFSET (default)      B: payment debits AU savings');
console.log('year        offset        loan     facility          offset        loan     facility');
console.log('──────────────────────────────────────────────────────────────────────────────────────');
const byYearB = new Map(B.map(r => [r.year, r]));
for (const a of A) {
  const b = byYearB.get(a.year);
  if (!b) continue;
  console.log(
    `${a.year}  ${aud(a.offset).padStart(11)} ${aud(a.loan).padStart(11)} ${aud(facility(a)).padStart(11)}    `
    + `${aud(b.offset).padStart(11)} ${aud(b.loan).padStart(11)} ${aud(facility(b)).padStart(11)}`);
}

const first = A[0], last = A[A.length - 1];
const lastB = byYearB.get(last.year);
console.log('\nover the run:');
console.log(`  A  facility ${aud(facility(first))} → ${aud(facility(last))}`);
console.log(`  B  facility ${aud(facility(first))} → ${aud(facility(lastB))}`);
console.log('\nThe difference between the two right-hand columns is the drain a spend-side study');
console.log('would otherwise attribute to its own policy.\n');
