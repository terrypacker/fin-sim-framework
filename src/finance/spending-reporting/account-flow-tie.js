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
 * §7(b) — the flow ties to the stock. Design 89 phase 4.
 *
 *     openingBalance + Σ credits − Σ debits === closingBalance     per account, per year
 *
 * Design 89 calls this the invariant worth the most, and the reason is not arithmetic:
 * it is what makes the spending chart and design 82's allocation chart **one picture
 * rather than two plausible ones**. If it holds, they are the same run described twice.
 * If it does not, the identity names the account and the year to look at.
 *
 * ─── two checks, not one, because a flow report can be wrong in two ways ─────
 *
 * **1. Continuity** (`checkJournalContinuity`). Within the journal, consecutive diffs on
 * one `<key>.balance` must chain: `diff[i].after === diff[i+1].before`. A break means the
 * balance moved without a journal entry saying so — money the spending cube can never see,
 * because the cube is built entirely from those diffs. This needs no sampler and no state;
 * it asks whether the journal is a complete account of itself.
 *
 * **2. The tie** (`checkFlowTiesToStock`). The journalled flows, against balances sampled
 * from LIVE STATE at design 82's year boundaries. This is the cross-check the first one
 * cannot be: continuity would still pass if every diff were internally consistent and
 * collectively wrong. Two independent readings of the same quantity are what make the
 * agreement mean something.
 *
 * Measured on the reference plan when this was written: 8,464 balance diffs with **0**
 * continuity breaks, and 924 (account, year) cells with **0** failures at a one-cent
 * tolerance. That is the result the design predicted, and it is only worth reporting
 * because the mutation tests establish that the checks can fail.
 *
 * ─── why this does not reuse the spending cube ───────────────────────────────
 *
 * The cube is debits-only by construction (§7 a is about where money GOES, and a credit
 * has no category in that taxonomy). This identity needs both sides, unclassified, and it
 * must count every balance movement including the ones the classification would route to
 * `UNCLASSIFIED`. Building it on the cube would make the invariant depend on the thing it
 * is supposed to be checking.
 */

/**
 * Balances at design 82's sample instants — the STOCK side of the identity.
 *
 * Pass to `openSim(cfg, { sampler, samplerCadence: 'year-boundary' })`, the same seam
 * `createAllocationSampler` uses, so the two reports sample at one instant rather than at
 * two that are nearly the same. That is design 82 §4's whole point, and the reason this
 * is a sampler rather than a `stepTo` loop of its own.
 *
 * The record snapshots primitives only: `_recordSample` hands the sampler the LIVE state,
 * which the run goes on mutating, so a record holding a reference into it would silently
 * become a reading of the present rather than of the year end.
 *
 * @returns {(state: object, date: Date) => {at: Date, year: number, balances: Object<string, number>}}
 */
export function createBalanceSampler() {
  return function sampleBalances(state, date) {
    const at       = new Date(date);
    const balances = {};
    for (const [key, value] of Object.entries(state ?? {})) {
      if (value && typeof value === 'object' && typeof value.balance === 'number') {
        balances[key] = value.balance;
      }
    }
    return { at, year: at.getUTCFullYear(), balances };
  };
}

/**
 * Add `balances` to the records of a sampler that is already installed.
 *
 * **`buildSim` takes exactly ONE sampler**, and in the workbench that slot is occupied by
 * design 82's `createAllocationSampler`. A second sampler is not available, and having the
 * spending panel reconstruct closing balances from the journal instead would destroy the
 * point of §7(b): the identity would then compare the journal against itself, which is the
 * blind spot the continuity check exists to cover. Two readings of one quantity have to
 * come from two places.
 *
 * So the two designs share one sampler. The allocation panel ignores `balances`, this one
 * ignores `rows`, and — better than the two lab pages, which each run their own sim — they
 * are now guaranteed to be reading the same instant rather than two instants that agree.
 *
 * Written as a decorator rather than folded into `createAllocationSampler` so design 82's
 * module keeps its own concerns, and the coupling lives in the design that introduced it.
 *
 * @param {(state: object, date: Date) => object} [inner]  the sampler to wrap; omitted
 *   gives a balances-only sampler, identical to `createBalanceSampler()`
 * @returns {(state: object, date: Date) => object}
 */
export function withBalances(inner = null) {
  const sampleBalances = createBalanceSampler();
  if (!inner) return sampleBalances;
  return function sampleBoth(state, date) {
    const base = inner(state, date) ?? {};
    // Ours last: a record missing `balances` reads as "no §7(b) available" and degrades to
    // "not checked", which is the honest outcome — but silently overwriting the inner
    // sampler's own key would be a defect in the other panel, so never do that either.
    if (base.balances !== undefined) return base;
    return { ...base, balances: sampleBalances(state, date).balances };
  };
}

/**
 * Every `<key>.balance` movement, split by sign, bucketed per account per calendar year.
 *
 * Both sides at once because the identity needs both, and from the same pass so a credit
 * and a debit on one entry cannot end up bucketed into different years.
 *
 * @param {import('../../simulation-framework/journal.js').Journal} journal
 * @returns {{byCell: Map<string, {stateKey: string, year: number, credits: number, debits: number, net: number}>,
 *            openingFromJournal: Map<string, number>, diffCount: number}}
 *   `openingFromJournal` is the FIRST `before` seen for each key — the opening balance of
 *   the run, which no prior year-boundary sample can supply. Same seed idea as
 *   `JournalPriceLevels`, and it is what lets the first year be checked rather than skipped.
 */
export function buildAccountFlows(journal) {
  const byCell = new Map();
  const openingFromJournal = new Map();
  let diffCount = 0;

  for (const entry of journal?.journal ?? []) {
    const year = new Date(entry.date).getUTCFullYear();
    for (const diff of entry.stateDiff ?? []) {
      const field = diff.field ?? '';
      if (!field.endsWith('.balance')) continue;
      diffCount++;

      const stateKey = field.slice(0, -'.balance'.length);
      if (!openingFromJournal.has(stateKey) && typeof diff.before === 'number') {
        openingFromJournal.set(stateKey, diff.before);
      }

      const delta = diff.delta ?? 0;
      if (!delta) continue;
      const id = `${stateKey}|${year}`;
      let cell = byCell.get(id);
      if (!cell) { cell = { stateKey, year, credits: 0, debits: 0, net: 0 }; byCell.set(id, cell); }
      if (delta > 0) cell.credits += delta; else cell.debits += -delta;
      cell.net += delta;
    }
  }
  return { byCell, openingFromJournal, diffCount };
}

/**
 * Check 1 — the journal is a complete account of itself.
 *
 * @param {import('../../simulation-framework/journal.js').Journal} journal
 * @param {number} [tolerance=1e-6] absolute, in the account's own currency
 * @returns {{ok: boolean, diffCount: number, breaks: Array<object>, worst: object|null}}
 */
export function checkJournalContinuity(journal, tolerance = 1e-6) {
  const lastAfter = new Map();
  const breaks    = [];
  let diffCount = 0, worst = null;

  for (const entry of journal?.journal ?? []) {
    for (const diff of entry.stateDiff ?? []) {
      const field = diff.field ?? '';
      if (!field.endsWith('.balance')) continue;
      diffCount++;

      const previous = lastAfter.get(field);
      if (previous !== undefined && typeof diff.before === 'number') {
        const gap = Math.abs(previous - diff.before);
        if (gap > tolerance) {
          const record = {
            stateKey: field.slice(0, -'.balance'.length),
            date: entry.date, actionType: entry.action?.type ?? null,
            expected: previous, found: diff.before, gap,
          };
          breaks.push(record);
          if (!worst || gap > worst.gap) worst = record;
        }
      }
      if (typeof diff.after === 'number') lastAfter.set(field, diff.after);
    }
  }
  return { ok: breaks.length === 0, diffCount, breaks, worst };
}

/**
 * Check 2 — the identity, per account per year.
 *
 * @param {object} opts
 * @param {object[]} opts.samples   year-boundary records from `createBalanceSampler`
 * @param {import('../../simulation-framework/journal.js').Journal} opts.journal
 * @param {number} [opts.tolerance=0.01]  one cent, in the account's own currency. Not a
 *   relative tolerance: this is an accounting identity between numbers that are already
 *   in one unit, and a relative band would hide a large break on a large account, which
 *   is exactly the account it matters on.
 * @returns {{ok, cells, failures, checked, worst, unchecked}}
 *   `cells` carries every (account, year) so a report can render the whole grid rather
 *   than only the failures — a page that shows nothing when nothing is wrong gives the
 *   reader no way to tell it ran.
 */
export function checkFlowTiesToStock({ samples, journal, tolerance = 0.01 } = {}) {
  const ordered = [...(samples ?? [])].filter(s => s?.balances).sort((a, b) => a.year - b.year);
  const { byCell, openingFromJournal } = buildAccountFlows(journal);

  const cells = [];
  const failures = [];
  let worst = null;

  for (let i = 0; i < ordered.length; i++) {
    const current  = ordered[i];
    const previous = i > 0 ? ordered[i - 1] : null;

    // Every account seen on either side of the step. An account that appears mid-run
    // opens at 0 and its creation must show up as a credit — if the balance springs into
    // existence unjournalled, this fails, which is the correct outcome rather than a case
    // to special-case away.
    const keys = new Set([
      ...Object.keys(current.balances),
      ...Object.keys(previous?.balances ?? {}),
    ]);

    for (const stateKey of keys) {
      const closing = current.balances[stateKey] ?? 0;
      // The first sampled year has no prior boundary, so its opening comes from the
      // journal's first `before`. Skipping it instead would leave the plan's opening year
      // — often its largest — as the one year nothing checks.
      const opening = previous
        ? (previous.balances[stateKey] ?? 0)
        : (openingFromJournal.get(stateKey) ?? current.balances[stateKey] ?? 0);
      const openingSource = previous ? 'sample' : 'journal';

      const flow     = byCell.get(`${stateKey}|${current.year}`) ?? { credits: 0, debits: 0 };
      const residual = closing - (opening + flow.credits - flow.debits);

      const cell = {
        stateKey, year: current.year, opening, closing,
        credits: flow.credits, debits: flow.debits, residual, openingSource,
      };
      cells.push(cell);
      if (Math.abs(residual) > tolerance) {
        failures.push(cell);
        if (!worst || Math.abs(residual) > Math.abs(worst.residual)) worst = cell;
      }
    }
  }

  return {
    ok: failures.length === 0,
    cells,
    failures,
    checked: cells.length,
    worst,
    // Nothing to check is NOT a pass. A run with no sampler produces no samples, and a
    // green tick over an empty set is the failure mode design 82 §3 and the payload
    // schema test both grew explicit guards for.
    unchecked: ordered.length === 0,
  };
}

/**
 * Both checks, plus the one-line verdict a page prints above the chart.
 *
 * @param {object} opts  as `checkFlowTiesToStock`
 * @returns {{ok, continuity, tie, summary: string}}
 */
export function checkFlowInvariant({ samples, journal, tolerance = 0.01 } = {}) {
  const continuity = checkJournalContinuity(journal);
  const tie        = checkFlowTiesToStock({ samples, journal, tolerance });
  const ok         = continuity.ok && tie.ok && !tie.unchecked;

  const summary = tie.unchecked
    ? 'not checked — the run produced no year-boundary samples'
    : ok
      ? `ties across ${tie.checked} account-years and ${continuity.diffCount} balance movements`
      : [
          continuity.ok ? null
            : `${continuity.breaks.length} unjournalled balance movement(s), worst ${continuity.worst?.gap?.toFixed(2)} on ${continuity.worst?.stateKey}`,
          tie.ok ? null
            : `${tie.failures.length} of ${tie.checked} account-years do not tie, worst ${tie.worst?.residual?.toFixed(2)} on ${tie.worst?.stateKey} in ${tie.worst?.year}`,
        ].filter(Boolean).join('; ');

  return { ok, continuity, tie, summary };
}
