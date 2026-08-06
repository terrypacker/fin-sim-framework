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
 * The `loan` and `offset` levers (design 86 §4) — debt structure as a study axis.
 *
 * Two things these pin that nothing else can:
 *
 *  · **A mortgage has no account to edit.** The loan is synthesized at build time from
 *    the PROPERTY's `mortgage*` fields under the key `${propStateKey}Loan`, while a
 *    workbench export ALSO persists an `initialState` entry that shadows it. A lever
 *    writing one and not the other is silently inert against exactly the configs
 *    studies run on.
 *
 *  · **`offset.deployTo` must conserve wealth.** Arms that differ in total wealth are
 *    not comparable, and an offset study is entirely about where a fixed pot sits.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildVariant, applyLoan, applyOffset, makeSetParam } from '../../scripts/lib/variant.mjs';

/** A cfg shaped like a workbench export: property record + persisted loan + offset. */
const exportedCfg = () => ({
  params: [{ name: 'auPrimeRate', value: 0.04 }],
  parameters: { auPrimeRate: 0.04 },
  realProperties: [{
    stateKey: 'hProperty', country: 'AU', value: 1_000_000,
    mortgageBalance: 300_000, monthlyMortgage: 2_000,
    mortgageInterestRate: 0, mortgagePrimeSpread: 0.02,
  }],
  accounts: [
    { __type: 'OffsetAccount', type: 'offset', stateKey: 'off', balance: 100_000,
      offsetsPropertyKey: 'hProperty',
      holdings: [{ allocation: 'CASH', marketValue: 100_000, costBasis: 100_000 }] },
    { __type: 'BrokerageAccount', type: 'brokerage', stateKey: 'brk', balance: 400_000,
      holdings: [{ allocation: 'EQUITY', marketValue: 300_000, costBasis: 150_000 },
                 { allocation: 'BOND',   marketValue: 100_000, costBasis: 100_000 }] },
  ],
  initialState: {
    hPropertyLoan: { type: 'loan', stateKey: 'hPropertyLoan', balance: 300_000,
                     monthlyPayment: 2_000, primeSpread: 0.02, interestRate: 0,
                     linkedPropertyKey: 'hProperty', country: 'AU' },
    off: { type: 'offset', stateKey: 'off', balance: 100_000, offsetsPropertyKey: 'hProperty',
           holdings: [{ allocation: 'CASH', marketValue: 100_000, costBasis: 100_000 }] },
    brk: { type: 'brokerage', stateKey: 'brk', balance: 400_000,
           holdings: [{ allocation: 'EQUITY', marketValue: 300_000, costBasis: 150_000 },
                      { allocation: 'BOND',   marketValue: 100_000, costBasis: 100_000 }] },
  },
});

const totalWealth = (cfg) =>
  (cfg.accounts ?? []).reduce((s, a) => s + (a.balance ?? 0), 0);

describe('loan lever', () => {
  test('writes the PROPERTY record and the persisted state entry together', () => {
    const cfg = exportedCfg();
    applyLoan(cfg, makeSetParam(cfg), 'hPropertyLoan', { balance: 500_000, monthlyPayment: 3_400 });

    // The record is what synthesizeLoanForProperty reads at build time…
    assert.equal(cfg.realProperties[0].mortgageBalance, 500_000);
    assert.equal(cfg.realProperties[0].monthlyMortgage, 3_400);
    // …and the persisted entry is what shadows it on a file-sourced cfg.
    assert.equal(cfg.initialState.hPropertyLoan.balance, 500_000);
    assert.equal(cfg.initialState.hPropertyLoan.monthlyPayment, 3_400);
  });

  test('interestOnly reaches both, under the field name each side uses', () => {
    const cfg = exportedCfg();
    applyLoan(cfg, makeSetParam(cfg), 'hPropertyLoan', { interestOnly: true });
    assert.equal(cfg.realProperties[0].mortgageInterestOnly, true, 'property field name');
    assert.equal(cfg.initialState.hPropertyLoan.interestOnly, true, 'loan field name');
  });

  test('an interest-only mortgage keeps a positive monthlyMortgage so the payment event is scheduled', () => {
    // The real-property toolsets only schedule LOAN_PAYMENT for a property with BOTH
    // a positive balance and a positive monthlyMortgage. Zero it and the loan runs free.
    const cfg = exportedCfg();
    applyLoan(cfg, makeSetParam(cfg), 'hPropertyLoan', { interestOnly: true, monthlyPayment: 0 });
    assert.ok(cfg.realProperties[0].monthlyMortgage > 0);
  });

  test('primeSpread: null is meaningful (fix the rate), not "absent"', () => {
    const cfg = exportedCfg();
    applyLoan(cfg, makeSetParam(cfg), 'hPropertyLoan', { primeSpread: null, interestRate: 0.07 });
    assert.equal(cfg.realProperties[0].mortgagePrimeSpread, null);
    assert.equal(cfg.initialState.hPropertyLoan.primeSpread, null);
    assert.equal(cfg.realProperties[0].mortgageInterestRate, 0.07);
  });

  test('works on a standalone LoanAccount with no property behind it', () => {
    const cfg = exportedCfg();
    cfg.accounts.push({ __type: 'LoanAccount', type: 'loan', stateKey: 'invLoan', balance: 200_000 });
    applyLoan(cfg, makeSetParam(cfg), 'invLoan', { balance: 250_000, interestOnly: true });
    const loan = cfg.accounts.find(a => a.stateKey === 'invLoan');
    assert.equal(loan.balance, 250_000);
    assert.equal(loan.interestOnly, true);
  });

  test('throws on an unknown loan rather than being silently inert', () => {
    const cfg = exportedCfg();
    assert.throws(() => applyLoan(cfg, makeSetParam(cfg), 'nopeLoan', { balance: 1 }), /loan lever:/);
  });
});

describe('offset lever', () => {
  test('deployTo conserves total wealth', () => {
    const cfg = exportedCfg();
    const before = totalWealth(cfg);
    applyOffset(cfg, 'off', { balance: 0, deployTo: 'brk' });
    assert.equal(cfg.accounts[0].balance, 0);
    assert.equal(cfg.accounts[1].balance, 500_000);
    assert.equal(totalWealth(cfg), before, 'the pot must be the same size in every arm');
  });

  test('moves value in the other direction too', () => {
    const cfg = exportedCfg();
    const before = totalWealth(cfg);
    applyOffset(cfg, 'off', { balance: 300_000, deployTo: 'brk' });
    assert.equal(cfg.accounts[1].balance, 200_000);
    assert.equal(totalWealth(cfg), before);
  });

  test('holdings track the balance on BOTH sides, preserving the destination mix', () => {
    const cfg = exportedCfg();
    applyOffset(cfg, 'off', { balance: 0, deployTo: 'brk' });

    assert.equal(cfg.accounts[0].holdings[0].marketValue, 0, 'offset sleeve drained');
    // 400k → 500k is ×1.25 on every sleeve, so the 75/25 mix is unchanged.
    const [eq, bond] = cfg.accounts[1].holdings;
    assert.equal(eq.marketValue, 375_000);
    assert.equal(bond.marketValue, 125_000);
    assert.equal(eq.marketValue / (eq.marketValue + bond.marketValue), 0.75);
  });

  test('scales costBasis with marketValue — no phantom capital gain', () => {
    const cfg = exportedCfg();
    applyOffset(cfg, 'off', { balance: 0, deployTo: 'brk' });
    const eq = cfg.accounts[1].holdings[0];
    // Unscaled basis would leave 375k market against a 150k basis: 100k of gain
    // conjured out of a cash transfer, taxed on the next disposal.
    assert.equal(eq.costBasis, 187_500);
    assert.equal(eq.marketValue / eq.costBasis, 2, 'embedded gain ratio unchanged');
  });

  test('the persisted initialState copy moves in lockstep with the record', () => {
    const cfg = exportedCfg();
    applyOffset(cfg, 'off', { balance: 50_000, deployTo: 'brk' });
    assert.equal(cfg.initialState.off.balance, 50_000);
    assert.equal(cfg.initialState.off.holdings[0].marketValue, 50_000);
    assert.equal(cfg.initialState.brk.balance, 450_000);
  });

  test('refilling from zero gives a single holding basis = market', () => {
    const cfg = exportedCfg();
    applyOffset(cfg, 'off', { balance: 0, deployTo: 'brk' });
    applyOffset(cfg, 'off', { balance: 80_000, deployTo: 'brk' });
    assert.equal(cfg.accounts[0].holdings[0].marketValue, 80_000);
    assert.equal(cfg.accounts[0].holdings[0].costBasis, 80_000);
  });

  test('throws on an unknown account or deployTo target', () => {
    const cfg = exportedCfg();
    assert.throws(() => applyOffset(cfg, 'nope', { balance: 0 }), /offset lever:/);
    assert.throws(() => applyOffset(cfg, 'off', { balance: 0, deployTo: 'nope' }), /deployTo:/);
  });

  test('FX-converts across a currency boundary rather than conserving digits', () => {
    // An AU offset is AUD; the obvious deployTo targets are USD. Moving the raw number
    // would create ~a third of the pot out of nothing and make the arms incomparable.
    const cfg = exportedCfg();
    cfg.params.push({ name: 'exchangeRateUsdToAud', value: 1.5 });
    cfg.parameters.exchangeRateUsdToAud = 1.5;
    cfg.accounts[0].currency = { code: 'AUD', symbol: 'A$' };
    cfg.accounts[1].currency = { code: 'USD', symbol: '$' };
    cfg.initialState.off.currency = { code: 'AUD' };
    cfg.initialState.brk.currency = { code: 'USD' };

    applyOffset(cfg, 'off', { balance: 0, deployTo: 'brk' });
    assert.equal(cfg.accounts[0].balance, 0);
    assert.ok(Math.abs(cfg.accounts[1].balance - (400_000 + 100_000 / 1.5)) < 0.01,
      `A$100k should arrive as ~US$66.7k, got ${cfg.accounts[1].balance}`);
  });

  test('a cross-currency move without a rate fails loud', () => {
    const cfg = exportedCfg();
    cfg.accounts[0].currency = { code: 'AUD' };
    cfg.accounts[1].currency = { code: 'USD' };
    assert.throws(() => applyOffset(cfg, 'off', { balance: 0, deployTo: 'brk' }),
      /exchangeRateUsdToAud/);
  });
});

describe('spendTotal vs an interest-only loan', () => {
  // `monthlyExpenses` is not total outflow: the loan payment is a separate cash flow.
  // An IO loan has no fixed payment to subtract, so spendTotal must estimate it — or
  // every IO arm silently spends the whole debt service twice over.
  const expensesOf = (cfg) => cfg.parameters.monthlyExpenses;

  test('P&I subtracts the authored payment', () => {
    const cfg = buildVariant(exportedCfg(), { spendTotal: 10_000 });
    assert.equal(expensesOf(cfg), 8_000, '10,000 all-in − 2,000 payment');
  });

  test('interest-only subtracts the DERIVED interest, not the placeholder payment', () => {
    // 500k principal − 100k offset = 400k at (4% prime + 2% spread) / 12 = 2,000/mo.
    const cfg = buildVariant(exportedCfg(), {
      loan: { hPropertyLoan: { balance: 500_000, interestOnly: true, monthlyPayment: 0 } },
      spendTotal: 10_000,
    });
    assert.equal(expensesOf(cfg), 8_000);
  });

  test('a fully offset interest-only loan costs nothing, so the whole budget is expenses', () => {
    const cfg = buildVariant(exportedCfg(), {
      loan:   { hPropertyLoan: { balance: 100_000, interestOnly: true, monthlyPayment: 0 } },
      spendTotal: 10_000,
    });
    assert.equal(expensesOf(cfg), 10_000);
  });
});

describe('lever ordering', () => {
  test('loans are applied before offsets, so an offset can be sized against the new balance', () => {
    const cfg = buildVariant(exportedCfg(), {
      loan:   { hPropertyLoan: { balance: 500_000 } },
      offset: { off: { balance: 500_000, deployTo: 'brk' } },
    });
    assert.equal(cfg.initialState.hPropertyLoan.balance, 500_000);
    assert.equal(cfg.accounts[0].balance, 500_000);
    assert.equal(cfg.accounts[1].balance, 0, 'the brokerage funded the offset top-up');
  });
});

describe('offset drawdownPriority', () => {
  test('sets it on both representations, independently of the balance', () => {
    // An offset left at the default `drawdownPriority: null` is EXCLUDED from
    // drawdown, so a grid sweeping the offset balance unknowingly sweeps how much of
    // the portfolio is spendable — and reports that filling the offset wrecks
    // solvency. That is an artefact of unreachable cash, not economics.
    const cfg = exportedCfg();
    assert.equal(cfg.accounts[0].drawdownPriority, undefined);
    applyOffset(cfg, 'off', { drawdownPriority: 2 });
    assert.equal(cfg.accounts[0].drawdownPriority, 2);
    assert.equal(cfg.initialState.off.drawdownPriority, 2);
    assert.equal(cfg.accounts[0].balance, 100_000, 'balance untouched when not given');
  });
});
