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
 * holding-activity — pure derivation helpers for the Holdings workbench plugin.
 *
 * These functions read the live simulation state and the journal; they have no
 * DOM or service dependencies so they can be unit-tested in isolation.
 *
 * Two views are derived:
 *   snapshotHoldings(account)          — the current per-holding position table
 *   buildHoldingActivity(entries, …)   — a chronological buy/sell/growth ledger
 *
 * The activity ledger is account-agnostic: rather than enumerating the many
 * action types that can move a holding (HOLDING_TRANSACT, STOCK_WITHDRAWAL_APPLY,
 * ROTH_CONVERSION_APPLY, dividend/earnings, regime revalues, …) it diffs the
 * `<stateKey>.holdings` array recorded in each journal entry's stateDiff. Every
 * reducer that returns new state produces that array diff via diffStates(), so
 * one code path covers all holding-capable accounts.
 */

// Action types whose holding changes are market moves (appreciation, dividend
// reinvest, mark-to-market) rather than discretionary buys/sells. Matched
// case-insensitively against the journal entry's actionType.
const GROWTH_ACTION_RE = /REVALUE|EARNINGS|DIVIDEND|REGIME|APPRECIAT|GROWTH|INFLATION/i;

/** Activity row kinds. */
export const HOLDING_ACTIVITY_KIND = Object.freeze({
  BUY:    'BUY',
  SELL:   'SELL',
  GROWTH: 'GROWTH',
});

/**
 * Build the current-position snapshot for one account.
 * @param {object|null} account - a state account ({ holdings: [...] }) or null
 * @returns {Array<{id,label,allocation,rateKey,marketValue,costBasis,unrealized}>}
 */
export function snapshotHoldings(account) {
  const holdings = account?.holdings;
  if (!Array.isArray(holdings)) return [];
  return holdings.map(h => {
    const marketValue = h?.marketValue ?? 0;
    const costBasis   = h?.costBasis   ?? 0;
    return {
      id:          h?.id ?? null,
      label:       h?.label || h?.id || '(unnamed)',
      allocation:  h?.allocation ?? null,
      rateKey:     h?.rateKey ?? null,
      marketValue,
      costBasis,
      unrealized:  +(marketValue - costBasis).toFixed(2),
    };
  });
}

/** Total a snapshot's market value / cost basis / unrealized gain. */
export function totalSnapshot(rows) {
  return rows.reduce((acc, r) => {
    acc.marketValue += r.marketValue;
    acc.costBasis   += r.costBasis;
    acc.unrealized  += r.unrealized;
    return acc;
  }, { marketValue: 0, costBasis: 0, unrealized: 0 });
}

/**
 * Classify a per-holding delta into a ledger kind.
 *
 *   - growth-type action (revalue / earnings / dividend / regime)  → GROWTH
 *   - marketValue fell                                             → SELL
 *   - marketValue rose but cost basis did NOT                      → GROWTH
 *     (appreciation arrives as a HOLDING_TRANSACT with mvDelta>0, basisDelta≈0;
 *      a genuine purchase/contribution raises basis alongside marketValue)
 *   - otherwise (marketValue and basis both rose)                  → BUY
 */
function _classify(actionType, mvDelta, basisDelta) {
  if (actionType && GROWTH_ACTION_RE.test(actionType)) return HOLDING_ACTIVITY_KIND.GROWTH;
  if (mvDelta < 0) return HOLDING_ACTIVITY_KIND.SELL;
  if (Math.abs(basisDelta) < 0.01) return HOLDING_ACTIVITY_KIND.GROWTH;
  return HOLDING_ACTIVITY_KIND.BUY;
}

/** Index a holdings array by id → holding. */
function _byId(arr) {
  const map = new Map();
  for (const h of arr ?? []) if (h?.id != null) map.set(h.id, h);
  return map;
}

/**
 * Derive a chronological holding-activity ledger for one account from the
 * journal. Each entry that changed `<stateKey>.holdings` contributes one row
 * per holding whose marketValue moved.
 *
 * @param {Array<object>} entries  - journal entries (sim.journal.journal)
 * @param {string}        stateKey - the account's state key (e.g. 'usStockAccount')
 * @param {object}        [opts]
 * @param {number|null}   [opts.asOfMs=null]      - drop entries dated after this (ms epoch); null = all
 * @param {boolean}       [opts.includeGrowth=false] - include GROWTH rows (appreciation/dividends)
 * @returns {Array<{ts,date,seq,actionType,reducerName,holdingId,label,allocation,mvDelta,basisDelta,kind}>}
 */
export function buildHoldingActivity(entries, stateKey, { asOfMs = null, includeGrowth = false } = {}) {
  if (!Array.isArray(entries) || !stateKey) return [];
  const field = `${stateKey}.holdings`;
  const rows  = [];

  for (const entry of entries) {
    const ts = entry?.date instanceof Date ? entry.date.getTime() : new Date(entry?.date).getTime();
    if (asOfMs != null && ts > asOfMs) continue;

    const diff = entry?.stateDiff?.find(d => d.field === field);
    if (!diff) continue;

    const beforeMap = _byId(diff.before);
    const afterMap  = _byId(diff.after);
    const actionType = entry.action?.type ?? null;
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);

    for (const id of ids) {
      const before = beforeMap.get(id);
      const after  = afterMap.get(id);
      const beforeMv = before?.marketValue ?? 0;
      const afterMv  = after?.marketValue  ?? 0;
      const mvDelta  = +(afterMv - beforeMv).toFixed(2);
      if (mvDelta === 0) continue; // basis-only / metadata change — not a position move

      const basisDelta = +((after?.costBasis ?? 0) - (before?.costBasis ?? 0)).toFixed(2);
      const kind       = _classify(actionType, mvDelta, basisDelta);
      if (kind === HOLDING_ACTIVITY_KIND.GROWTH && !includeGrowth) continue;

      const ref = after ?? before;
      rows.push({
        ts,
        date:        entry.date,
        seq:         entry.seq,
        actionType,
        reducerName: entry.reducer?.name ?? null,
        holdingId:   id,
        label:       ref?.label || id,
        allocation:  ref?.allocation ?? null,
        mvDelta,
        basisDelta,
        kind,
      });
    }
  }

  // Chronological by (ts, seq) ascending.
  rows.sort((a, b) => (a.ts - b.ts) || ((a.seq ?? 0) - (b.seq ?? 0)));
  return rows;
}
