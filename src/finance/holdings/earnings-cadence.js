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
 * How often equity growth and dividends are credited (design 127).
 *
 *   ANNUAL  — one growth event and one dividend event a year, on 31 Dec, each crediting the
 *             balance on that day × the annual rate. The pre-127 model, kept byte-identical.
 *   MONTHLY — growth at every month-end and dividends at every quarter-end, each at the
 *             period rate of the same annual rate, so money is credited for the months it
 *             was actually invested (§1).
 *
 * The year's rate is still decided once a year (design 74's tick); MONTHLY only spreads its
 * crediting. A handler learns its cadence from its event's `data.periodsPerYear`, as the
 * coupon handlers learn `firingsPerYear`, so a saved plan's queue carries it and no handler
 * state has to.
 */

export const EQUITY_EARNINGS_CADENCES = Object.freeze(['ANNUAL', 'MONTHLY']);

/** Phase 1 lands at ANNUAL; design 127 §6 phase 4 switches it. */
export const DEFAULT_EQUITY_EARNINGS_CADENCE = 'ANNUAL';

/**
 * Same-date order of the MONTHLY growth and dividend series (§4.5).
 *
 * Under ANNUAL the 31 Dec earnings and dividend events are year-end series, whose 31 Dec
 * instance was queued a year earlier, so FIFO runs them before every month-end event of that
 * day and before the RMDs (which read the post-growth balance). A month-end series' 31 Dec
 * instance is queued on 30 Nov, after the year-end ones, so FIFO would flip both. An explicit
 * band keeps ANNUAL's sequence: growth, then dividends on the grown value, then everything
 * else at order 0. Both sit after `PERIOD_ADVANCE_ORDER` (−1).
 */
export const MONTHLY_GROWTH_ORDER   = -0.5;
export const MONTHLY_DIVIDEND_ORDER = -0.4;

/** Months between dividend payments under MONTHLY: quarter-ends (§3.1). */
export const DIVIDENDS_PER_YEAR = 4;

/** The cadence a parameter bag asks for. */
export function equityEarningsCadence(params) {
  const c = params?.equityEarningsCadence ?? DEFAULT_EQUITY_EARNINGS_CADENCE;
  if (!EQUITY_EARNINGS_CADENCES.includes(c)) {
    throw new Error(`equityEarningsCadence must be one of ${EQUITY_EARNINGS_CADENCES.join(', ')}, got '${c}'.`);
  }
  return c;
}

/** True when the plan credits equity monthly. */
export function isMonthlyEarnings(params) {
  return equityEarningsCadence(params) === 'MONTHLY';
}

/**
 * The schedule settings for the growth and dividend series. ANNUAL returns exactly what the
 * toolsets built before design 127 (a year-end interval, no order, no data), so its queue is
 * unchanged.
 *
 * @returns {{ growth: { interval: string, order?: number, data?: object },
 *             dividend: { interval: string, order?: number, data?: object } }}
 */
export function earningsSchedule(params) {
  if (!isMonthlyEarnings(params)) {
    return { growth: { interval: 'year-end' }, dividend: { interval: 'year-end' } };
  }
  return {
    growth:   { interval: 'month-end',   order: MONTHLY_GROWTH_ORDER,   data: { periodsPerYear: 12 } },
    dividend: { interval: 'quarter-end', order: MONTHLY_DIVIDEND_ORDER, data: { periodsPerYear: DIVIDENDS_PER_YEAR } },
  };
}

/** Apply `earningsSchedule`'s settings to an `EventBuilder` series. */
export function withEarningsCadence(builder, settings) {
  let b = builder.interval(settings.interval);
  if (settings.order != null) b = b.order(settings.order);
  if (settings.data != null)  b = b.data(settings.data);
  return b;
}

/**
 * The rate for one of `n` equal periods of a year that compounds to `annual` (§3.2):
 * `(1 + annual)^(1/n) − 1`. `n = 1` returns `annual` untouched, so the ANNUAL path's
 * arithmetic is the same to the bit.
 *
 * Floored at −1 (§3.3): a lot can lose all of its value and no more. The power of a negative
 * base is NaN, so without the floor a stacked crash drag below −100% would poison the
 * balance rather than empty it.
 */
export function periodRate(annual, n = 1) {
  if (n === 1) return annual;
  if (annual <= -1) return -1;
  return Math.pow(1 + annual, 1 / n) - 1;
}

/**
 * The price half of a total return when the yield is paid separately, multiplicatively
 * (§3.2): `(1 + total) = (1 + price)(1 + yield)`, so a lot whose dividends are reinvested
 * through the year ends it at exactly `1 + total`. Rounded to 12 places like `priceOf`.
 */
export function multiplicativePrice(total, yld) {
  return +((1 + total) / (1 + yld) - 1).toFixed(12);
}

/** Is `date` a quarter-end month's last day (31 Mar, 30 Jun, 30 Sep, 31 Dec)? */
export function isQuarterEnd(date) {
  if (date == null) return false;
  const d = new Date(date);
  const m = d.getUTCMonth();
  if (m % 3 !== 2) return false;
  return d.getUTCDate() === new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
}
