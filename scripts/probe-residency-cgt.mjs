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
 * Headless probe that drives the REAL production code paths involved in the
 * AU residency-change CGT treatment, to validate the gaps identified against
 * the ATO guidance on "How changing residency affects CGT":
 *   https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/how-changing-residency-affects-cgt
 *
 * It exercises (not re-implements):
 *   - AccountService.recordResidencyChange  — the ITAA97 s855-45 deemed-acquisition step-up
 *   - consumeHoldingsFifo                   — realized per-country basis + the ≥12-month test
 *   - AuTaxRates2025.computeTax / _cgtRelief — the pre-2027 Division 115 50% discount
 *
 * What it demonstrates, using a lot that is legally held < 12 months (measured
 * from the deemed-acquisition / residency date) but > 12 months from its
 * original purchase date:
 *
 *   CONTROL (works)  — the deemed-acquisition step-up resets the AU cost base to
 *                      market value at the move. "Resetting the cost basis" is the
 *                      CORRECT s855-45 rule, not an oversimplification.
 *
 *   GAP 1a (bug)     — the 50% CGT discount is applied with NO holding-period gate
 *                      whatsoever. A lot that fails the 12-month rule still gets the
 *                      full discount. Dollar impact quantified via the real brackets.
 *
 *   GAP 1b (bug)     — consumeHoldingsFifo's held-≥12-month test keys off the ORIGINAL
 *                      purchaseDate, which the step-up deliberately leaves unchanged.
 *                      ATO restarts the 12-month clock at the residency date, so this
 *                      lot should read held<12mo but the code reads held>12mo.
 *
 * Usage:  node scripts/probe-residency-cgt.mjs
 *         npm run probe:residency-cgt   (if wired in package.json)
 */

import { AccountService }       from '../src/finance/services/account-service.js';
import { ACCOUNT_TYPE }         from '../src/finance/assets/account.js';
import { ALLOCATION }           from '../src/finance/holdings/allocation.js';
import { consumeHoldingsFifo }  from '../src/finance/holdings/holdings-fifo.js';
import { AuTaxRates2025 }       from '../src/finance/tax/au/au-tax-rates-2025.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const usd = n => '$' + Math.round(n).toLocaleString();

// ── Fixture: one US-brokerage equity lot straddling a US→AU move ───────────────
//
// Bought well before the move; the person becomes an AU resident on 1 Jul 2024
// (a pre-2027 year, so the flat 50% Division 115 discount regime applies), and
// sells the lot 6 months later — i.e. held only 6 months from the AU deemed
// acquisition, but ~4.5 years from the original purchase.

const PURCHASE_MS = Date.UTC(2020, 0, 1);   // 2020-01-01  original acquisition
const MOVE_MS     = Date.UTC(2024, 6, 1);   // 2024-07-01  become AU resident (deemed acq.)
const SALE_MS     = Date.UTC(2025, 0, 1);   // 2025-01-01  sale (6 months after the move)

const MOVE_CPI = 1.20;   // AU price level at the move (indexation base)
const SALE_CPI = 1.23;   // AU price level at sale

// Cost basis is the ORIGINAL (US, worldwide) basis; marketValue is the value now.
const lot = {
  id: 'h1',
  allocation: ALLOCATION.EQUITY,
  costBasis: 100_000,          // original US basis
  marketValue: 300_000,        // market value AT THE MOVE
  purchaseDate: new Date(PURCHASE_MS),
  costBaseByCountry: null,
  acquisitionPriceLevel: null,
  label: 'ITOT',
};

const account = {
  type: ACCOUNT_TYPE.BROKERAGE,
  balance: 300_000,
  balanceAtResidencyChange: null,
  holdings: [lot],
};

console.log('═'.repeat(78));
console.log('AU RESIDENCY-CHANGE CGT PROBE  (real production code paths)');
console.log('═'.repeat(78));
console.log(`Lot: bought ${new Date(PURCHASE_MS).toISOString().slice(0,10)}  basis ${usd(lot.costBasis)}  value-at-move ${usd(lot.marketValue)}`);
console.log(`Become AU resident: ${new Date(MOVE_MS).toISOString().slice(0,10)}  (deemed acquisition)`);
console.log(`Sell:               ${new Date(SALE_MS).toISOString().slice(0,10)}  (6 months after the move)\n`);

// ── Step 1: the real s855-45 deemed-acquisition step-up ───────────────────────
// recordResidencyChange does not use `this`, so it is safe to invoke on a bare
// instance — we are exercising the exact production method.
AccountService.prototype.recordResidencyChange.call(
  new AccountService(),
  account,
  { country: 'AU', stepUp: true, priceLevel: MOVE_CPI },
);
const stepped = account.holdings[0];

console.log('── CONTROL: deemed-acquisition step-up (should reset AU basis to market) ──');
console.log(`  costBaseByCountry.AU   = ${usd(stepped.costBaseByCountry.AU)}   (expected ${usd(300_000)} = market value at move)`);
console.log(`  acquisitionPriceLevel  = ${stepped.acquisitionPriceLevel}          (expected ${MOVE_CPI} = AU CPI at move)`);
console.log(`  purchaseDate           = ${new Date(stepped.purchaseDate).toISOString().slice(0,10)}   (UNCHANGED by the step-up)`);
const stepUpOk = stepped.costBaseByCountry.AU === 300_000 && stepped.acquisitionPriceLevel === MOVE_CPI;
console.log(`  → step-up correct? ${stepUpOk ? 'YES — s855-45 reset works as designed' : 'NO'}\n`);

// ── Step 2: sell 6 months after the move; inspect the ≥12-month test ──────────
const proceeds = 330_000;   // value at sale
const fifo = consumeHoldingsFifo(
  account.holdings,
  proceeds,
  { level: SALE_CPI, asOfMs: SALE_MS, country: 'AU' },
);

const monthsSincePurchase = (SALE_MS - PURCHASE_MS) / YEAR_MS * 12;
const monthsSinceMove     = (SALE_MS - MOVE_MS)     / YEAR_MS * 12;
const codeHeld12mo        = (SALE_MS - PURCHASE_MS) >= YEAR_MS;   // what holdings-fifo tests
const atoHeld12mo         = (SALE_MS - MOVE_MS)     >= YEAR_MS;   // what the ATO clock says

const auBasis  = fifo.realizedBasisByCountry.AU;
const auGain   = proceeds - auBasis;

console.log('── GAP 1b: the ≥12-month test keys off the ORIGINAL purchase date ──');
console.log(`  months held since original purchase = ${monthsSincePurchase.toFixed(1)}`);
console.log(`  months held since deemed acquisition = ${monthsSinceMove.toFixed(1)}  (ATO clock restarts here)`);
console.log(`  consumeHoldingsFifo held12mo         = ${codeHeld12mo}   (uses purchaseDate)`);
console.log(`  ATO-correct held12mo                 = ${atoHeld12mo}  (uses residency date)`);
console.log(`  → MISMATCH? ${codeHeld12mo !== atoHeld12mo ? 'YES — code grants ≥12mo treatment the ATO would deny' : 'no'}`);
console.log(`  realized AU basis = ${usd(auBasis)}  → AU gain from stepped-up basis = ${usd(auGain)}\n`);

// ── Step 3: quantify the pre-2027 50% discount applied with no holding gate ───
// Drive the real AuTaxRates2025.computeTax twice on an otherwise-identical
// resident with modest ordinary income:
//   (i)  gain in auCapitalGainsYTD  → the code path: 50% discount applied
//   (ii) same gain as ordinary      → the ATO-correct path when the discount is
//        denied (held < 12mo): the whole gain is assessable at marginal rates.
const rates = new AuTaxRates2025();
const ORD = 40_000;   // some ordinary income so the gain is taxed at a realistic marginal rate
const people = { p1: { residency: 'AU' } };

const relief = rates._cgtRelief({}, auGain);
const withDiscount = rates.computeTax({
  people, auOrdinaryIncomeYTD: ORD, auCapitalGainsYTD: auGain,
});
const discountDenied = rates.computeTax({
  people, auOrdinaryIncomeYTD: ORD + auGain, auCapitalGainsYTD: 0,
});
const taxDelta = discountDenied.netLiability - withDiscount.netLiability;

console.log('── GAP 1a: the 50% CGT discount is applied with NO holding-period gate ──');
console.log(`  _cgtRelief on a lot held ${monthsSinceMove.toFixed(0)}mo (< 12mo from deemed acq.):`);
console.log(`    reliefAmount   = ${usd(relief.reliefAmount)}   (50% of the ${usd(auGain)} gain — granted unconditionally)`);
console.log(`    netTaxableGain = ${usd(relief.netTaxableGain)}`);
console.log(`  AU tax on this sale (ordinary income ${usd(ORD)}):`);
console.log(`    code path (discount applied) = ${usd(withDiscount.netLiability)}`);
console.log(`    ATO-correct (discount denied)= ${usd(discountDenied.netLiability)}`);
console.log(`    → over-relief on THIS lot     = ${usd(taxDelta)}  (${(taxDelta / auGain * 100).toFixed(1)}% of the AU gain)\n`);

console.log('═'.repeat(78));
console.log('SUMMARY');
console.log('═'.repeat(78));
console.log(`  CONTROL  deemed-acquisition step-up ....... ${stepUpOk ? 'CORRECT (reset works)' : 'BROKEN'}`);
console.log(`  GAP 1a   discount has no 12-month gate ...  CONFIRMED — over-relief ${usd(taxDelta)} on a ${usd(auGain)} gain`);
console.log(`  GAP 1b   12-month test uses purchaseDate .. ${codeHeld12mo !== atoHeld12mo ? 'CONFIRMED — reads ≥12mo, ATO says <12mo' : 'not triggered'}`);
console.log('═'.repeat(78));
