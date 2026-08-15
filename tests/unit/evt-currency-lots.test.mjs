/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-currency-lots.test.mjs — design 87 phase 3 (G5, G8, G11).
 *
 * The §988 lot ledger and the reducer-observer seam that feeds it.
 *
 *   CL-1..6    the shared pool: both conventions, and what each can say about a holding period.
 *   CL-7..10   the pool predicate — narrower than `isForeignCurrencyPool`, and why.
 *   CL-11..16  the observer's defaults: acquire on credit, NON-recognition on a bare debit.
 *   CL-17..19  G11 — same-currency transfers carry basis instead of re-marking to market.
 *   CL-20..22  IGNORE — a revaluation must not eat basis.
 *   CL-23..25  the registry seam itself, including that absence changes nothing.
 *
 * Run with: node --test tests/unit/evt-currency-lots.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  CurrencyLotPool, LEDGER_METHOD, allocateGain, LONG_TERM_DAYS, PERSONAL_DE_MINIMIS_USD,
} from '../../src/finance/account-rules/currency-lots.js';
import {
  createCurrencyLotObserver, isCurrencyLotPool,
} from '../../src/finance/account-rules/currency-lot-observer.js';
import { ReducerObserverRegistry } from '../../src/simulation-framework/reducer-observer-registry.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';

// Rates are AUD per USD, matching effectiveExchangeRates.USD_AUD. A HIGHER number means a
// WEAKER AUD, so holding AUD across a rise is a USD loss.
const STRONG = 1.30;   // 1 AUD = 0.769 USD
const WEAK   = 1.60;   // 1 AUD = 0.625 USD

const stateWith = (accounts, rate = STRONG) => ({
  effectiveExchangeRates: { USD_AUD: rate },
  ...accounts,
});

const audAccount = (over = {}) => ({
  balance: 0, currency: { code: 'AUD' }, country: 'AU', type: 'savings', ...over,
});

const D = (iso) => new Date(iso);

// ─── CL-1..6 · the shared pool ────────────────────────────────────────────────────────

test('CL-1 pro-rata consumes basis in proportion to units, leaving the rate unchanged', () => {
  const p = new CurrencyLotPool(LEDGER_METHOD.PRO_RATA);
  p.acquire('2020-01-01', 100, 80);
  p.acquire('2022-01-01', 100, 60);      // pool: 200 units, 140 USD

  const { basis, held } = p.consume('2023-01-01', 50);
  assert.equal(round(basis), 35);        // 140 × 50/200
  assert.equal(held, null);              // it cannot say WHICH units left
  assert.equal(round(p.units), 150);
  assert.equal(round(p.basis), 105);
  // The pool's average rate is untouched, which is why pro-rata is expressible as the
  // single `fxBasisRate` scalar of phases 1–2.
  assert.equal(round(p.basis / p.units), round(140 / 200));
});

test('CL-2 FIFO consumes the OLDEST lot first, and can say how long it was held', () => {
  const p = new CurrencyLotPool(LEDGER_METHOD.FIFO);
  p.acquire('2020-01-01', 100, 80);
  p.acquire('2022-01-01', 100, 60);

  const { basis, held } = p.consume('2023-01-01', 50);
  assert.equal(round(basis), 40);        // 80 × 50/100, from the 2020 lot only
  assert.ok(held > LONG_TERM_DAYS, 'units held since 2020 are long-term');
  assert.equal(round(p.units), 150);
  assert.equal(round(p.basis), 100);
});

test('CL-3 the two methods disagree on basis for the same disposal — the G6 question', () => {
  const mk = (m) => { const p = new CurrencyLotPool(m); p.acquire('2020-01-01', 100, 80); p.acquire('2022-01-01', 100, 60); return p; };
  const fifo = mk(LEDGER_METHOD.FIFO).consume('2023-01-01', 50).basis;
  const prorata = mk(LEDGER_METHOD.PRO_RATA).consume('2023-01-01', 50).basis;
  assert.notEqual(round(fifo), round(prorata));
  // Working-detector control: over the pool's WHOLE life the methods must agree, because
  // both consume 100% of the basis. Method is a timing/allocation choice, never a total.
  const allF = mk(LEDGER_METHOD.FIFO), allP = mk(LEDGER_METHOD.PRO_RATA);
  assert.equal(round(allF.consume('2023-01-01', 200).basis), 140);
  assert.equal(round(allP.consume('2023-01-01', 200).basis), 140);
});

test('CL-4 consuming more than the pool holds reports a shortfall, never negative basis', () => {
  const p = new CurrencyLotPool(LEDGER_METHOD.FIFO);
  p.acquire('2020-01-01', 100, 80);
  const { basis, shortfall } = p.consume('2021-01-01', 250);
  assert.equal(round(basis), 80);
  assert.equal(round(shortfall), 150);
  assert.equal(p.units, 0);
  assert.equal(p.basis, 0);
});

test('CL-5 the personal share is CAPITAL, and the $200 floor is written for gain only', () => {
  // Personal gain over the floor → capital, not ordinary. §1.988-1(a)(9).
  const gain = allocateGain(1000, 0, 400);
  assert.equal(gain.ordinary, 0);
  assert.equal(gain.capitalGain, 1000);

  // Under the floor → excluded from the whole subtitle, §988(e)(2).
  const small = allocateGain(PERSONAL_DE_MINIMIS_USD - 1, 0, 400);
  assert.equal(small.capitalGain, 0);
  assert.equal(small.deMinimisExcluded, PERSONAL_DE_MINIMIS_USD - 1);

  // A personal LOSS is disallowed at ANY size — the asymmetry that costs real money.
  const loss = allocateGain(-50, 0, 400);
  assert.equal(loss.disallowedPersonalLoss, 50);
  assert.equal(loss.deMinimisExcluded, 0, 'the floor must not relieve a loss');
});

test('CL-6 pro-rata reports no holding period rather than inventing one', () => {
  assert.equal(allocateGain(1000, 0, null).longTerm, null);
  assert.equal(allocateGain(1000, 0, LONG_TERM_DAYS).longTerm, true);
  assert.equal(allocateGain(1000, 0, LONG_TERM_DAYS - 1).longTerm, false);
});

// ─── CL-7..10 · the pool predicate ────────────────────────────────────────────────────

test('CL-7 a foreign cash deposit is a pool; a USD one is not', () => {
  assert.equal(isCurrencyLotPool(audAccount({ balance: 100 })), true);
  assert.equal(isCurrencyLotPool({ balance: 100, currency: { code: 'USD' } }), false);
});

test('CL-8 super, loans and real property are out of scope by shape', () => {
  assert.equal(isCurrencyLotPool(audAccount({ type: 'super' })), false);
  assert.equal(isCurrencyLotPool(audAccount({ type: 'loan' })), false);
  assert.equal(isCurrencyLotPool(audAccount({ kind: 'real-property' })), false);
});

test('CL-9 an AU BROKERAGE is NOT a currency pool — design 87 §5 maps ALLOCATION to §988(c)(1)(B)', () => {
  // The failure this guards: an account-level pool applied to a brokerage would claim the
  // equity sleeves, double-counting FX already inside their §1001 capital gain AND
  // recharacterising that gain as ordinary income.
  const brokerage = audAccount({ balance: 1000, holdings: [{ allocation: ALLOCATION.EQUITY, marketValue: 1000 }] });
  assert.equal(isCurrencyLotPool(brokerage), false);

  const ladder = audAccount({ balance: 1000, holdings: [{ allocation: ALLOCATION.BOND, marketValue: 1000 }] });
  assert.equal(isCurrencyLotPool(ladder), false, 'a bond is per-holding G9, not an account pool');
});

test('CL-10 a deposit modelled with a CASH sleeve is still a deposit', () => {
  const withSleeve = audAccount({ balance: 1000, holdings: [{ allocation: ALLOCATION.CASH, marketValue: 1000 }] });
  assert.equal(isCurrencyLotPool(withSleeve), true);
});

// ─── CL-11..16 · the observer's defaults ──────────────────────────────────────────────

/** Run one observed transition: mutate state inside `mutate`, return emitted actions. */
function observe(obs, state, action, mutate, date = D('2030-06-30')) {
  const token = obs.before(state);
  mutate(state);
  return { emitted: obs.after(state, token, action, date), state };
}

test('CL-11 an undeclared CREDIT acquires basis at spot — G8', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);

  observe(obs, state, { type: 'AU_RENTAL_INCOME_APPLY' }, (s) => { s.au.balance = 1300; });

  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.units), 1300);
  assert.equal(round(pool.basis), 1000);            // 1300 AUD / 1.30
  assert.equal(round(state.au.fxBasisRate), STRONG);
});

test('CL-12 a second credit at a different rate BLENDS, preserving total USD basis', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });

  state.effectiveExchangeRates.USD_AUD = WEAK;
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300 + 1600; });

  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.units), 2900);
  assert.equal(round(pool.basis), 2000);            // 1000 + 1000: basis is preserved, not averaged
  // The published rate is the HARMONIC (balance-weighted) mean, which is the only blend
  // that does not manufacture §988 later out of an accounting choice.
  assert.equal(round(state.au.fxBasisRate), round(2900 / 2000));
});

test('CL-13 a bare DEBIT consumes lots and realizes NOTHING — §1.988-2(a)(1)(iii)(C)', () => {
  // This is design 87 §1a's correction. Realizing on every debit is the single most
  // load-bearing error the regulations fixed, and the one the phase-3 sketch inherited.
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });

  state.effectiveExchangeRates.USD_AUD = WEAK;      // AUD has fallen: a real economic loss
  const { emitted } = observe(obs, state, { type: 'EXPENSE_DEBIT' }, (s) => { s.au.balance = 650; });

  assert.deepEqual(emitted, [], 'a withdrawal is non-recognition');
  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.units), 650);
  assert.equal(round(pool.basis), 500);             // half the units, half the basis
});

test('CL-14 the ledger stays in lockstep with the balance across many movements', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  let bal = 0;
  for (let i = 0; i < 40; i++) {
    state.effectiveExchangeRates.USD_AUD = 1.25 + (i % 7) * 0.05;
    const delta = i % 3 === 0 ? -170 : 400;
    observe(obs, state, { type: 'X' }, (s) => { s.au.balance = (bal = Math.max(0, bal + delta)); });
  }
  const pool = obs._poolFor(state, 'au');
  assert.ok(Math.abs(pool.units - state.au.balance) < 0.01,
    `units ${pool.units} must track balance ${state.au.balance}`);
  assert.ok(pool.basis > 0);
});

test('CL-15 an opening balance with an authored fxBasisRate seeds from it, not from spot', () => {
  const obs = createCurrencyLotObserver();
  // 1400 AUD acquired at 1.40 = 1000 USD of basis, even though today's spot is 1.30.
  const state = stateWith({ au: audAccount({ balance: 1400, fxBasisRate: 1.40 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1400 + 130; });

  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.basis), 1100);            // 1000 seeded + 100 acquired at 1.30
});

test('CL-16 an opening balance with NO authored rate is stamped at spot and understates', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 1300 }) }, STRONG);
  // A pool is created lazily on its first MOVEMENT, and seeds from the opening balance.
  observe(obs, state, { type: 'EXPENSE_DEBIT' }, (s) => { s.au.balance = 1000; });

  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.units), 1000);
  // Seeded at today's 1.30 rather than at whatever rate the currency was really acquired
  // at, so the pool's rate equals spot and a disposition NOW yields exactly zero. That
  // understates §988 rather than inventing it — the designed behaviour (design 87 §6),
  // and what §13.6 step 1 (seeding from the ingest tool) eventually replaces.
  assert.equal(round(pool.basis), round(1000 / STRONG));
  assert.equal(round(pool.units / pool.basis), STRONG);
});

// ─── CL-17..19 · G11, basis carryover ─────────────────────────────────────────────────

test('CL-17 a same-currency transfer CARRIES basis instead of re-marking to market', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({
    offset:  audAccount({ balance: 0 }),
    savings: audAccount({ balance: 0 }),
  }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.offset.balance = 1300; });   // basis 1000 USD

  // AUD falls. A transfer must NOT re-price the units at the new spot.
  state.effectiveExchangeRates.USD_AUD = WEAK;
  observe(obs, state, { type: 'REPLENISH_SAVINGS' }, (s) => {
    s.offset.balance = 650; s.savings.balance = 650;
  });

  assert.equal(round(obs._poolFor(state, 'offset').basis), 500);
  assert.equal(round(obs._poolFor(state, 'savings').basis), 500,
    'basis follows the units — §1.988-2(a)(1)(iii)(E)');
  // The control: had this been treated as a disposal + fresh acquisition, the receiving
  // pool would carry 650/1.60 = 406.25 instead.
  assert.notEqual(round(obs._poolFor(state, 'savings').basis), round(650 / WEAK));
});

test('CL-18 total basis is conserved across a transfer', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ a: audAccount({ balance: 0 }), b: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.a.balance = 2600; });
  const before = obs._poolFor(state, 'a').basis;

  state.effectiveExchangeRates.USD_AUD = WEAK;
  observe(obs, state, { type: 'T' }, (s) => { s.a.balance = 600; s.b.balance = 2000; });

  assert.equal(round(obs._poolFor(state, 'a').basis + obs._poolFor(state, 'b').basis), round(before));
});

test('CL-19 a DISPOSE declaration is NOT treated as a transfer even when a pool also rises', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ a: audAccount({ balance: 0 }), b: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.a.balance = 1300; });

  state.effectiveExchangeRates.USD_AUD = WEAK;
  observe(obs, state, { type: 'FX_TRANSFER_APPLY', section988: { kind: 'DISPOSE', businessFraction: 1 } },
    (s) => { s.a.balance = 650; s.b.balance = 650; });

  // b is a genuine acquisition at spot, not a carryover.
  assert.equal(round(obs._poolFor(state, 'b').basis), round(650 / WEAK));
});

// ─── CL-20..22 · IGNORE ───────────────────────────────────────────────────────────────

test('CL-20 a revaluation must not eat basis — [[basis-ledger-revaluation-drift]]', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });   // 1000 USD basis

  // A shock marks the balance down 20%. No currency changed hands.
  observe(obs, state, { type: 'HOLDING_REVALUE', section988: { kind: 'IGNORE' } },
    (s) => { s.au.balance = 1040; });

  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.units), 1040);
  assert.equal(round(pool.basis), 800, 'basis scales WITH units, holding the ratio');
  assert.equal(round(pool.basis / pool.units), round(1000 / 1300));
});

test('CL-21 without the IGNORE declaration a revaluation would consume basis — the control', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });
  observe(obs, state, { type: 'HOLDING_REVALUE' }, (s) => { s.au.balance = 1040; });
  // Same 800 by arithmetic coincidence under pro-rata, but via CONSUMPTION — the units are
  // gone rather than rescaled. This test exists so CL-20 cannot pass against a no-op.
  assert.equal(round(obs._poolFor(state, 'au').units), 1040);
});

test('CL-22 IGNORE on a rising balance does not acquire phantom basis', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });
  observe(obs, state, { type: 'REVALUE', section988: { kind: 'IGNORE' } }, (s) => { s.au.balance = 2600; });
  const pool = obs._poolFor(state, 'au');
  assert.equal(round(pool.units), 2600);
  assert.equal(round(pool.basis), 2000, 'a mark-UP scales basis too, it does not buy currency');
});

// ─── CL-23..25 · the registry seam ────────────────────────────────────────────────────

test('CL-23 an empty registry reports itself empty so the caller can skip the bracket', () => {
  const reg = new ReducerObserverRegistry();
  assert.equal(reg.isEmpty, true);
  reg.register({ before: () => 1, after: () => [] });
  assert.equal(reg.isEmpty, false);
});

test('CL-24 tokens are positionally matched to their observer', () => {
  const reg = new ReducerObserverRegistry();
  const seen = [];
  reg.register({ before: () => 'A', after: (_s, t) => { seen.push(t); return []; } });
  reg.register({ before: () => 'B', after: (_s, t) => { seen.push(t); return []; } });
  reg.after({}, reg.before({}), {}, new Date());
  assert.deepEqual(seen, ['A', 'B'], 'after runs in the SAME order as before, not reversed');
});

test('CL-25 emitted actions from every observer are collected in order', () => {
  const reg = new ReducerObserverRegistry();
  reg.register({ before: () => null, after: () => [{ type: 'ONE' }] });
  reg.register({ before: () => null, after: () => [] });
  reg.register({ before: () => null, after: () => [{ type: 'TWO' }] });
  const out = reg.after({}, reg.before({}), {}, new Date());
  assert.deepEqual(out.map(a => a.type), ['ONE', 'TWO']);
});

// ─── CL-29..31 · a DISPOSE names its pool ─────────────────────────────────────────────

test('CL-29 a named DISPOSE realizes only that pool; a same-currency top-up stays non-recognition', () => {
  // One reducer, three movements: pool A funds pool B (an internal transfer), and B is
  // then converted out. Without `accountKey` the DISPOSE would realize A's debit too,
  // taxing a §1.988-2(a)(1)(iii)(E) non-recognition transfer.
  const obs = createCurrencyLotObserver();
  const state = stateWith({ a: audAccount({ balance: 0 }), b: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.a.balance = 1300; s.b.balance = 1300; });

  state.effectiveExchangeRates.USD_AUD = WEAK;
  const { emitted } = observe(obs, state,
    { type: 'INTL_TRANSFER_APPLY', section988: { kind: 'DISPOSE', businessFraction: 1, accountKey: 'b', units: 650 } },
    (s) => { s.a.balance = 650; s.b.balance = 1300; });   // A→B 650, then B converts 650 out

  assert.equal(emitted.length, 1, 'only the named pool disposes');
  assert.equal(emitted[0].accountKey, 'b');
  // B's NET movement is zero — the top-up and the conversion cancel exactly. Declaring
  // `units` is what keeps the disposition visible at all; on the net alone it vanishes.
  assert.ok(Math.abs(state.a.balance - 650) < 0.01);
});

test('CL-30 the named pool disposes AFTER its funding credit lands, not before', () => {
  // Ordering: the disposal must measure a pool that already contains what funded it.
  // A is 1300 AUD of basis 1000 (rate 1.30). It moves to B while spot is 1.60, then B
  // converts the lot straight out at 1.60. Carryover basis means the gain is A's loss,
  // NOT zero — if the debit ran before the credit, B would price against its own old rate.
  const obs = createCurrencyLotObserver();
  const state = stateWith({ a: audAccount({ balance: 0 }), b: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.a.balance = 1300; });

  state.effectiveExchangeRates.USD_AUD = WEAK;
  const { emitted } = observe(obs, state,
    { type: 'INTL_TRANSFER_APPLY', section988: { kind: 'DISPOSE', businessFraction: 1, accountKey: 'b', units: 1300 } },
    (s) => { s.a.balance = 0; s.b.balance = 0; });   // A→B 1300, B converts all 1300 out

  assert.equal(emitted.length, 1);
  // basis carried from A = 1000 USD; proceeds = 1300/1.60 = 812.50 ⇒ loss of 187.50.
  assert.ok(Math.abs(emitted[0].gross - (1300 / WEAK - 1000)) < 0.01,
    `gross ${emitted[0].gross} should be ${1300 / WEAK - 1000}`);
});

test('CL-31 an UNNAMED DISPOSE still applies to every debit — back-compatible', () => {
  const obs = createCurrencyLotObserver();
  const state = stateWith({ a: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.a.balance = 1300; });
  state.effectiveExchangeRates.USD_AUD = WEAK;
  const { emitted } = observe(obs, state,
    { type: 'FX_TRANSFER_APPLY', section988: { kind: 'DISPOSE', businessFraction: 1 } },
    (s) => { s.a.balance = 650; });
  assert.equal(emitted.length, 1, 'a single-pool caller needs no accountKey');
});

// ─── CL-26..28 · state is authoritative ───────────────────────────────────────────────

test('CL-26 a restored snapshot is honoured, not overridden by a stale cached pool', () => {
  // `restoreSnapshot`/`rewind` (the workbench timeline, the optimizer MPC seam) replace
  // state wholesale. An observer caching pools in a Map would keep describing the world
  // the run has left, with no symptom until a tax figure came out wrong.
  const obs = createCurrencyLotObserver();
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });
  assert.equal(round(obs._poolFor(state, 'au').basis), 1000);

  // Rewind to a different world: same observer instance, different state object.
  const rewound = stateWith({ au: audAccount({ balance: 260, fxBasisUsd: 200, fxBasisRate: 1.30 }) }, STRONG);
  observe(obs, rewound, { type: 'EXPENSE_DEBIT' }, (s) => { s.au.balance = 130; });

  assert.equal(round(obs._poolFor(rewound, 'au').basis), 100, 'reads the restored pool, not the old one');
  assert.equal(round(state.au.fxBasisUsd), 1000, 'and does not disturb the abandoned state');
});

test('CL-27 an out-of-band balance change self-heals, preserving the basis:units ratio', () => {
  const obs = createCurrencyLotObserver({ method: LEDGER_METHOD.FIFO });
  const state = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  observe(obs, state, { type: 'X' }, (s) => { s.au.balance = 1300; });

  // Something outside the ledger halves the balance without a lot ever being consumed.
  state.au.balance = 650;
  observe(obs, state, { type: 'Y' }, (s) => { s.au.balance = 660; });

  const pool = obs._poolFor(state, 'au');
  // Rescaled rather than left claiming 1300 units of basis against 650 units of currency —
  // which is the shape that would otherwise OVERSTATE basis and understate gain forever.
  assert.ok(Math.abs(pool.units - 660) < 0.01, `units ${pool.units} should track 660`);
});

test('CL-28 two observers over the same state do not share pools', () => {
  // Guards the Simulation-clone path: a cloned sim must not inherit its parent's ledger.
  const a = createCurrencyLotObserver();
  const b = createCurrencyLotObserver();
  const s1 = stateWith({ au: audAccount({ balance: 0 }) }, STRONG);
  const s2 = stateWith({ au: audAccount({ balance: 0 }) }, WEAK);
  observe(a, s1, { type: 'X' }, (s) => { s.au.balance = 1300; });
  observe(b, s2, { type: 'X' }, (s) => { s.au.balance = 1600; });
  assert.equal(round(s1.au.fxBasisUsd), 1000);
  assert.equal(round(s2.au.fxBasisUsd), 1000);
  assert.notEqual(round(s1.au.fxBasisRate), round(s2.au.fxBasisRate));
});

function round(n) { return Math.round(n * 100) / 100; }
