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
 * probe-bucket-cover.mjs — the three-pool ("bucket") cover schedule, year by year.
 *
 * The question this exists for: a retiree wants N years of spending held OUTSIDE
 * equity so a bad decade never forces a sale at the bottom. That is a claim about a
 * SCHEDULE — "at every point in the plan, the non-equity pools cover N years" — and
 * nothing in the app reports it. A terminal net worth cannot answer it and neither
 * can a solvency rate: a plan can pass both while spending twenty years with its
 * medium-term pool empty.
 *
 * So this prints, for each year, the pools and the cover they buy:
 *
 *   SHORT   CASH sleeves in ordinary accessible accounts (savings, checking, and the
 *           cash sitting inside a taxable brokerage). Spendable today, no tax event.
 *   MEDIUM  BOND sleeves in those same accounts, PLUS the drawable balance of any
 *           offset account. Both are "sell nothing, realise nothing" sources; an
 *           offset draw is not a disposal in either jurisdiction.
 *   LONG    EQUITY (and GOLD) in accessible accounts — the pool the buckets exist to
 *           avoid selling.
 *   WRAPPED everything in a retirement wrapper (ira/401k/roth/super). Reported
 *           SEPARATELY and never counted as cover: preservation age and the 59½ rule
 *           mean this money is not available to the early-retirement years that the
 *           bucket strategy is about, which is exactly the window in question.
 *
 * ─── why the OFFSET column is the interesting one ────────────────────────────
 *
 * An offset looks like an ideal medium-term pool: it "earns" the loan rate, tax-free,
 * with no disposal on the way out. It has one property that no other pool has, and it
 * is not visible on a balance sheet: **it drains itself.** An offset is the loan's
 * default payment source (`resolveLoanCashKey`), so every P&I payment is debited from
 * it. Under a full offset the interest is zero, so the entire payment is principal,
 * and offset and debt fall in lockstep. Net worth never moves — and the drawable
 * balance runs to zero on a schedule nobody authored.
 *
 * That makes "how many years of spending does the offset cover" a DECLINING series,
 * and it declines fastest in the early-retirement years the strategy cares most
 * about. Reading it off a balance sheet is impossible; that is what this prints.
 *
 * The `--pay-source` arm is the lever that stops it. Point the loan's payment source
 * at an ordinary cash account and the cover stops decaying (the payments then come
 * out of SHORT instead, which is a real cost, and shows up in the same table).
 * `--pay-source` rides on `mortgagePaymentSourceKey`, which is now plumbed through
 * the property record (`synthesizeLoanForProperty` had silently dropped the field, so
 * this arm was byte-identical to the base until that was fixed — see
 * tests/unit/evt-mortgage-payment-source.test.mjs).
 *
 * `--io-until <year>` is the other, and cheaper, way to preserve the pool: see below.
 *
 * Everything is stated in USD, converted at the run's OWN `USD_AUD` for that year,
 * because the pools straddle two currencies and a raw sum of AUD and USD balances is
 * denominated in nothing.
 *
 * Deliberately deterministic: FX pinned, no dated shock, one path. A cover schedule
 * under no draw is arithmetic. Any wobble here is a rig fault, not a finding — and a
 * dated crash held fixed would bias every timing read (see the offset studies).
 *
 * Usage:
 *   node scripts/probes/probe-bucket-cover.mjs --scenario scenarios/fin-sim-scenarios.json
 *   node scripts/probes/probe-bucket-cover.mjs --scenario ... --years 5 --from 2027 --to 2050
 *   node scripts/probes/probe-bucket-cover.mjs --scenario ... --pay-source auSavingsAccount
 *   node scripts/probes/probe-bucket-cover.mjs --scenario ... --keep-shocks --no-pin-fx
 */

import { openSim, quiet } from '../lib/run.mjs';
import { buildVariant }    from '../lib/variant.mjs';
import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';

// Roles/types whose money is behind an age gate. Counted, never called cover.
const WRAPPER_TYPES = new Set(['ira', '401k', 'k401', 'roth', 'super']);
const EQUITYISH     = new Set(['EQUITY', 'GOLD']);

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has  = (n) => argv.includes(n);

const TARGET   = Number(flag('--years', 5));
const FROM     = Number(flag('--from', 2027));
const TO       = Number(flag('--to',   2050));
const PAY_SRC  = flag('--pay-source', null);
const IO_UNTIL = flag('--io-until', null) && Number(flag('--io-until'));
const LOAN_KEY = flag('--loan', 'auHousePropertyLoan');
const PIN_FX   = !has('--no-pin-fx');
const KEEP_SHK = has('--keep-shocks');

const source = parseSourceArgs(argv);
const { cfg: base, ...meta } = loadBaseConfig(source);

let cfg = structuredClone(base);
setParam(cfg, 'fxProcessModel', PIN_FX ? 'NONE' : undefined);
if (!KEEP_SHK) setParam(cfg, 'shocks', []);

// The lever that changes the SHAPE of the answer rather than the level. A P&I loan
// amortises, and the offset's capacity is capped at the loan balance (only the
// offset dollars standing against outstanding debt suppress any interest), so a P&I
// loan's offset is a pool with a published expiry date. Interest-only freezes the
// balance, and under a full offset the interest — and therefore the whole payment —
// is zero, so the pool neither drains nor costs anything to hold.
if (IO_UNTIL) {
  cfg = buildVariant(cfg, { loan: { [LOAN_KEY]: {
    interestOnly: true, interestOnlyUntilYear: IO_UNTIL, monthlyPayment: 0,
  } } });
}
if (PAY_SRC) cfg = buildVariant(cfg, { loan: { [LOAN_KEY]: { paymentSourceKey: PAY_SRC } } });

/**
 * Write a param.
 *
 * There are two param stores and only one of them is a list: a workbench export
 * carries `cfg.params` as a LIST of {key,value} records, while the synthetic default
 * may carry none at all. Creating a BAG when it is absent is the trap — ScenarioLoader
 * does `(cfg?.params ?? []).find(...)`, so an object there is not caught by the `??`
 * and blows up on `.find`. Always leave a list behind.
 */
function setParam(c, key, value) {
  if (value === undefined) return;
  if (!Array.isArray(c.params)) {
    const bag = (c.params && typeof c.params === 'object') ? c.params : {};
    c.params = Object.entries(bag).map(([k, v]) => ({ key: k, value: v }));
  }
  const row = c.params.find(r => (r.key ?? r.name) === key);
  if (row) row.value = value; else c.params.push({ key, value });
}

// ─── the cut ────────────────────────────────────────────────────────────────

/**
 * Reduce one state snapshot to the four pools, in USD.
 *
 * Sleeve-level, not account-level: a taxable brokerage holding equity, bonds and cash
 * contributes to three different pools, and an account-level cut would put all of it
 * in whichever pool the account's role suggests. That is the whole reason the
 * allocation is authoritative and the role is not.
 */
function pools(state) {
  const usdAud = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
  const toUsd  = (v, ccy) => (ccy === 'AUD' ? v / usdAud : v);
  const out = { short: 0, medium: 0, long: 0, wrapped: 0, offset: 0, loan: 0 };

  for (const [, a] of Object.entries(state)) {
    if (!a || typeof a !== 'object' || !('balance' in a) || a.kind === undefined && !a.type) continue;
    const ccy = a.currency?.code ?? 'USD';
    if (a.type === 'loan') { out.loan += toUsd(Math.max(0, a.balance ?? 0), ccy); continue; }

    if (a.type === 'offset') {
      // The whole balance is drawable and no part of it is a disposal, so it is
      // MEDIUM by character — but it is tracked separately because it is the only
      // pool that shrinks without anyone spending it.
      const v = toUsd(Math.max(0, a.balance ?? 0), ccy);
      out.offset += v; out.medium += v;
      continue;
    }
    const wrapped = WRAPPER_TYPES.has(a.type) || WRAPPER_TYPES.has(a.role);
    for (const h of a.holdings ?? []) {
      const v = toUsd(h.marketValue ?? 0, ccy);
      if (wrapped) { out.wrapped += v; continue; }
      if (h.allocation === 'CASH')      out.short  += v;
      else if (h.allocation === 'BOND') out.medium += v;
      else if (EQUITYISH.has(h.allocation)) out.long += v;
      else out.long += v;                       // unknown sleeve: the conservative side
    }
  }
  return out;
}

// ─── run ────────────────────────────────────────────────────────────────────

const sim = openSim(cfg, { telemetry: 'off' });
const rows = [];
for (let y = FROM; y <= TO; y++) {
  quiet(() => sim.stepTo(new Date(`${y}-01-31`)));
  const s = sim.state;
  const p = pools(s);
  // The spend the pools have to cover. `state.monthlyExpenses` is the live, inflated,
  // age-banded line the sim is actually debiting — not the authored param.
  const annual = (s.monthlyExpenses ?? 0) * 12;
  rows.push({ year: y, annual, ...p, failed: !!s.scenarioFailed });
}

const m  = n => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n / 1000)).toLocaleString()}k`;
const yr = n => (n >= 99 ? ' 99+' : n.toFixed(1).padStart(4));

console.log(`\nBUCKET COVER SCHEDULE  —  ${describeSource({ cfg: base, ...meta })}`);
console.log(`target = ${TARGET} years of spending outside equity`
  + `   ·   FX ${PIN_FX ? 'pinned' : 'stochastic'}`
  + `   ·   shocks ${KEEP_SHK ? 'as authored' : 'removed'}`
  + `   ·   pay source ${PAY_SRC ?? '(default — the offset)'}`
  + (IO_UNTIL ? `   ·   ${LOAN_KEY} interest-only to ${IO_UNTIL}` : '') + '\n');
console.log('              spend │   SHORT    MEDIUM  (of which │    LONG   WRAPPED │  cover  offset  short');
console.log('year        (a year)│   (cash)  (bonds+   offset) │ (equity)  (age-   │ (yrs) │ (yrs) │ (yrs)');
console.log('                    │            offset)          │           gated)  │       │       │');
console.log('─────┼──────────────┼─────────┼─────────┼─────────┼─────────┼─────────┼───────┼───────┼──────');
for (const r of rows) {
  const cover  = r.annual > 0 ? (r.short + r.medium) / r.annual : 0;
  const offYrs = r.annual > 0 ? r.offset / r.annual : 0;
  const shYrs  = r.annual > 0 ? r.short  / r.annual : 0;
  const mark   = cover < TARGET ? ' ◄ under' : '';
  console.log(`${r.year} │ ${m(r.annual).padStart(12)} │ ${m(r.short).padStart(7)} │ ${m(r.medium).padStart(7)} │`
    + ` ${m(r.offset).padStart(7)} │ ${m(r.long).padStart(7)} │ ${m(r.wrapped).padStart(7)} │`
    + ` ${yr(cover)} │ ${yr(offYrs)} │ ${yr(shYrs)}${mark}`);
}

// The offset's own maturity: the year its cover falls through the target, and the
// year it is gone. Both are dates, and neither appears on a balance sheet.
const firstUnder = rows.find(r => r.offset / r.annual < TARGET && r.offset >= 0);
const gone       = rows.find(r => r.offset < 1000);
console.log(`\noffset as the ${TARGET}-year pool: `
  + (rows[0].offset / rows[0].annual >= TARGET
      ? `covers ${TARGET} years at ${rows[0].year}, `
        + `falls below it in ${firstUnder ? firstUnder.year : 'never (in range)'}`
      : `NEVER covers ${TARGET} years — starts at ${(rows[0].offset / rows[0].annual).toFixed(1)} years`)
  + `; drawable reaches zero ${gone ? `in ${gone.year}` : 'after the window'}.`);

// The invariant that says the offset really is paying the loan and not the portfolio:
// a fully offset loan is a balance-sheet no-op, so (offset − debt) must be pinned.
const gap0 = rows[0].offset - rows[0].loan, gapN = rows.at(-1).offset - rows.at(-1).loan;
console.log(`(offset − all debt) ${m(gap0)} → ${m(gapN)}   `
  + `— the AU pair drains in lockstep; movement here is other loans, not a leak.\n`);
