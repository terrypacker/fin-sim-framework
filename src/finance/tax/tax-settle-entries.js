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
 * tax-settle-entries — identifying the tax settlements in a journal, and collapsing
 * the action×reducer fan-out to one entry per settlement (design 71 §4.0.1).
 *
 * One settle ACTION is journaled once per REDUCER that processes it. Every settle in
 * this engine runs through exactly two — the country's settle-apply reducer and
 * `Accumulate Taxes Paid` — so `US_TAX_SETTLE_APPLY` appears twice per tax year with
 * the same `action.instanceId` and the same `taxDetail`.
 *
 * Two surfaces have to collapse that fan-out, and they must agree:
 *   - the worksheet CSV export, which would otherwise emit every year twice;
 *   - the timeline, which would otherwise render two "Tax Doc ↗" buttons per year.
 *
 * **The first entry of a group is the canonical one**, and not merely by convention:
 * `TaxDocumentRegistry._extractPeriod` derives each line's drill-down period by
 * scanning backwards for the previous settle of the same country. From the second
 * entry of a pair that scan finds its own twin, producing a degenerate period bounded
 * by the same settlement instead of by the prior tax year — so a document generated
 * from the second entry carries broken drill-down links.
 */

/** Action types that carry a settlement the reporting service can render. */
export const TAX_SETTLE_ACTION_TYPES = Object.freeze([
  'US_TAX_SETTLE_APPLY',
  'AU_TAX_SETTLE_APPLY',
  'STATE_TAX_SETTLE_APPLY',
]);

/** Action type for a country/jurisdiction code: `'US'` → `'US_TAX_SETTLE_APPLY'`. */
export function settleActionTypeFor(cc) {
  return `${String(cc).toUpperCase()}_TAX_SETTLE_APPLY`;
}

/**
 * True when the entry is a tax settlement that actually carries a payload to render.
 * A settle with neither `taxDetail` nor `personTaxDetails` produces no document.
 *
 * @param {object} entry
 * @param {{ types?: string[] }} [opts]  restrict to these action types
 */
export function isTaxSettleEntry(entry, { types = TAX_SETTLE_ACTION_TYPES } = {}) {
  const action = entry?.action;
  if (!action || !types.includes(action.type)) return false;
  const data = action.data ?? {};
  return data.taxDetail != null || data.personTaxDetails?.length > 0;
}

/**
 * The set of journal ENTRIES that are the first entry for their settlement — one per
 * settle action. Callers render/export only these.
 *
 * Keyed on entry object identity rather than `entry.id`, so a hand-built journal whose
 * entries carry no id cannot collapse into a single `undefined` key and match
 * everything. Grouping still uses `action.instanceId`, falling back to the entry
 * itself when there is none — which makes each such entry primary, the right answer
 * when there is no fan-out to collapse.
 *
 * @param {object[]} journal
 * @param {{ types?: string[] }} [opts]
 * @returns {Set<object>} the primary entries
 */
export function primaryTaxSettleEntries(journal, opts = {}) {
  const primary = new Set();
  const seen    = new Set();
  for (const entry of journal ?? []) {
    if (!isTaxSettleEntry(entry, opts)) continue;
    const settleId = entry.action.instanceId ?? entry;
    if (seen.has(settleId)) continue;
    seen.add(settleId);
    primary.add(entry);
  }
  return primary;
}
