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
 * DESIGN 81 §4.4 / §4.5 — the two hooks that turn a recorded decision into a run.
 *
 *   `scheduleKey(variable)`  the STABLE decision key a recorded row is addressed by
 *   `applyAt({ … })`         the state patch the rows in force produce
 *
 * ─── why they live here and not inline in `COCKPIT_CONTROLS` ─────────────────────
 *
 * They are *spread into* the control specs by `cockpit-controller.js`, so the spec surface
 * is the one design 81 §4.5 describes — `scheduleKey` / `applyAt` beside `buildVariables` /
 * `describe` / `harvest` / `actuate`. They are DEFINED here because the two consumers that
 * need them earliest are the reducer and the toolset that registers it, and importing
 * `cockpit-controller.js` (which pulls the solver registry, the optimization problem and two
 * other toolsets) from inside `US_RETIREMENT.reducers` would be a large import cycle bought
 * for two pure functions. This module imports nothing.
 *
 * ─── why no index is ever stored (§4.5, D5) ──────────────────────────────────────
 *
 * `buildVariables` emits `spendingExpenseBands[19].monthlyAmount`. An index is a position
 * into a table AS IT STOOD DURING THAT RUN: edit the table and every recorded decision
 * silently points somewhere else. `scheduleKey` returns `band@69` instead — the anchor the
 * lever already stamps (`_startAge`) — and `applyAt` writes state keyed by that anchor, so
 * nothing ever writes back into the authored table and there is no index to re-key.
 */

/** `band@<startAge>` ⇄ the age anchor, in one place so the two halves cannot drift. */
export const BAND_KEY_PREFIX = 'band@';

/** @returns {string} the stable key for a SPENDING decision on the band starting at `age`. */
export function bandKey(age) { return `${BAND_KEY_PREFIX}${age}`; }

/** @returns {number|null} the startAge a `band@<age>` key names, or null when it is not one. */
export function bandKeyAge(key) {
  if (typeof key !== 'string' || !key.startsWith(BAND_KEY_PREFIX)) return null;
  const age = Number(key.slice(BAND_KEY_PREFIX.length));
  return Number.isFinite(age) ? age : null;
}

/**
 * SPENDING — `state.mpcSpendingBands`, a FULL REPLACEMENT band table (D12).
 *
 * Not a merge map. A replacement is the shape `ExplicitBandsSpendingReducer.bands` already
 * is, so `bandForAge` and the re-pin logic work unchanged and there is one vocabulary rather
 * than two; the size objection is ~1 KB of table against the ~280 KB a snapshot of a real
 * plan already carries.
 *
 * The table is rebuilt from the AUTHORED base every period, not from the previously stamped
 * one, because `rows` is already the whole history in force (the latest row per key at or
 * before "now"). That makes the patch a pure function of (base table, rows, now) — idempotent,
 * order-independent, and unable to accumulate drift across a rewind.
 *
 * Bands the run never decided are preserved from the base, which is what keeps the pre-MPC
 * plan for the realized past intact (design 39 §13.6.1's last rule, arriving for free).
 */
export const SPENDING_SCHEDULE = {
  scheduleKey: (variable) => {
    const age = variable?._startAge;
    return Number.isFinite(age) ? bandKey(age) : (variable?.paramKey ?? null);
  },

  applyAt: ({ rows, baseParams }) => {
    const base = baseParams?.spendingExpenseBands;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const bands = (Array.isArray(base) ? base : []).map(b => ({ ...b }));
    let touched = false;
    for (const row of rows) {
      const age    = bandKeyAge(row?.key);
      const amount = Number(row?.value);
      if (age == null || !Number.isFinite(amount)) continue;
      const i = bands.findIndex(b => Number(b?.startAge) === age);
      if (i >= 0) bands[i] = { ...bands[i], monthlyAmount: amount };
      else        bands.push({ startAge: age, monthlyAmount: amount });
      touched = true;
    }
    if (!touched) return null;
    // `bandForAge` walks the table in order and breaks at the first band that has not
    // started, so an out-of-order insert would make every later band unreachable.
    bands.sort((a, b) => Number(a.startAge) - Number(b.startAge));
    return { mpcSpendingBands: bands };
  },
};

/**
 * The hooks, by `COCKPIT_CONTROLS` key. Levers absent from this map have no `applyAt` yet and
 * are skipped by the reducer with a warning rather than silently ignored — a recorded row for
 * a lever that cannot be applied is a run playing back as something other than what it was.
 */
export const LEVER_SCHEDULE = {
  SPENDING: SPENDING_SCHEDULE,
};
