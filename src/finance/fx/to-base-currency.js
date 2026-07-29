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
 * to-base-currency.js — the one *valuation* FX convention (design 82 §5.1a).
 *
 * Distinct from `fx-conversion.js`, which owns *transfer* math: moving money across
 * a border costs a fee and is a transaction (design 44). This is the cheaper,
 * different question of what a foreign-denominated holding is WORTH in the base
 * currency at an instant — no fee, no transaction, just a rate.
 *
 * The convention, which every caller must share:
 *
 *     pair id = `${base}_${quote}`   — e.g. USD_AUD = AUD per 1 USD
 *     value   = amount / rate        — so AUD 1.55 at USD_AUD 1.55 is USD 1.00
 *
 * ─── why this is a module and not a private helper ───────────────────────────
 *
 * `computeNetWorth` and `buildAllocationCube` are held together by an invariant —
 * Σ cube rows === computeNetWorth (design 82 §3) — and an allocation report's every
 * share depends on it, because a denominator that misvalues an asset misstates every
 * slice, not just that one. When each side carried its own copy of these six lines,
 * that invariant was guarded by a COMMENT asking the next editor to change both. A
 * divergence would not have thrown: both sides would still be internally consistent
 * and the shares would simply be wrong.
 *
 * Still duplicated elsewhere on purpose (design 82 §5.1a): `net-liquidity.js`,
 * `after-tax.js`, `guardrail-portfolio-value.js`, and the MC runner's
 * `computeHouseValueUsd`. Converting those is right on the merits but each is a
 * golden-locked metric, and the change belongs to whoever is willing to re-verify
 * them — not to a commit whose subject is a report.
 */

/**
 * Value `amount` of `currency` in `baseCurrency`, using the state's effective rates.
 *
 * A missing rate falls back to 1:1 rather than throwing: these are display and
 * valuation paths, where a scenario mid-edit can legitimately hold a currency no
 * rate has been seeded for yet, and refusing to value it would take down the whole
 * readout over one account.
 *
 * @param {number} amount
 * @param {string} currency        - the amount's own currency code
 * @param {string} baseCurrency    - currency to express the result in
 * @param {object} state           - carries `effectiveExchangeRates`
 * @returns {number}
 */
export function toBaseCurrency(amount, currency, baseCurrency, state) {
  if (!Number.isFinite(amount)) return 0;
  if (!currency || currency === baseCurrency) return amount;
  const rate = state?.effectiveExchangeRates?.[`${baseCurrency}_${currency}`] ?? 1;
  return rate ? amount / rate : amount;
}

/**
 * The currency code of a state entry. Accounts carry `currency` as a `{code}`
 * object; other entries carry a bare string. Both shapes are live in saved
 * scenarios, so every valuation site needs this normalization — and got it wrong
 * often enough to be worth centralizing next to the conversion it feeds.
 *
 * @param {object} entry
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
export function currencyOf(entry, fallback) {
  return entry?.currency?.code ?? entry?.currency ?? fallback;
}
