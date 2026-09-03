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
 * Roll the allocation cube up BY INSTRUMENT, across every account — design 94 step 10,
 * the third of §10.2e's three loose ends.
 *
 * ### Why this exists: the one place a unit count may be added up
 *
 * The holdings table refuses to total its Units column, and is right to: "summing counts
 * of different instruments produces a number that looks like a quantity and is not one"
 * (§10.2e). But that refusal left a real question unanswerable — *how many shares of this
 * do I own?* — because a plan holds one security across several accounts and no view
 * crossed them.
 *
 * A per-SECURITY rollup is exactly the grouping in which the sum is legitimate: 300 units
 * of one instrument in a 401(k) plus 200 in a brokerage is 500 units of that instrument.
 * So the rule does not change, it becomes precise: **units total within a security and
 * never across securities.** The panel built on this therefore has no units total row,
 * and that omission is deliberate rather than an oversight.
 *
 * ### Three properties worth knowing before reading a number off this
 *
 * - **Money is in the cube's BASE currency; units are in units.** The cube converts
 *   `marketValueLocal` at the run's own rate, so a US and an AU position in one
 *   instrument add up correctly in money. `avgPrice` is therefore a base-currency
 *   average, NOT any price the market quoted — it is `marketValue / units`, which is
 *   what a blended cost of a multi-account position actually is. Design 94 §4 decided
 *   price lives on the POSITION, so there is no single "the price" to show instead.
 * - **`units` is null unless every contributing bucket has one.** Same rule the cube
 *   applies within a bucket, extended: a partial sum is an undercount presented as a
 *   count. A book mixing a unitised equity lot with a scalar one reports no count rather
 *   than the wrong one.
 * - **Only rows that NAME an instrument take part.** A house, a company stake, a loan and
 *   a cash sleeve name none. Folding them into a `(none)` bucket would bury the answer
 *   under the plan's largest number — the same reason the allocation panel's By-security
 *   view filters them out.
 */

const _round = n => +(Number(n) || 0).toFixed(2);

/**
 * @typedef {object} SecurityRollupRow
 * @property {string}  securityId    the join key — what a lot's `securityId` names
 * @property {string}  security      the display label (symbol, else name, else the id)
 * @property {string|null} rateKey   the market, or null when buckets disagree
 * @property {string|null} allocation the sleeve, or null when buckets disagree
 * @property {number|null} units     Σ units, or null when any bucket is scalar
 * @property {number|null} avgPrice  marketValue / units, in the cube's base currency
 * @property {number}  marketValue   base currency
 * @property {number|null} costBasis base currency; null when any bucket carries none
 * @property {number|null} unrealized marketValue − costBasis, when both are known
 * @property {number}  holdingCount  lots behind the row
 * @property {number}  share         fraction of the rolled-up market value (0..1)
 * @property {Array<{stateKey:string,name:string,units:number|null,marketValue:number,costBasis:number|null}>} accounts
 *           per-account breakdown, largest first — the "across all accounts" half
 */

/**
 * @param {object[]} rows            `buildAllocationCube` output for ONE point in time
 * @param {object}   [opts]
 * @param {boolean}  [opts.includeSynthetic=true]
 *        Include the four `sec-auto-*` market securities. They are what every migrated
 *        equity lot names (§9.1), so excluding them empties the view on any plan that has
 *        not authored instruments — which is most of them.
 * @returns {SecurityRollupRow[]} largest market value first
 */
export function rollupBySecurity(rows, { includeSynthetic = true } = {}) {
  const groups = new Map();

  for (const r of rows ?? []) {
    if (r?.securityId == null) continue;
    if (!includeSynthetic && String(r.securityId).startsWith('sec-auto-')) continue;

    let g = groups.get(r.securityId);
    if (!g) {
      g = {
        securityId: r.securityId,
        security:   r.security || r.securityId,
        rateKey:    r.rateKey ?? null,
        allocation: r.allocation ?? null,
        units: 0, allUnitised: true,
        marketValue: 0,
        costBasis: 0, allBased: true,
        holdingCount: 0,
        accounts: new Map(),
      };
      groups.set(r.securityId, g);
    }

    // A security is ONE instrument, so a disagreement between two of its buckets is real
    // information — two lots in one security allocated differently, which the containment
    // guard permits and nothing else surfaces. Reported as "no single answer" (null)
    // rather than as whichever bucket happened to be read first.
    if (g.rateKey    !== (r.rateKey    ?? null)) g.rateKey    = null;
    if (g.allocation !== (r.allocation ?? null)) g.allocation = null;

    if (r.units == null) g.allUnitised = false;
    else                 g.units += Number(r.units) || 0;

    if (r.costBasis == null) g.allBased = false;
    else                     g.costBasis += r.costBasis;

    g.marketValue  += r.marketValue ?? 0;
    g.holdingCount += r.holdingCount ?? 0;

    const key = r.stateKey;
    const a = g.accounts.get(key)
      ?? { stateKey: key, name: r.name ?? key, units: 0, allUnitised: true, marketValue: 0, costBasis: 0, allBased: true };
    if (r.units == null) a.allUnitised = false; else a.units += Number(r.units) || 0;
    if (r.costBasis == null) a.allBased = false; else a.costBasis += r.costBasis;
    a.marketValue += r.marketValue ?? 0;
    g.accounts.set(key, a);
  }

  const total = [...groups.values()].reduce((n, g) => n + g.marketValue, 0);

  return [...groups.values()]
    .map(g => {
      const units       = g.allUnitised ? +g.units.toFixed(6) : null;
      const marketValue = _round(g.marketValue);
      const costBasis   = g.allBased ? _round(g.costBasis) : null;
      return {
        securityId:  g.securityId,
        security:    g.security,
        rateKey:     g.rateKey,
        allocation:  g.allocation,
        units,
        // Guarded against a zero count as well as a null one: a fully-sold position can
        // sit at 0 units with a residual value, and dividing by it would print Infinity
        // where the honest answer is "no price".
        avgPrice:    units ? +(marketValue / units).toFixed(4) : null,
        marketValue,
        costBasis,
        unrealized:  costBasis == null ? null : _round(marketValue - costBasis),
        holdingCount: g.holdingCount,
        share:       total > 0 ? marketValue / total : 0,
        accounts: [...g.accounts.values()]
          .map(a => ({
            stateKey: a.stateKey,
            name:     a.name,
            units:    a.allUnitised ? +a.units.toFixed(6) : null,
            marketValue: _round(a.marketValue),
            costBasis:   a.allBased ? _round(a.costBasis) : null,
          }))
          .sort((x, y) => y.marketValue - x.marketValue || String(x.stateKey).localeCompare(String(y.stateKey))),
      };
    })
    // Largest first — a concentration view whose biggest position is not at the top is
    // answering a different question than the one it was opened for (§3 item 4). Ties
    // break on the id so two equal positions do not swap places between two sim steps.
    .sort((a, b) => b.marketValue - a.marketValue || a.securityId.localeCompare(b.securityId));
}

/**
 * Total a rollup — MONEY ONLY.
 *
 * There is deliberately no `units` here. Adding a share of one instrument to a share of
 * another is the category error §10.2e named, and it does not stop being one because the
 * rows above it each carry a legitimate count. This function existing without that field
 * is the rule, written where a future author will hit it.
 */
export function totalSecurityRollup(rowsOut) {
  return (rowsOut ?? []).reduce((acc, r) => {
    acc.marketValue += r.marketValue ?? 0;
    if (r.costBasis == null) acc.allBased = false;
    else                     acc.costBasis += r.costBasis;
    acc.holdingCount += r.holdingCount ?? 0;
    return acc;
  }, { marketValue: 0, costBasis: 0, allBased: true, holdingCount: 0 });
}
