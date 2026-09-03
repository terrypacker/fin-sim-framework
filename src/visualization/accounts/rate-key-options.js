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
 * The Rate Key picker's option list — the market-return series a position (or, since
 * design 94 step 10, an INSTRUMENT) may track.
 *
 * Extracted from `account-editor.js` at design 94 step 10 because there is now a second
 * caller: the securities editor picks the same `rateKey` for a `Security` that the
 * holdings editor picks for a lot, and the two must offer the same set. A second list
 * composed slightly differently is how `state.people` grew three drifted projections in
 * this repo; one call site is how that stops happening again.
 */

import { RATE_KEYS } from '../../finance/economic-regimes/rate-keys.js';

/**
 * Rate Key choices, grouped by asset category. A holding's rateKey selects which
 * market-return series drives its growth (`state.effective*Rates[rateKey]`) and is the
 * handle shocks/regimes author effects on. The class keys (the four MARKET keys —
 * design 90 §7.2) are all valid override targets (see rate-keys.js). Blank = leave
 * unset (the account resolves a default at creation). A free-text typo silently fell
 * back to a generic rate — this list makes the valid set discoverable and prevents that.
 */
export const RATE_KEY_GROUPS = [
  { label: 'Equity — domestic',      keys: [RATE_KEYS.EQUITY_US, RATE_KEYS.EQUITY_AU] },
  // Design 90 §7.2 — grouped by MARKET, not by account wrapper. A wrapper-specific rate
  // is now a per-account override (`<marketKey>::<stateKey>`) rather than a key of its own.
  { label: 'Equity — international', keys: [RATE_KEYS.EQUITY_INTL_EX_US, RATE_KEYS.EQUITY_INTL_EX_AU] },
  { label: 'Fixed income',           keys: [RATE_KEYS.FIXED_INCOME_US, RATE_KEYS.FIXED_INCOME_AU] },
  { label: 'Savings',                keys: [RATE_KEYS.SAVINGS_US, RATE_KEYS.SAVINGS_AU] },
  { label: 'Gold',                   keys: [RATE_KEYS.GOLD] },
  { label: 'Real estate / other',    keys: [RATE_KEYS.REAL_ESTATE_US, RATE_KEYS.REAL_ESTATE_AU, RATE_KEYS.COLLECTIBLE] },
];

/**
 * Flat set of known keys, for detecting an out-of-enum (custom/legacy) value so the
 * dropdown preserves it instead of silently dropping it on edit.
 */
export const KNOWN_RATE_KEYS = new Set(RATE_KEY_GROUPS.flatMap(g => g.keys));

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * Build the `<option>`/`<optgroup>` markup for a Rate Key select.
 *
 * Blank first (leave unset), then the known keys grouped by category. An out-of-enum
 * current value (custom/legacy) is preserved as a selected option so editing never
 * silently drops what the author had.
 *
 * @param {string} selected  the current rateKey ('' when unset)
 * @param {string} [blankLabel='— none —']
 * @returns {string} inner HTML for the `<select>`
 */
export function rateKeyOptionsHtml(selected, blankLabel = '— none —') {
  const cur   = selected ?? '';
  const blank = `<option value=""${cur === '' ? ' selected' : ''}>${_esc(blankLabel)}</option>`;
  const groups = RATE_KEY_GROUPS.map(g => {
    const opts = g.keys.map(k =>
      `<option value="${_esc(k)}"${k === cur ? ' selected' : ''}>${_esc(k)}</option>`
    ).join('');
    return `<optgroup label="${_esc(g.label)}">${opts}</optgroup>`;
  }).join('');
  const custom = (cur !== '' && !KNOWN_RATE_KEYS.has(cur))
    ? `<optgroup label="Custom"><option value="${_esc(cur)}" selected>${_esc(cur)}</option></optgroup>`
    : '';
  return blank + groups + custom;
}
