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
 * probe-residency-cgt.mjs
 *
 * Headless probe / regression check for the AU residency-change CGT holding-period
 * gate (design 62 §4, Gap 1), driving the REAL production code paths:
 *   - AccountService.recordResidencyChange  — s855-45 deemed-acquisition step-up +
 *                                             per-country deemed-acquisition date stamp
 *   - consumeHoldingsFifo                   — realized basis + the discountable-gain split
 *                                             (≥12 months from the deemed-acquisition date)
 *   - AuTaxRates2025.computeTax / _cgtRelief — the pre-2027 Division 115 50% discount,
 *                                             now applied only to the eligible slice
 *
 * Validated against the ATO guidance "How changing residency affects CGT":
 *   https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/how-changing-residency-affects-cgt
 *
 * Two lots, both bought in 2020 and deemed-acquired at a 1 Jul 2024 US→AU move:
 *   - LOT A sold 6 months after the move  → held <12mo from deemed acquisition → NO discount
 *   - LOT B sold 18 months after the move → held ≥12mo from deemed acquisition → discount
 *
 * Before the fix (see git history): both lots received the full 50% discount because the
 * discount had no holding-period gate and the 12-month test keyed off the original 2020
 * purchase date. This probe now asserts the ATO-correct outcome.
 */

import { AccountService }       from '../src/finance/services/account-service.js';
import { ACCOUNT_TYPE }         from '../src/finance/assets/account.js';
import { ALLOCATION }           from '../src/finance/holdings/allocation.js';
import { consumeHoldingsFifo }  from '../src/finance/holdings/holdings-fifo.js';
import { AuTaxRates2025 }       from '../src/finance/tax/au/au-tax-rates-2025.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const usd = n => '$' + Math.round(n).toLocaleString();

const PURCHASE_MS = Date.UTC(2020, 0, 1);   // original acquisition (both lots)
const MOVE_MS     = Date.UTC(2024, 6, 1);   // become AU resident (deemed acquisition)
const MOVE_CPI    = 1.20;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/**
 * Build a fresh lot, run the real residency step-up (AU basis = 300k market value
 * at the move), then appreciate the lot to its sale-time market value so the sale
 * realizes a genuine post-move gain.
 */
function steppedLot(saleMv = 330_000) {
  const lot = {
    allocation: ALLOCATION.EQUITY,
    costBasis: 100_000,
    marketValue: 300_000,               // value AT THE MOVE (drives the step-up basis)
    purchaseDate: new Date(PURCHASE_MS),
    costBaseByCountry: null,
    acquisitionPriceLevel: null,
    acquisitionDateByCountry: null,
  };
  const account = { type: ACCOUNT_TYPE.BROKERAGE, balance: 300_000, balanceAtResidencyChange: null, holdings: [lot] };
  AccountService.prototype.recordResidencyChange.call(
    new AccountService(), account,
    { country: 'AU', stepUp: true, priceLevel: MOVE_CPI, asOfMs: MOVE_MS },
  );
  const h = account.holdings[0];
  h.marketValue = saleMv;               // appreciate from the move to the sale date
  return h;
}

console.log('═'.repeat(78));
console.log('AU RESIDENCY-CHANGE CGT HOLDING-PERIOD GATE — regression check (design 62 §4)');
console.log('═'.repeat(78));

// ── CONTROL: the s855-45 step-up + deemed-acquisition date stamp ───────────────
const stepped = steppedLot();
console.log('\nCONTROL — deemed acquisition (s855-45 step-up):');
check('AU cost base reset to market value at move', stepped.costBaseByCountry.AU === 300_000, usd(stepped.costBaseByCountry.AU));
check('deemed-acquisition date stamped at the move', stepped.acquisitionDateByCountry?.AU === MOVE_MS,
  new Date(stepped.acquisitionDateByCountry?.AU).toISOString().slice(0, 10));
check('original purchaseDate left unchanged (FIFO/straddle safe)',
  new Date(stepped.purchaseDate).getTime() === PURCHASE_MS, new Date(stepped.purchaseDate).toISOString().slice(0, 10));

// ── LOT A: sold 6 months after the move → NO discount ──────────────────────────
const saleA = MOVE_MS + 6 * YEAR_MS / 12;
const fifoA = consumeHoldingsFifo([steppedLot()], 330_000, { level: 1.23, asOfMs: saleA, country: 'AU' });
const auGainA = 330_000 - fifoA.realizedBasisByCountry.AU;
const discA   = fifoA.realizedDiscountableGainByCountry.AU;
console.log('\nLOT A — sold 6 months after the move (held <12mo from deemed acquisition):');
check('AU gain measured from stepped-up basis', auGainA === 30_000, usd(auGainA));
check('discountable gain is ZERO (discount denied)', discA === 0, usd(discA));

// ── LOT B: sold 18 months after the move → discount applies ────────────────────
const saleB = MOVE_MS + 18 * YEAR_MS / 12;
const fifoB = consumeHoldingsFifo([steppedLot()], 330_000, { level: 1.23, asOfMs: saleB, country: 'AU' });
const auGainB = 330_000 - fifoB.realizedBasisByCountry.AU;
const discB   = fifoB.realizedDiscountableGainByCountry.AU;
console.log('\nLOT B — sold 18 months after the move (held ≥12mo from deemed acquisition):');
check('discountable gain equals the full AU gain (discount allowed)', discB === auGainB, usd(discB));

// ── Tax impact via the real AuTaxRates2025.computeTax ──────────────────────────
// Lot A: the eligible slice (auDiscountableGainsYTD) is 0 → no discount → full gain taxed.
// Lot B: the eligible slice equals the gain → full 50% discount as before.
const rates  = new AuTaxRates2025();
const people = { p1: { residency: 'AU' } };
const ORD = 40_000;
const taxA = rates.computeTax({ people, auOrdinaryIncomeYTD: ORD, auCapitalGainsYTD: auGainA, auDiscountableGainsYTD: discA });
const taxB = rates.computeTax({ people, auOrdinaryIncomeYTD: ORD, auCapitalGainsYTD: auGainB, auDiscountableGainsYTD: discB });
const fullDiscountA = rates.computeTax({ people, auOrdinaryIncomeYTD: ORD, auCapitalGainsYTD: auGainA }); // legacy: no gate

console.log('\nTAX (ordinary income ' + usd(ORD) + ', gain ' + usd(30_000) + '):');
console.log(`  LOT A  code (gated, no discount) = ${usd(taxA.netLiability)}   cgtDiscount = ${usd(taxA.cgtDiscount)}`);
console.log(`  LOT A  legacy (ungated discount) = ${usd(fullDiscountA.netLiability)}   cgtDiscount = ${usd(fullDiscountA.cgtDiscount)}`);
console.log(`  LOT B  code (gated, discount)    = ${usd(taxB.netLiability)}   cgtDiscount = ${usd(taxB.cgtDiscount)}`);
check('Lot A now taxed WITHOUT the discount', taxA.cgtDiscount === 0, 'discount ' + usd(taxA.cgtDiscount));
check('Lot A gate recovers the prior over-relief', taxA.netLiability > fullDiscountA.netLiability,
  '+' + usd(taxA.netLiability - fullDiscountA.netLiability));
check('Lot B still gets the full 50% discount', taxB.cgtDiscount === auGainB * 0.5, usd(taxB.cgtDiscount));

console.log('\n' + '═'.repeat(78));
console.log(failures === 0
  ? 'RESULT: PASS — Gap 1 resolved. Discount gated on ≥12mo from the deemed-acquisition date.'
  : `RESULT: FAIL — ${failures} check(s) failed.`);
console.log('═'.repeat(78));
process.exit(failures === 0 ? 0 : 1);
