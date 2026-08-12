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

import { buildVariant, applyLoan, applyOffset, applyFacility, makeSetParam } from '../../scripts/lib/variant.mjs';

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

  test('an interest-only mortgage writes the authored payment through, placeholder-free', () => {
    // The lever used to seed `monthlyMortgage = 1` here, because the real-property
    // toolsets scheduled LOAN_PAYMENT only for a property with a positive
    // monthlyMortgage — an IO mortgage derives its payment, so a truthful 0 meant the
    // loan was never paid at all. The toolsets now gate on `propertyNeedsLoanPayment`,
    // which counts an IO or term-bearing mortgage, so the placeholder is gone and what
    // the spec asked for is what the cfg carries.
    const cfg = exportedCfg();
    applyLoan(cfg, makeSetParam(cfg), 'hPropertyLoan', { interestOnly: true, monthlyPayment: 0 });
    assert.equal(cfg.realProperties[0].monthlyMortgage, 0);
    assert.equal(cfg.initialState.hPropertyLoan.monthlyPayment, 0);
    assert.equal(cfg.realProperties[0].mortgageInterestOnly, true);
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

  // ─── fromBalance: the drawn facility ───────────────────────────────────────
  //
  // Studying a facility LARGER than the scenario authors raises the liability via the
  // `loan` lever, and the proceeds have to land somewhere in every arm. Without
  // `fromBalance` only the parking arm receives them — raising an offset with no
  // `deployTo` credits the difference, which is right, but the deploying arm starts
  // from the authored balance and is short the uplift for the whole horizon.

  test('fromBalance seeds the facility, so park and deploy hold equal wealth', () => {
    // Authored offset 100k; the facility under study is 250k.
    const park = exportedCfg();
    applyOffset(park, 'off', { fromBalance: 250_000, balance: 250_000 });

    const deploy = exportedCfg();
    applyOffset(deploy, 'off', { fromBalance: 250_000, balance: 0, deployTo: 'brk' });

    assert.equal(park.accounts[0].balance, 250_000);
    assert.equal(deploy.accounts[0].balance, 0);
    assert.equal(deploy.accounts[1].balance, 650_000, 'the whole facility reaches the brokerage');
    assert.equal(totalWealth(park), totalWealth(deploy),
      'the arms must hold the same pot — this is the comparison, not a detail');
  });

  test('WITHOUT fromBalance the deploying arm is short the uplift', () => {
    // Pins the defect the option is there to prevent, so a spec that omits it cannot
    // be mistaken for one that does not need it.
    const park = exportedCfg();
    applyOffset(park, 'off', { balance: 250_000 });
    const deploy = exportedCfg();
    applyOffset(deploy, 'off', { balance: 0, deployTo: 'brk' });

    assert.equal(totalWealth(park) - totalWealth(deploy), 150_000,
      'the uplift reaches only the arm that parks it');
  });

  test('fromBalance alone (no balance) just draws the facility into the offset', () => {
    const cfg = exportedCfg();
    const before = totalWealth(cfg);
    applyOffset(cfg, 'off', { fromBalance: 250_000 });
    assert.equal(cfg.accounts[0].balance, 250_000);
    assert.equal(cfg.initialState.off.balance, 250_000);
    assert.equal(totalWealth(cfg) - before, 150_000, 'proceeds are created; the `loan` lever books the debt');
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

// ─── facility lever ───────────────────────────────────────────────────────────
//
// The property under test is that the three modes are wealth-matched at t0 WITHOUT
// the caller reconciling anything. That is the check the hand-written arms of design
// 86 §8.6 skipped, and it hid a A$136k head start that compounded for 44 years.

describe('facility lever', () => {
  /** Assets − liabilities at t0, in AUD, over the accounts a facility touches. */
  const netAt0 = (cfg) => totalWealth(cfg) - (cfg.initialState.hPropertyLoan?.balance ?? 0);

  test('hold, deploy and none hold the SAME t0 balance sheet', () => {
    const base = { loan: 'hPropertyLoan', size: 500_000, deployTo: 'brk' };
    const hold   = buildVariant(exportedCfg(), { facility: { off: { ...base, mode: 'hold'   } } });
    const deploy = buildVariant(exportedCfg(), { facility: { off: { ...base, mode: 'deploy' } } });
    const none   = buildVariant(exportedCfg(), { facility: { off: { ...base, mode: 'none'   } } });

    assert.equal(netAt0(hold), netAt0(deploy), 'park vs deploy');
    assert.equal(netAt0(hold), netAt0(none),   'facility vs no facility');
  });

  test('hold parks the facility in the offset and books the matching debt', () => {
    const cfg = buildVariant(exportedCfg(), {
      facility: { off: { loan: 'hPropertyLoan', size: 500_000, mode: 'hold' } },
    });
    assert.equal(cfg.accounts[0].balance, 500_000, 'offset holds the facility');
    assert.equal(cfg.initialState.hPropertyLoan.balance, 500_000);
    assert.equal(cfg.realProperties[0].mortgageBalance, 500_000, 'the record the toolset synthesizes from');
    assert.equal(cfg.accounts[1].balance, 400_000, 'the brokerage is untouched');
  });

  test('deploy moves the proceeds out and leaves the debt behind', () => {
    const cfg = buildVariant(exportedCfg(), {
      facility: { off: { loan: 'hPropertyLoan', size: 500_000, mode: 'deploy', deployTo: 'brk' } },
    });
    assert.equal(cfg.accounts[0].balance, 0);
    assert.equal(cfg.accounts[1].balance, 900_000, 'the WHOLE facility lands, not just the uplift');
    assert.equal(cfg.initialState.hPropertyLoan.balance, 500_000);
  });

  test('none discharges the loan and empties the offset, ignoring size', () => {
    const cfg = buildVariant(exportedCfg(), {
      facility: { off: { loan: 'hPropertyLoan', size: 500_000, mode: 'none' } },
    });
    assert.equal(cfg.initialState.hPropertyLoan.balance, 0);
    assert.equal(cfg.accounts[0].balance, 0);
    assert.equal(cfg.accounts[1].balance, 400_000, 'the baseline arm invests nothing extra');
  });

  test('size is an axis the placement axis cannot come apart from', () => {
    // The point of the lever: `size` and `mode` are separate dotted paths, so a grid
    // sweeps them independently and the liability still tracks the proceeds.
    for (const size of [250_000, 750_000, 1_000_000]) {
      const hold   = buildVariant(exportedCfg(), { facility: { off: { loan: 'hPropertyLoan', size, mode: 'hold' } } });
      const deploy = buildVariant(exportedCfg(), { facility: { off: { loan: 'hPropertyLoan', size, mode: 'deploy', deployTo: 'brk' } } });
      assert.equal(hold.accounts[0].balance, size);
      assert.equal(hold.initialState.hPropertyLoan.balance, size);
      assert.equal(netAt0(hold), netAt0(deploy), `wealth-matched at ${size}`);
    }
  });

  test('the offset is excluded from drawdown unless the spec says otherwise', () => {
    // `null` is the expression of "it stays in the offset" — see applyOffset. A
    // facility arm that quietly carried a priority would spend the option instead of
    // holding it.
    const dflt = buildVariant(exportedCfg(), { facility: { off: { loan: 'hPropertyLoan', size: 1, mode: 'hold' } } });
    assert.equal(dflt.accounts[0].drawdownPriority, null);
    const spent = buildVariant(exportedCfg(), {
      facility: { off: { loan: 'hPropertyLoan', size: 1, mode: 'hold', drawdownPriority: 3 } },
    });
    assert.equal(spent.accounts[0].drawdownPriority, 3);
  });

  test('the base `loan` lever still supplies rate and term; facility supplies only size', () => {
    const cfg = buildVariant(exportedCfg(), {
      loan:     { hPropertyLoan: { primeSpread: 0.045, interestOnly: true, maturityYear: 2056 } },
      facility: { off: { loan: 'hPropertyLoan', size: 800_000, mode: 'hold' } },
    });
    const loan = cfg.initialState.hPropertyLoan;
    assert.equal(loan.balance, 800_000, 'facility wins on balance');
    assert.equal(loan.primeSpread, 0.045, 'and does not clobber the rate');
    assert.equal(loan.interestOnly, true);
    assert.equal(cfg.realProperties[0].mortgageMaturityYear, 2056);
  });

  test('re-books the §988 rate at today\'s spot, so a bigger facility is not a bigger phantom gain', () => {
    // The authored loan was incurred at 1.35; the facility under study is drawn today
    // at 1.55. Keeping 1.35 would measure the repayment of dollars borrowed at 1.55
    // against a rate that never applied to them — and the error grows with the size,
    // which on a size sweep looks exactly like a real cost of borrowing more.
    const base = exportedCfg();
    base.params.push({ name: 'exchangeRateUsdToAud', value: 1.55 });
    base.parameters.exchangeRateUsdToAud = 1.55;
    base.realProperties[0].mortgageBookingFxRate = 1.35;
    base.initialState.hPropertyLoan.bookingFxRate = 1.35;

    const cfg = buildVariant(base, {
      facility: { off: { loan: 'hPropertyLoan', size: 1_000_000, mode: 'hold' } },
    });
    assert.equal(cfg.initialState.hPropertyLoan.bookingFxRate, 1.55);
    assert.equal(cfg.realProperties[0].mortgageBookingFxRate, 1.55, 'the record the toolset synthesizes from');
  });

  test('stamps BOTH §988 legs at the same rate, which is what makes them cancel', () => {
    // Design 87 §3: an offset facility is a two-legged §988 position and both legs are
    // built. They cancel exactly at every payment date — whatever FX does in between —
    // if and only if the debt's booking rate equals the deposit's acquisition rate.
    //
    // Stamping only the debt is WORSE than stamping neither: an unstamped pool takes the
    // spot of its first disposition, which for an offset is the first loan payment, and
    // an interest-only period can defer that by years. Measured on the study this was
    // written for, that left US$41k of recognized §988 on a facility that should have
    // recognized nothing — and the DEPOSIT leg was the larger of the two.
    const base = exportedCfg();
    base.params.push({ name: 'exchangeRateUsdToAud', value: 1.55 });
    base.parameters.exchangeRateUsdToAud = 1.55;
    base.realProperties[0].mortgageBookingFxRate = 1.35;
    base.initialState.hPropertyLoan.bookingFxRate = 1.35;

    const cfg = buildVariant(base, {
      facility: { off: { loan: 'hPropertyLoan', size: 500_000, mode: 'hold' } },
    });
    assert.equal(cfg.initialState.hPropertyLoan.bookingFxRate, 1.55, 'debt leg');
    assert.equal(cfg.initialState.off.fxBasisRate, 1.55, 'deposit leg');
    assert.equal(cfg.accounts[0].fxBasisRate, 1.55, 'and on the authored record too');
    assert.equal(cfg.initialState.hPropertyLoan.bookingFxRate, cfg.initialState.off.fxBasisRate,
      'the two rates must be EQUAL — that equality is the whole mechanism');
  });

  test('an explicit fxBasisRate opts the deposit leg out independently', () => {
    const base = exportedCfg();
    base.params.push({ name: 'exchangeRateUsdToAud', value: 1.55 });
    base.parameters.exchangeRateUsdToAud = 1.55;
    const cfg = buildVariant(base, {
      facility: { off: { loan: 'hPropertyLoan', size: 500_000, mode: 'hold', fxBasisRate: 1.2 } },
    });
    assert.equal(cfg.initialState.off.fxBasisRate, 1.2);
    assert.equal(cfg.initialState.hPropertyLoan.bookingFxRate, 1.55, 'the debt leg is unaffected');
  });

  test('an explicit bookingFxRate wins over the spot default', () => {
    const base = exportedCfg();
    base.params.push({ name: 'exchangeRateUsdToAud', value: 1.55 });
    base.parameters.exchangeRateUsdToAud = 1.55;
    const cfg = buildVariant(base, {
      facility: { off: { loan: 'hPropertyLoan', size: 500_000, mode: 'hold', bookingFxRate: 1.2 } },
    });
    assert.equal(cfg.initialState.hPropertyLoan.bookingFxRate, 1.2);
  });

  test('fails loud on a missing loan, an unknown mode, or a deploy with nowhere to go', () => {
    const cfg = exportedCfg();
    const set = makeSetParam(cfg);
    assert.throws(() => applyFacility(cfg, set, 'off', { size: 1 }), /needs a "loan"/);
    assert.throws(() => applyFacility(cfg, set, 'off', { loan: 'hPropertyLoan', mode: 'park' }), /hold, deploy, none/);
    assert.throws(() => applyFacility(cfg, set, 'off', { loan: 'hPropertyLoan', mode: 'deploy' }), /needs a deployTo/);
    assert.throws(() => applyFacility(cfg, set, 'off', { loan: 'hPropertyLoan', size: -1 }), /non-negative/);
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

// ─── expenseEvents lever (design 86 G8/G9) ────────────────────────────────────

describe('expenseEvents lever', () => {
  test('writes BOTH param stores', () => {
    const cfg = buildVariant(exportedCfg(), {
      expenseEvents: [{ date: '2035-06-01', amount: 250_000, currency: 'AUD', fundFrom: 'off' }],
    });
    assert.equal(cfg.parameters.expenseEvents.length, 1);
    assert.equal(cfg.params.find(p => p.name === 'expenseEvents').value.length, 1,
      'a lever that writes only one store is silently inert against the other source');
  });

  test('auto-enables EXPENSE_EVENTS without clobbering the existing strategies', () => {
    const base = exportedCfg();
    base.params.push({ name: 'spendingStrategy', value: ['EXPLICIT_BANDS', 'FIXED'] });
    base.parameters.spendingStrategy = ['EXPLICIT_BANDS', 'FIXED'];
    const cfg = buildVariant(base, {
      expenseEvents: [{ date: '2035-06-01', amount: 250_000 }],
    });
    assert.deepEqual(cfg.parameters.spendingStrategy,
      ['EXPLICIT_BANDS', 'FIXED', 'EXPENSE_EVENTS'],
      'replacing rather than appending would disable the plan\'s real spending strategy '
      + 'and change every arm, not just the one under test');
  });

  test('is idempotent — re-running does not double-enable the strategy', () => {
    const once  = buildVariant(exportedCfg(), { expenseEvents: [{ date: '2035-06-01', amount: 1 }] });
    const twice = buildVariant(once,          { expenseEvents: [{ date: '2036-06-01', amount: 2 }] });
    assert.equal(twice.parameters.spendingStrategy.filter(s => s === 'EXPENSE_EVENTS').length, 1);
    assert.equal(twice.parameters.expenseEvents.length, 2, 'events append');
  });

  test('replace: true authors the list outright', () => {
    const once = buildVariant(exportedCfg(), { expenseEvents: [{ date: '2035-06-01', amount: 1 }] });
    const cfg  = buildVariant(once, {
      expenseEvents: { replace: true, events: [{ date: '2040-06-01', amount: 9 }] },
    });
    assert.equal(cfg.parameters.expenseEvents.length, 1);
    assert.equal(cfg.parameters.expenseEvents[0].amount, 9);
  });

  test('entries are copied, so an arm cannot reach back into the caller\'s spec', () => {
    const spec = [{ date: '2035-06-01', amount: 250_000 }];
    const cfg  = buildVariant(exportedCfg(), { expenseEvents: spec });
    cfg.parameters.expenseEvents[0].amount = 1;
    assert.equal(spec[0].amount, 250_000, 'the shallow-copy trap this repo has paid for before');
  });

  test('drops entries missing a date or an amount', () => {
    const cfg = buildVariant(exportedCfg(), {
      expenseEvents: [{ date: '2035-06-01', amount: 100 }, { amount: 200 }, { date: '2036-01-01' }],
    });
    assert.equal(cfg.parameters.expenseEvents.length, 1);
  });
});
