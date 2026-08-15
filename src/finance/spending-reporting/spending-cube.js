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
 * The spending cube — design 89 §11 phase 2: journal → classified rows, in one currency.
 *
 * One row per (debit × category share), carrying enough to pivot on any axis phase 3
 * wants — year, category, tier, account — without going back to the journal. The
 * grouping itself deliberately lives elsewhere (§11: the pivot lives in `src/`, and the
 * page ships precomputed series so the lab page and the panel cannot disagree about a
 * share).
 *
 * ─── what it reuses, and the one place it cannot ─────────────────────────────
 *
 * The rate history is `JournalFxRates` (design 91 §8) via `api.fxRates()`, so every row
 * converts at the run's own recorded USD/AUD rate on the row's own date — the same
 * per-row conversion the shipped reports do, not §9.1's obsolete year-boundary proposal.
 *
 * What it cannot reuse is the shipped account SCOPE, and that is a finding rather than a
 * shortcut. §7(a) requires classification to be total against **every** negative balance
 * delta in the journal, but `_appendAccountBalanceScope` narrows to
 * `api.accountBalanceKeys()` — and §3.1 measured that the loan accounts are not in it.
 * Scoping to it would make the cube's own totality invariant vacuous over exactly the
 * legs §4 is about. So the cube's domain is the raw universe and the registered set is
 * reported as `coverage`, an annotation rather than a filter.
 *
 * ─── the two units traps ─────────────────────────────────────────────────────
 *
 * 1. **The loan balances declare `kind: 'currency'` with a null `currencyCode`.**
 *    Measured on the reference plan: `usHousePropertyLoan.balance` and its AU sibling
 *    both resolve that way. `normalizeAggregateCurrency` treats an undeclared unit as
 *    already-in-target and says so, which for the AUD loan would understate the
 *    principal by the exchange rate. So the cube resolves the schema FIRST and falls
 *    back to the account's own `currency.code` in state, which is authoritative for an
 *    account's denomination.
 * 2. **`amount` on the action is not what moved.** `EXPENSE_DEBIT` is journaled once per
 *    consuming reducer and only the first moves money — §10's 3.0000x trap. The cube
 *    reads `stateDelta`, so the fan-out is counted once by construction rather than
 *    divided out by a constant a fourth reducer would silently break.
 *
 * ─── real terms, and intent ──────────────────────────────────────────────────
 *
 * Every row carries `amountReal` alongside `amount`: the same money deflated by
 * `JournalPriceLevels` at the row's own date, in ONE denominator
 * (`inflationAccumulator.US`, after converting to USD). §9.b.1 decided that
 * deliberately — deflating each debit by the residence-at-the-time level is truer to
 * purchasing power but changes the denominator mid-chart, so a move year would draw a
 * step that is an artefact of the axis rather than of the plan.
 *
 * `intent` is the other half of §5. `ExpenseDebitReducer` caps the debit at the
 * available balance, so a failing plan draws as "spent less" rather than "went short" —
 * the realized bands alone tell the opposite of the story. The action carries what the
 * strategy ASKED for (`amount`) beside what it got (`realizedAmount` === the delta), so
 * the gap is readable per row rather than reconstructed. It exists only where a debit
 * can be capped: taxes escalate rather than shrink, and a transfer moves what it moves.
 */

import { JournalDataSource }    from '../journal-data-source.js';
import { JournalQueryApi }      from '../journal-query-api.js';
import { JournalPriceLevels }   from '../journal-reporting/journal-price-levels.js';
import { classifyDebit, REPORT_CATEGORY, CATEGORY_TIER, SPEND_TIER } from './spending-classification.js';

/**
 * The `<key>.balance` paths of accounts whose balance is a LIABILITY (design 54): a
 * positive number that counts negative in net worth, and whose *decrease* is a
 * repayment rather than an outlay.
 *
 * Read off the live state's `type` rather than from a registry, because §3.1's whole
 * point is that these accounts are the ones the registry does not carry.
 *
 * @param {object} state
 * @returns {Set<string>}
 */
export function loanBalanceKeys(state) {
  const keys = new Set();
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value && typeof value === 'object' && value.type === 'loan') keys.add(`${key}.balance`);
  }
  return keys;
}

/**
 * Build the cube.
 *
 * @param {object} opts
 * @param {import('../../simulation-framework/journal.js').Journal} opts.journal
 * @param {object}  [opts.state]           final sim state — supplies loan identity and the
 *                                         currency fallback. Omitting it is allowed and
 *                                         degrades VISIBLY: sale payoffs land in
 *                                         `UNCLASSIFIED` rather than being mistaken for spending.
 * @param {object}  [opts.services]        ServiceRegistry (or a stand-in) for the schema registry
 * @param {string}  [opts.currency='USD']  the one unit every `amount` is stated in
 * @param {string}  [opts.priceLevelCc='US'] the ONE deflator every `amountReal` uses (§9.b.1)
 * @returns {{rows: object[], byCategory: Map<string, number>, byTier: Map<string, number>,
 *            total: number, totalReal: number, rawTotal: number, unconverted: number,
 *            undeflated: number, terminalPriceLevel: number|null, coverage: object}}
 */
export function buildSpendingCube({ journal, state = null, services = null,
                                    currency = 'USD', priceLevelCc = 'US' } = {}) {
  const schemaRegistry = services?.schemaRegistry ?? null;
  const api  = new JournalQueryApi(
    new JournalDataSource(journal, { perDiff: true }),
    services?.typeRegistry ?? null, services?.periodService ?? null, schemaRegistry,
  );
  const fx       = api.fxRates();
  const loanKeys = loanBalanceKeys(state);
  // One denominator for the whole cube (§9.b.1). The live accumulator is the fallback for
  // a run that never diffed one — inflation switched off, where the level is a flat 1.
  const prices = new JournalPriceLevels(journal, {
    fallbackLevel: cc => state?.inflationAccumulator?.[cc] ?? null,
  });

  const registered = new Set(api.accountBalanceKeys() ?? []);
  const outOfScope = new Map();   // stateKey → converted amount the shipped reports cannot see

  const rows        = [];
  const byCategory  = new Map();
  const byTier      = new Map();
  let total = 0, totalReal = 0, rawTotal = 0, unconverted = 0, undeflated = 0;

  for (const entry of journal?.journal ?? []) {
    const actionType = entry.action?.type ?? null;
    const data       = entry.action?.data ?? null;
    const ts         = (entry.date instanceof Date ? entry.date : new Date(entry.date)).getTime();

    for (const diff of entry.stateDiff ?? []) {
      const stateKey = diff.field ?? '';
      if (!stateKey.endsWith('.balance')) continue;
      const delta = diff.delta ?? 0;
      if (!(delta < 0)) continue;

      const local = -delta;
      rawTotal += local;

      const code = _currencyOf(stateKey, schemaRegistry, state);
      // A row whose unit cannot be established is carried at face value and COUNTED, so
      // it still satisfies §7(a) and shows up in `unconverted` — the alternative is a
      // row that silently leaves the total and takes its category with it.
      const converted = code ? fx.convert(local, code, currency, ts) : null;
      if (converted == null) unconverted += local;
      const amount = converted ?? local;

      if (!registered.has(stateKey)) outOfScope.set(stateKey, (outOfScope.get(stateKey) ?? 0) + amount);

      // Same treatment as the currency: a row with no known level is carried at its
      // nominal value and DISCLOSED, never dropped — §7(a) has to keep holding on the
      // real axis too, or the two views of one chart stop being the same run.
      const deflated = prices.toReal(amount, ts, priceLevelCc);
      if (deflated == null) undeflated += amount;
      const real = deflated ?? amount;

      // §5's intent line. Present only where a debit can be capped below what was asked
      // for — `ExpenseDebitReducer` is the one that caps — so it is null elsewhere rather
      // than silently equal to the realized amount, which would draw a flat line implying
      // the plan always got what it wanted.
      const intentLocal = actionType === 'EXPENSE_DEBIT' && typeof data?.amount === 'number'
        ? data.amount : null;
      const intentRatio = intentLocal != null && local > 0 ? intentLocal / local : null;

      for (const share of classifyDebit({ actionType, stateKey, data, loanKeys })) {
        const value = amount * share.fraction;
        rows.push({
          ts,
          date:       entry.date,
          year:       new Date(ts).getUTCFullYear(),
          actionType,
          stateKey,
          currency:   code ?? null,
          amountLocal: local * share.fraction,
          amount:     value,
          amountReal: real * share.fraction,
          // Scaled by the same ratio as the realized share, so intent and realized are
          // comparable band-for-band rather than only in total.
          intent:     intentRatio == null ? null : value * intentRatio,
          intentReal: intentRatio == null ? null : real  * share.fraction * intentRatio,
          category:   share.category,
          tier:       share.tier,
          instanceId: entry.action?.instanceId ?? null,
        });
        total     += value;
        totalReal += real * share.fraction;
        byCategory.set(share.category, (byCategory.get(share.category) ?? 0) + value);
        byTier.set(share.tier, (byTier.get(share.tier) ?? 0) + value);
      }
    }
  }

  return {
    rows, byCategory, byTier, total, totalReal, rawTotal, unconverted, undeflated, currency,
    priceLevelCc,
    terminalPriceLevel: prices.terminalLevel(priceLevelCc),
    coverage: {
      registeredKeys: registered.size,
      outOfScope:     [...outOfScope].map(([stateKey, amount]) => ({ stateKey, amount }))
        .sort((a, b) => b.amount - a.amount),
    },
  };
}

/**
 * §7(a) — classification is TOTAL.
 *
 *     Σ (every category) === Σ (every negative balance delta)
 *
 * Every debit lands in exactly one bucket, or in several whose fractions sum to one.
 * Checked in the CUBE's own currency on both sides, so this tests the classification
 * rather than the conversion — a rate that moved would otherwise fail this instead of
 * failing the report it belongs to.
 *
 * @param {ReturnType<typeof buildSpendingCube>} cube
 * @param {number} [tolerance=1e-6] relative
 * @returns {{ok: boolean, total: number, sum: number, drift: number, unclassified: number}}
 */
export function checkClassificationTotal(cube, tolerance = 1e-6) {
  let sum = 0;
  for (const value of cube.byCategory.values()) sum += value;
  const drift = Math.abs(sum - cube.total);
  return {
    ok:           cube.total === 0 ? drift === 0 : drift / Math.abs(cube.total) <= tolerance,
    total:        cube.total,
    sum,
    drift,
    unclassified: cube.byCategory.get(REPORT_CATEGORY.UNCLASSIFIED) ?? 0,
  };
}

/**
 * What the plan actually costs: the tier-1 total, and its share of the naive one.
 *
 * `overstatement` is §3's headline restated per run — "the naive total overstates
 * spending by N%" — which is the sentence the whole design exists to make sayable.
 *
 * **Every figure comes in both units, and a caller must not mix them.** Nominal
 * spending and real *all-debits* are two different quantities that can land close
 * together by coincidence — measured on the reference plan they differ by 3%, against a
 * real-vs-nominal ratio of 2.3x on the same-quantity pair. Presented side by side, the
 * coincidence reads as "inflation barely matters here", which is the exact opposite of
 * what §9(b) measured. Compare like with like: `spending` against `spendingReal`.
 *
 * @param {ReturnType<typeof buildSpendingCube>} cube
 */
export function spendingSummary(cube) {
  const spending = cube.byTier.get(SPEND_TIER.SPENDING)     ?? 0;
  const other    = cube.byTier.get(SPEND_TIER.NOT_SPENDING) ?? 0;

  let spendingReal = 0, notSpendingReal = 0;
  for (const row of cube.rows) {
    if (row.tier === SPEND_TIER.SPENDING) spendingReal    += row.amountReal;
    else                                  notSpendingReal += row.amountReal;
  }

  return {
    spending,
    notSpending:  other,
    total:        cube.total,
    spendingReal,
    notSpendingReal,
    totalReal:    cube.totalReal,
    spendingShare: cube.total > 0 ? spending / cube.total : 0,
    /** How much a chart of "all debits" would overstate the cost of the plan. */
    overstatement: spending > 0 ? cube.total / spending - 1 : null,
    /**
     * How much a NOMINAL chart overstates the same spending — the other half of the
     * headline, and the one design 82 could defer and this design cannot.
     */
    inflationFactor: spendingReal > 0 ? spending / spendingReal : null,
  };
}

/**
 * Categories that carry money in this cube, largest first.
 *
 * Both units on every row, ordered by the REAL amount: a page whose charts are real and
 * whose summary table is nominal is two claims about one run, and the reader has no way
 * to tell which number they are looking at.
 */
export function categoriesByValue(cube) {
  const real = new Map();
  for (const row of cube.rows) real.set(row.category, (real.get(row.category) ?? 0) + row.amountReal);

  return [...cube.byCategory]
    .map(([category, amount]) => ({
      category, tier: CATEGORY_TIER[category], amount, amountReal: real.get(category) ?? 0,
    }))
    .sort((a, b) => b.amountReal - a.amountReal);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The currency a `<key>.balance` path is denominated in.
 *
 * Schema first, because that is the declaration the reports read; the account's own
 * descriptor second, because the loan accounts resolve to a currency-KIND with a null
 * CODE and would otherwise be counted in whatever the target currency happens to be.
 * `account.currency` is an object descriptor, not a string — reading it as a string is
 * a mistake this codebase has made before.
 */
function _currencyOf(stateKey, schemaRegistry, state) {
  const vt = schemaRegistry?.resolve?.(stateKey);
  if (vt?.kind === 'currency' && vt.currencyCode) return vt.currencyCode;
  const account = state?.[stateKey.slice(0, -'.balance'.length)];
  const code    = account?.currency?.code ?? (typeof account?.currency === 'string' ? account.currency : null);
  return code ?? null;
}
