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
 * Which years the historical bootstrap draws from (design 133 §3).
 *
 * The ONE rule for the window, read by the toolset when it builds the equity handler and by
 * anything that has to say which window a run uses (the Monte Carlo panel's return-paths
 * line, design 133 phase 1). Before this module the rule lived inline in the toolset, so
 * nothing outside the compile could see that the default Monte Carlo samples 1951–2023.
 *
 * Blank `equityReturnBootstrapFromYear` keeps the automatic window: POSTWAR when joint inflation
 * is on (design 103 §5.1, so equity, inflation and the 10-year yield share a monetary era),
 * otherwise FULL. A year Y (design 133 phase 2) samples Y–2023, with two rules (§3.2):
 *   - at least MIN_BOOTSTRAP_WINDOW_YEARS years, so Y ≤ 1974 (§11 Q2), else it throws;
 *   - under joint inflation, never before 1951: the inflation and yield history starts there,
 *     and a pre-1951 year would silently draw Gaussian inflation. It clamps, with a warning.
 */

import { HISTORICAL_EQUITY_RETURNS }    from './historical-equity-returns.js';
import { jointInflationActive, HISTORICAL_JOINT_WINDOW } from './inflation-tick-handler.js';

/** The last historical year in the bundled series (every window ends here). */
export const HISTORICAL_LAST_YEAR = HISTORICAL_EQUITY_RETURNS.firstYear + HISTORICAL_EQUITY_RETURNS.returns.length - 1;

/** The first year of the series (the earliest a window can start). */
export const HISTORICAL_FIRST_YEAR = HISTORICAL_EQUITY_RETURNS.firstYear;

/** The shortest window a run may sample (design 133 §11 Q2). */
export const MIN_BOOTSTRAP_WINDOW_YEARS = 50;

/** The latest first year a window may have: 1974, given data to 2023. */
export const LATEST_BOOTSTRAP_FROM = HISTORICAL_LAST_YEAR - MIN_BOOTSTRAP_WINDOW_YEARS + 1;

/** The first year joint inflation has history for (1951). */
export const JOINT_FIRST_YEAR = HISTORICAL_JOINT_WINDOW.firstYear;

/**
 * The authored first year, validated, or null when blank (the automatic window).
 *
 * @param {object} p  params
 * @returns {number|null}
 * @throws when the year is not a whole year from 1871 to 1974
 */
export function authoredBootstrapFrom(p) {
  const v = p?.equityReturnBootstrapFromYear;
  if (v == null || v === '') return null;
  const y = Number(v);
  if (!Number.isInteger(y) || y < HISTORICAL_FIRST_YEAR || y > LATEST_BOOTSTRAP_FROM) {
    throw new Error(`Historical Bootstrap — Sample From Year: ${v} is not allowed. Use a whole year from `
      + `${HISTORICAL_FIRST_YEAR} to ${LATEST_BOOTSTRAP_FROM}: a window needs at least `
      + `${MIN_BOOTSTRAP_WINDOW_YEARS} years of history, which ends in ${HISTORICAL_LAST_YEAR} (design 133).`);
  }
  return y;
}

/**
 * True when a run with these params replays the historical bootstrap at all.
 *
 * @param {object} p  resolved params (an MC path's after `applyMcPaths`)
 * @returns {boolean}
 */
export function bootstrapActive(p) {
  return !!p?.equityReturnStochastic && p.equityReturnModel === 'HISTORICAL_BOOTSTRAP';
}

/**
 * The first year the run actually samples from, and whether joint inflation clamped it.
 *
 * @param {object} p  resolved params
 * @returns {{ fromYear: number, authored: number|null, clamped: boolean }}
 */
function _resolve(p) {
  const authored = authoredBootstrapFrom(p);
  const joint    = jointInflationActive(p);
  if (authored == null) {
    return { fromYear: joint ? JOINT_FIRST_YEAR : HISTORICAL_FIRST_YEAR, authored, clamped: false };
  }
  const clamped = joint && authored < JOINT_FIRST_YEAR;
  return { fromYear: clamped ? JOINT_FIRST_YEAR : authored, authored, clamped };
}

/**
 * The window the equity handler is built with: 'FULL' or 'POSTWAR' when the window is one
 * of those (always, when the year is blank), else the first year. Returned even when the
 * bootstrap is off, because the handler takes a window either way and only reads it under
 * the bootstrap. Throws on a year outside 1871–1974, but only when the bootstrap runs.
 *
 * @param {object} p  resolved params
 * @returns {'FULL'|'POSTWAR'|number}
 */
export function bootstrapWindowName(p) {
  // Not replaying: the handler never reads the window, so a stale year must not fail the run.
  if (!bootstrapActive(p)) return jointInflationActive(p) ? 'POSTWAR' : 'FULL';
  const { fromYear } = _resolve(p);
  if (fromYear === HISTORICAL_FIRST_YEAR) return 'FULL';
  if (fromYear === JOINT_FIRST_YEAR)      return 'POSTWAR';
  return fromYear;
}

/**
 * What a reader should be told about the window, or null: today only the joint-mode clamp.
 *
 * @param {object} p  resolved params
 * @returns {string|null}
 */
export function bootstrapWindowWarning(p) {
  if (!bootstrapActive(p)) return null;
  const { authored, clamped } = _resolve(p);
  return clamped
    ? `Historical Bootstrap — Sample From Year ${authored} runs from ${JOINT_FIRST_YEAR}: inflation is `
      + `replaying history jointly with equity, and its records start in ${JOINT_FIRST_YEAR}. `
      + 'Set the inflation process to Gaussian to sample earlier years (design 133).'
    : null;
}

/**
 * The window a run with these params samples, for display, or null when the bootstrap is
 * not the active process.
 *
 * @param {object} p  resolved params
 * @returns {{ name: 'FULL'|'POSTWAR'|number, fromYear: number, toYear: number,
 *             automatic: boolean, reason: string }|null}
 */
export function describeBootstrapWindow(p) {
  if (!bootstrapActive(p)) return null;
  const name = bootstrapWindowName(p);
  const { fromYear, authored, clamped } = _resolve(p);
  const automatic = authored == null;
  return {
    name,
    fromYear,
    toYear:    HISTORICAL_LAST_YEAR,
    automatic,
    reason:    automatic
      ? (name === 'POSTWAR' ? 'joint inflation' : 'no joint inflation')
      : (clamped ? `set to ${authored}; joint inflation starts in ${JOINT_FIRST_YEAR}` : 'set'),
  };
}

// ─── the pinned start (design 133 §4) ────────────────────────────────────────────

/**
 * The authored pinned run, validated, or null when no start year is set.
 *
 * `equityReturnBootstrapStartYear` is any year of the series (1871–2023). It is not bound by
 * the window or its 50-year floor: the user named the year. `equityReturnBootstrapStartRun`
 * is how many years replay in order from it (blank = through 2023), capped at the series' end.
 *
 * @param {object} p  params
 * @returns {{ startYear: number, years: number, toYear: number }|null}
 * @throws on a start year outside the series, or a run that is not a whole number ≥ 1
 */
export function authoredBootstrapStart(p) {
  const v = p?.equityReturnBootstrapStartYear;
  if (v == null || v === '') return null;
  const y = Number(v);
  if (!Number.isInteger(y) || y < HISTORICAL_FIRST_YEAR || y > HISTORICAL_LAST_YEAR) {
    throw new Error(`Historical Bootstrap — Start Year: ${v} is not allowed. Use a whole year from `
      + `${HISTORICAL_FIRST_YEAR} to ${HISTORICAL_LAST_YEAR}, the years the history covers (design 133).`);
  }
  const maxYears = HISTORICAL_LAST_YEAR - y + 1;
  const r = p?.equityReturnBootstrapStartRun;
  let years = maxYears;
  if (r != null && r !== '') {
    const k = Number(r);
    if (!Number.isInteger(k) || k < 1) {
      throw new Error(`Historical Bootstrap — Start Run: ${r} is not allowed. Use a whole number of years, `
        + '1 or more, or leave it blank to replay through to the end of the history (design 133).');
    }
    years = Math.min(k, maxYears);
  }
  return { startYear: y, years, toYear: y + years - 1 };
}

/**
 * The pinned run the equity handler is built with (`{ startYear, years }`), or null. Null off
 * the bootstrap, so a stale start year never fails a run that does not replay history.
 *
 * @param {object} p  resolved params
 * @returns {{ startYear: number, years: number }|null}
 */
export function bootstrapPinnedRun(p) {
  if (!bootstrapActive(p)) return null;
  const a = authoredBootstrapStart(p);
  return a ? { startYear: a.startYear, years: a.years } : null;
}

/**
 * The pinned run for display, or null.
 *
 * @param {object} p  resolved params
 * @returns {{ startYear: number, toYear: number, years: number }|null}
 */
export function describeBootstrapStart(p) {
  if (!bootstrapActive(p)) return null;
  return authoredBootstrapStart(p);
}

/**
 * The warning a pinned run needs, or null: under joint inflation, years before 1951 have no
 * inflation or yield history, so those years draw inflation at random (§4.1). Allowed,
 * because the user picked the year by name; said once.
 *
 * @param {object} p  resolved params
 * @returns {string|null}
 */
export function bootstrapStartWarning(p) {
  if (!bootstrapActive(p) || !jointInflationActive(p)) return null;
  const a = authoredBootstrapStart(p);
  if (!a || a.startYear >= JOINT_FIRST_YEAR) return null;
  const last = Math.min(a.toYear, JOINT_FIRST_YEAR - 1);
  const span = last === a.startYear ? `${last} has` : `${a.startYear}–${last} have`;
  return `Historical Bootstrap — Start Year ${a.startYear}: ${span} no inflation history, `
    + `so inflation is drawn at random for those years; it replays history from ${JOINT_FIRST_YEAR} (design 133).`;
}
