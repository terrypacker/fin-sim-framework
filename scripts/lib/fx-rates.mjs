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
 * fx-rates.mjs — the pinned published rate table, and the one convention it applies.
 *
 * Reads `rates/DEXUSAL-daily.csv` (see `rates/README.md` for provenance and why H.10).
 * This is the rate source for anything that reconciles to a **filed return**. The
 * engine's `effectiveExchangeRates.USD_AUD` is a *simulated* path and is not
 * interchangeable with it.
 *
 * ─── direction ──────────────────────────────────────────────────────────────────────
 *
 * Everything here is **USD per AUD** (~0.70), matching the published series. The
 * simulation engine holds the inverse, AUD per USD (~1.42). Swapping them inverts every
 * gain and no test of a zero case would notice, so the convention is stated in every
 * function name and return field rather than left to the caller's memory. Convert once,
 * at the edge, via {@link toAudPerUsd}.
 *
 * ─── the two kinds of "no rate" ─────────────────────────────────────────────────────
 *
 * They are not the same and must not share a code path:
 *
 *   HOLIDAY  — a date inside the series' range with no published rate (weekend, US
 *              banking holiday). There is nothing to publish, so a convention is
 *              required. Ours is the most recent published rate at or before the date.
 *              `§1.988-1(d)(2)` demands consistency, not any particular choice, so the
 *              only real duty is to apply it everywhere and disclose it — hence
 *              `carriedFrom` on every resolved rate.
 *
 *   UNPUBLISHED — a date after the last observation. H.10 publishes weekly in arrears,
 *              so a recent transaction genuinely has no rate yet. Carrying the last
 *              rate forward here would silently invent data at exactly the moment the
 *              answer is most uncertain, so this resolves to `null` and callers are
 *              expected to report it, not fill it.
 *
 * A date *before* the series starts is a third case and also resolves to `null`; it
 * means the pinned file is too short for the question being asked.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RATE_FILE = resolve(HERE, '../../rates/DEXUSAL-daily.csv');

/** @typedef {{ usdPerAud: number, quotedDate: string, carriedFrom: string|null }} ResolvedRate */

export class FxRateTable {
  /**
   * @param {Map<string, number>} observations  ISO date -> USD per AUD, published days only
   * @param {string} sourceFile
   */
  constructor(observations, sourceFile) {
    this.sourceFile = sourceFile;
    /** Sorted ISO dates that actually carry a published rate. */
    this._dates = [...observations.keys()].sort();
    this._obs = observations;
    this.firstDate = this._dates[0] ?? null;
    this.lastDate = this._dates[this._dates.length - 1] ?? null;
  }

  static load(file = DEFAULT_RATE_FILE) {
    const text = readFileSync(file, 'utf8');
    const obs = new Map();
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
      const [date, raw] = line.split(',');
      const value = Number.parseFloat((raw ?? '').trim());
      // Blank values are holidays; skip them rather than storing NaN. They are then
      // indistinguishable from any other unpublished day, which is exactly right —
      // the carry-forward rule does not care *why* a day has no rate.
      if (date && Number.isFinite(value)) obs.set(date.trim(), value);
    }
    if (obs.size === 0) throw new Error(`No observations parsed from ${file}`);
    return new FxRateTable(obs, file);
  }

  /**
   * The published rate for a date, carrying the prior business day forward.
   *
   * @param {string} isoDate  'YYYY-MM-DD'
   * @returns {ResolvedRate|null} null when the date is outside the published range —
   *          see the header for why that is deliberately not carried.
   */
  resolve(isoDate) {
    if (!isoDate || !this.lastDate) return null;
    if (isoDate > this.lastDate) return null;   // UNPUBLISHED — never carry forward
    if (isoDate < this.firstDate) return null;  // series too short for the question

    const exact = this._obs.get(isoDate);
    if (exact != null) return { usdPerAud: exact, quotedDate: isoDate, carriedFrom: null };

    // HOLIDAY — binary search for the latest published date strictly before this one.
    let lo = 0;
    let hi = this._dates.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this._dates[mid] <= isoDate) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0) return null;
    const quotedDate = this._dates[best];
    return { usdPerAud: this._obs.get(quotedDate), quotedDate, carriedFrom: quotedDate };
  }
}

/** USD per AUD -> AUD per USD, the engine's convention. Named so a swap is visible. */
export function toAudPerUsd(usdPerAud) {
  return usdPerAud > 0 ? 1 / usdPerAud : null;
}

/** Foreign units -> USD at a published rate. AUD × (USD per AUD) = USD. */
export function audToUsd(aud, usdPerAud) {
  return aud * usdPerAud;
}
