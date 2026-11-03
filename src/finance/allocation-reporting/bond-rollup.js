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
 * Roll the plan's BOND lots up by bond TYPE, then account, then lot — design 130 §3.
 *
 * ### Why not the cube, and why not the security rollup
 *
 * The allocation cube buckets by `(allocation, rateKey, securityId)`, which is exactly what
 * folds a ladder's rungs into one BOND row; the rungs are the thing this view is for. And
 * `security-rollup.js` only sees rows that name an instrument, which no ladder rung or bond
 * fund lot does. The facts that make a bond a TIPS or a muni (`inflationLinked`,
 * `taxExemption`, `issuingState`) live on the lot, read through `instrumentOf`.
 *
 * So this walks the lots itself — and is held to the cube by a test, not by a comment: per
 * account, Σ market value here equals the cube's BOND holding rows (design 130 §3.2). It
 * walks the cube's own account set (`isCubeAccount`) and converts with the cube's own FX
 * helper, so the two can only drift by rounding.
 *
 * ### The type is the coupon's TAX treatment, read by the tax code's own functions
 *
 * `couponFederalExempt` / `couponStateExempt` and `primaryResidencyState` are what the
 * coupon tax calls, so a label cannot say "state-exempt" about a coupon the run taxes.
 * A move that changes the residency state changes the label on the same day it changes
 * the tax. A bond FUND is not a type — a muni fund is a muni — it is a lot with no
 * maturity and therefore no principal.
 */

import { ALLOCATION }              from '../holdings/allocation.js';
import { instrumentOf, redemptionValue } from '../holdings/holding-utils.js';
import { couponFederalExempt, couponStateExempt } from '../holdings/holdings-earnings.js';
import { primaryResidencyState }   from '../residency-utils.js';
import { yearsToMaturity }         from '../economic-regimes/couponless-yield.js';
import { RATE_KEY_META }           from '../economic-regimes/rate-keys.js';
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { exposureCountryForRateKey } from './asset-class.js';
import { isCubeAccount }           from './allocation-cube.js';

const _round = n => +(Number(n) || 0).toFixed(2);

/** A lot drained to this or less holds nothing — the maturity reducer's own threshold. */
const DRAINED = 0.005;

/**
 * Bond types, in display order. A fixed order rather than largest-first, so a type keeps
 * its place (and its chart colour) as the run moves money between types.
 */
export const BOND_TYPE = Object.freeze({
  TIPS:                'TIPS',
  TREASURY:            'TREASURY',
  MUNI_STATE_EXEMPT:   'MUNI_STATE_EXEMPT',
  MUNI_STATE_TAXABLE:  'MUNI_STATE_TAXABLE',
  MUNI:                'MUNI',
  TAXABLE:             'TAXABLE',
  AU_INFLATION_LINKED: 'AU_INFLATION_LINKED',
  AU_NOMINAL:          'AU_NOMINAL',
});

export const BOND_TYPE_LABEL = Object.freeze({
  [BOND_TYPE.TIPS]:                'TIPS',
  [BOND_TYPE.TREASURY]:            'Treasury',
  [BOND_TYPE.MUNI_STATE_EXEMPT]:   'Muni — state-exempt',
  [BOND_TYPE.MUNI_STATE_TAXABLE]:  'Muni — state-taxable',
  [BOND_TYPE.MUNI]:                'Muni',
  [BOND_TYPE.TAXABLE]:             'Taxable',
  [BOND_TYPE.AU_INFLATION_LINKED]: 'AU inflation-linked',
  [BOND_TYPE.AU_NOMINAL]:          'AU nominal',
});

const TYPE_ORDER = Object.values(BOND_TYPE);

/**
 * The one type a bond lot is, first match wins (design 130 §3.3).
 *
 * The market decides the country: US exemptions are never read off an AU-market lot (the
 * caller reports one that carries an exemption, §8 Q1). With no US state residence the
 * in-state question has no answer worth printing, so a muni is just a muni (§8 Q2).
 *
 * @param {object} inst             the lot's instrument view (`instrumentOf`)
 * @param {'US'|'AU'} country
 * @param {string|null} residentState
 * @returns {string} a BOND_TYPE
 */
export function bondTypeOf(inst, country, residentState) {
  if (country === 'AU') return inst?.inflationLinked ? BOND_TYPE.AU_INFLATION_LINKED : BOND_TYPE.AU_NOMINAL;
  if (inst?.inflationLinked) return BOND_TYPE.TIPS;
  if (couponFederalExempt(inst)) {
    if (residentState == null) return BOND_TYPE.MUNI;
    return couponStateExempt(inst, residentState) ? BOND_TYPE.MUNI_STATE_EXEMPT : BOND_TYPE.MUNI_STATE_TAXABLE;
  }
  if (inst?.taxExemption === 'state') return BOND_TYPE.TREASURY;
  return BOND_TYPE.TAXABLE;
}

/**
 * @typedef {object} BondLotRow
 * @property {string}  id
 * @property {string}  label
 * @property {string}  stateKey
 * @property {string}  type          a BOND_TYPE
 * @property {number|null} maturityMs null ⇒ a fund
 * @property {boolean} rolls         rolls into a fresh rung at maturity
 * @property {number|null} rollTermYears
 * @property {boolean} zeroCoupon
 * @property {boolean} inflationLinked
 * @property {number|null} principal  base currency; what it redeems for today; null for a fund
 * @property {number}  marketValue    base currency
 * @property {number|null} costBasis  base currency
 * @property {number|null} couponRate real for an inflation-linked lot; 0 for a zero
 * @property {number|null} duration   effective: min(static, years to maturity)
 */

/**
 * @typedef {object} BondGroupRow  a type, or an account within a type
 * @property {number|null} principal  Σ over DATED lots; null when none is dated
 * @property {boolean} principalCoversAll false when a fund contributes market value but no principal
 * @property {number}  marketValue
 * @property {number|null} costBasis  null when any lot carries none
 * @property {number|null} unrealized
 * @property {number|null} couponRate weighted by principal (market value for a fund)
 * @property {boolean} couponReal     every couponed lot is inflation-linked
 * @property {number|null} duration   weighted by market value
 * @property {number|null} nextMaturityMs
 * @property {number}  lotCount
 * @property {number}  share          of the total bond market value (0..1)
 */

/**
 * @param {object} state
 * @param {object} [opts]
 * @param {Date}   [opts.date]               the as-of date (durations, next maturity)
 * @param {string} [opts.baseCurrency='USD']
 * @param {(stateKey: string) => string|null} [opts.displayNameFor]
 * @returns {{ types: Array<BondGroupRow & {type:string,label:string,country:string,
 *            accounts: Array<BondGroupRow & {stateKey:string,name:string,lots:BondLotRow[]}>}>,
 *            lots: BondLotRow[], total: BondGroupRow, warnings: object[] }}
 */
export function rollupBonds(state, { date = null, baseCurrency = 'USD', displayNameFor = null } = {}) {
  const empty = { types: [], lots: [], total: _combine([], 0), warnings: [] };
  if (!state || typeof state !== 'object') return empty;

  const asOfMs        = date ? new Date(date).getTime() : null;
  const securities    = state.securities ?? null;
  const residentState = primaryResidencyState(state);
  const nameOf = (k) => { try { return displayNameFor?.(k) || k; } catch { return k; } };

  const lots     = [];
  const warnings = [];

  for (const [stateKey, entry] of Object.entries(state)) {
    if (!isCubeAccount(entry) || !Array.isArray(entry.holdings)) continue;
    const currency = currencyOf(entry, baseCurrency);
    const toBase   = (n) => Number(toBaseCurrency(n, currency, baseCurrency, state)) || 0;

    for (const h of entry.holdings) {
      if (h?.allocation !== ALLOCATION.BOND) continue;
      const mvLocal = Number(h.marketValue) || 0;
      if (mvLocal <= DRAINED) continue;

      const inst    = instrumentOf(h, securities);
      const country = exposureCountryForRateKey(inst.rateKey) ?? entry.country ?? 'US';
      const te      = inst.taxExemption ?? 'none';
      if (country === 'AU' && te !== 'none') {
        warnings.push({ kind: 'AU_LOT_US_EXEMPTION', stateKey, name: nameOf(stateKey),
          lotId: h.id ?? null, label: h.label ?? null, taxExemption: te });
      }

      const dated = inst.maturityDate != null;
      const ttm   = yearsToMaturity(inst, asOfMs);
      const staticDuration = inst.duration ?? RATE_KEY_META[inst.rateKey]?.defaultDuration ?? null;
      const duration = staticDuration == null ? null
        : (ttm != null ? Math.min(staticDuration, ttm) : staticDuration);
      const maturityMs = dated
        ? (inst.maturityDate instanceof Date ? inst.maturityDate.getTime() : new Date(inst.maturityDate).getTime())
        : null;

      lots.push({
        id:              h.id ?? null,
        label:           h.label ?? h.id ?? 'Bond',
        stateKey,
        name:            nameOf(stateKey),
        type:            bondTypeOf(inst, country, residentState),
        country,
        maturityMs:      Number.isFinite(maturityMs) ? maturityMs : null,
        rolls:           dated && h.rollAtMaturity === true,
        rollTermYears:   dated && h.rollAtMaturity === true ? (h.rollTermYears ?? null) : null,
        zeroCoupon:      inst.zeroCoupon === true,
        inflationLinked: inst.inflationLinked === true,
        principal:       dated ? _round(toBase(redemptionValue(h, securities))) : null,
        marketValue:     _round(toBase(mvLocal)),
        costBasis:       typeof h.costBasis === 'number' ? _round(toBase(h.costBasis)) : null,
        couponRate:      inst.zeroCoupon === true ? 0 : (inst.couponRate ?? null),
        duration:        duration == null ? null : +duration.toFixed(4),
      });
    }
  }

  const grandMv = lots.reduce((s, l) => s + l.marketValue, 0);

  const byType = new Map();
  for (const l of lots) {
    if (!byType.has(l.type)) byType.set(l.type, []);
    byType.get(l.type).push(l);
  }

  const types = [...byType.entries()]
    .sort(([a], [b]) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
    .map(([type, typeLots]) => {
      const byAccount = new Map();
      for (const l of typeLots) {
        if (!byAccount.has(l.stateKey)) byAccount.set(l.stateKey, []);
        byAccount.get(l.stateKey).push(l);
      }
      const accounts = [...byAccount.entries()]
        .map(([stateKey, acctLots]) => ({
          stateKey,
          name: acctLots[0].name,
          ..._combine(acctLots, grandMv),
          lots: [...acctLots].sort(_byMaturity),
        }))
        .sort((a, b) => b.marketValue - a.marketValue || a.stateKey.localeCompare(b.stateKey));
      return {
        type,
        label:   BOND_TYPE_LABEL[type] ?? type,
        country: typeLots[0].country,
        ..._combine(typeLots, grandMv),
        accounts,
      };
    });

  return { types, lots, total: _combine(lots, grandMv), warnings };
}

/** Dated lots by maturity, soonest first; funds after them, by id. */
function _byMaturity(a, b) {
  if (a.maturityMs == null && b.maturityMs == null) return String(a.id).localeCompare(String(b.id));
  if (a.maturityMs == null) return 1;
  if (b.maturityMs == null) return -1;
  return a.maturityMs - b.maturityMs || String(a.id).localeCompare(String(b.id));
}

/**
 * One group's figures from its lots. The null rule is `security-rollup.js`'s — a partial
 * sum is an undercount presented as a total — with the one exception design 130 §3.4
 * makes: a fund has no principal BY DEFINITION, so principal sums the dated lots and says
 * so through `principalCoversAll` rather than going null for the whole group.
 */
function _combine(lots, grandMv) {
  let mv = 0, cb = 0, allBased = true;
  let principal = 0, anyDated = false, allDated = true;
  let cW = 0, cSum = 0, allReal = true, anyCoupon = false;
  let dW = 0, dSum = 0;
  let next = null;
  for (const l of lots) {
    mv += l.marketValue;
    if (l.costBasis == null) allBased = false; else cb += l.costBasis;
    if (l.principal == null) allDated = false; else { principal += l.principal; anyDated = true; }
    if (l.couponRate != null) {
      const w = l.principal ?? l.marketValue;
      cW += w; cSum += w * l.couponRate; anyCoupon = true;
      if (!l.inflationLinked) allReal = false;
    }
    if (l.duration != null) { dW += l.marketValue; dSum += l.marketValue * l.duration; }
    if (l.maturityMs != null && (next == null || l.maturityMs < next)) next = l.maturityMs;
  }
  const costBasis = allBased && lots.length ? _round(cb) : null;
  return {
    principal:          anyDated ? _round(principal) : null,
    principalCoversAll: allDated,
    marketValue:        _round(mv),
    costBasis,
    unrealized:         costBasis == null ? null : _round(mv - costBasis),
    couponRate:         anyCoupon && cW > 0 ? +(cSum / cW).toFixed(6) : null,
    couponReal:         anyCoupon && allReal,
    duration:           dW > 0 ? +(dSum / dW).toFixed(4) : null,
    nextMaturityMs:     next,
    lotCount:           lots.length,
    share:              grandMv > 0 ? mv / grandMv : 0,
  };
}

/**
 * The maturity ladder (design 130 §5): principal maturing per calendar year, stacked.
 *
 * Every year from the as-of year to the last maturity is present, empty or not — a gap in
 * a ladder is the thing a ladder chart exists to show. Rolling and spend-down principal
 * are separate series under one key, so the chart can draw them differently: one replaces
 * itself at maturity, the other turns into cash.
 *
 * @param {BondLotRow[]} lots  `rollupBonds(...).lots`
 * @param {object} [opts]
 * @param {'account'|'type'} [opts.by='account']
 * @param {Date}   [opts.date]  the as-of date; its UTC year is the first column
 * @returns {{ years: number[], series: Array<{key:string,label:string,rolls:boolean,values:number[]}>,
 *            undated: number, dated: number }}
 */
export function buildMaturityLadder(lots, { by = 'account', date = null } = {}) {
  const dated   = (lots ?? []).filter(l => l.maturityMs != null && l.principal != null);
  const undated = _round((lots ?? []).filter(l => l.maturityMs == null).reduce((s, l) => s + l.marketValue, 0));
  if (!dated.length) return { years: [], series: [], undated, dated: 0 };

  const yearOf = ms => new Date(ms).getUTCFullYear();
  const first  = date ? new Date(date).getUTCFullYear() : Math.min(...dated.map(l => yearOf(l.maturityMs)));
  // A matured lot not yet redeemed (between its date and the next pass) belongs in the
  // first column, not before the axis — hence the clamp here and in the index below.
  const lastYear = Math.max(first, ...dated.map(l => yearOf(l.maturityMs)));
  const years = [];
  for (let y = first; y <= lastYear; y++) years.push(y);

  const keyOf   = l => (by === 'type' ? l.type : l.stateKey);
  const labelOf = l => (by === 'type' ? (BOND_TYPE_LABEL[l.type] ?? l.type) : l.name);
  const groups  = new Map();
  for (const l of dated) {
    const id = `${keyOf(l)}\u0000${l.rolls ? 1 : 0}`;
    let g = groups.get(id);
    if (!g) {
      g = { key: keyOf(l), label: labelOf(l), rolls: l.rolls, values: years.map(() => 0) };
      groups.set(id, g);
    }
    const i = Math.max(0, yearOf(l.maturityMs) - first);
    g.values[i] += l.principal;
  }
  const series = [...groups.values()].map(g => ({ ...g, values: g.values.map(_round) }));
  const order  = by === 'type' ? (k => TYPE_ORDER.indexOf(k)) : null;
  series.sort((a, b) =>
    (order ? order(a.key) - order(b.key) : a.label.localeCompare(b.label))
    || String(a.key).localeCompare(String(b.key))
    || (a.rolls === b.rolls ? 0 : a.rolls ? 1 : -1));
  return { years, series, undated, dated: _round(dated.reduce((s, l) => s + l.principal, 0)) };
}
