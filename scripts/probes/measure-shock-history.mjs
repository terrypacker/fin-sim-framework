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
 * measure-shock-history — derive the empirical numbers behind SHOCK_LIBRARY.
 *
 *   node scripts/probes/measure-shock-history.mjs            # print
 *   node scripts/probes/measure-shock-history.mjs --write     # rewrite MEASUREMENTS.md
 *
 * Reads ONLY the CSVs in docs/economic-shocks/data (pulled by that directory's
 * fetch-sources.sh) and reduces them to the handful of statistics a shock preset
 * actually needs: level break, grind duration, time to prior peak, dividend cut,
 * inflation path, policy-rate move, per-tenor curve twist, FX drift and FX vol.
 *
 * The point is that no figure in the shock library or in
 * docs/economic-shocks/README.md is quoted from memory — every one of them is
 * printed by this file from a source on disk.
 */
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'docs/economic-shocks/data');

// ── series loading ────────────────────────────────────────────────────────────

/** Load a FRED CSV as a sorted [{ date: 'YYYY-MM-DD', v: number }] with blanks dropped. */
function fred(id) {
  const file = path.join(DATA, `FRED-${id}.csv`);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1);
  return rows
    .map(l => { const [d, v] = l.split(','); return { date: d, v: v?.trim() === '' ? NaN : Number(v) }; })
    .filter(r => Number.isFinite(r.v) && r.v !== 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Load a column of the Shiller monthly workbook (docs/economic-shocks/shiller-to-csv.py).
 * This is the only free long-history source for the S&P 500 DIVIDEND series, which is
 * what `dividendAdjustment` is calibrated against.
 */
function shiller(column) {
  const file = path.join(DATA, 'Shiller-SP500-monthly.csv');
  // Python's csv writer emits CRLF, so strip the \r before splitting fields.
  const lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').trim().split('\n');
  const cols  = lines[0].split(',');
  const idx   = cols.indexOf(column);
  if (idx < 0) throw new Error(`no column ${column} in ${cols}`);
  return lines.slice(1)
    .map(l => { const f = l.split(','); return { date: f[0], v: f[idx]?.trim() === '' ? NaN : Number(f[idx]) }; })
    .filter(r => Number.isFinite(r.v))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const between = (s, from, to) => s.filter(r => r.date >= from && r.date <= to);
const at      = (s, d) => { const c = s.filter(r => r.date <= d); return c.length ? c[c.length - 1] : null; };
const months  = (a, b) => (new Date(b).getFullYear() - new Date(a).getFullYear()) * 12
                        + (new Date(b).getMonth()   - new Date(a).getMonth());

const pct = (x, dp = 1) => `${(x * 100).toFixed(dp)} %`;
const pp  = (x, dp = 2) => `${(x >= 0 ? '+' : '')}${x.toFixed(dp)} pp`;

// ── measurements ──────────────────────────────────────────────────────────────

/**
 * Peak-to-trough drawdown inside a window, plus how long the grind took and how
 * long the index needed to regain the peak (searched to the end of the series).
 */
function drawdown(series, from, to) {
  const win = between(series, from, to);
  if (!win.length) return null;
  // Running-peak maximum drawdown. Taking the window's global max and then its
  // minimum silently returns 0 whenever the index ends the window at a new high
  // (COVID measured to end-2020 does exactly that).
  let peak = win[0], best = null, runPeak = win[0];
  for (const r of win) {
    if (r.v > runPeak.v) runPeak = r;
    const dd = r.v / runPeak.v - 1;
    if (best == null || dd < best.dd) best = { dd, peak: runPeak, trough: r };
  }
  peak = best.peak;
  const trough = best.trough;
  const recover = series.find(r => r.date > peak.date && r.v >= peak.v);
  return {
    peakDate: peak.date, peakValue: peak.v,
    troughDate: trough.date, troughValue: trough.v,
    depth: trough.v / peak.v - 1,
    grindMonths: months(peak.date, trough.date),
    recoverDate: recover?.date ?? null,
    recoverMonths: recover ? months(peak.date, recover.date) : null,
  };
}

/** Total return of a price index between two dates (price only — no dividends). */
function priceChange(series, from, to) {
  const a = at(series, from), b = at(series, to);
  return a && b ? b.v / a.v - 1 : null;
}

/** Year-over-year inflation from a monthly CPI level series. */
function yoy(series, date) {
  const now = at(series, date);
  const prior = at(series, `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`);
  return now && prior ? now.v / prior.v - 1 : null;
}

/** Rate level at two dates, and the move between them, in percentage points. */
function rateMove(series, from, to) {
  const a = at(series, from), b = at(series, to);
  return a && b ? { from: a.v, to: b.v, move: b.v - a.v, fromDate: a.date, toDate: b.date } : null;
}

/**
 * Per-tenor yield move between two dates, and the same move re-stated as a TWIST:
 * each tenor's change minus the 5-year change. That second form is the one the
 * library's `yieldCurveTwist` is written in — the design anchors the twist at the
 * 5-year point (spread 0) and layers it on top of a level move.
 */
function curveMove(from, to) {
  const tenors = [1, 2, 5, 10, 30];
  const moves = {};
  for (const t of tenors) {
    const m = rateMove(fred(`DGS${t}`), from, to);
    if (m) moves[t] = m;
  }
  const anchor = moves[5]?.move ?? 0;
  return { level: anchor, moves, twist: Object.fromEntries(
    Object.entries(moves).map(([t, m]) => [t, m.move - anchor])) };
}

/** Annualized realized volatility of daily log returns, from daily observations. */
function realizedVol(series, from, to) {
  const win = between(series, from, to);
  if (win.length < 20) return null;
  const rets = [];
  for (let i = 1; i < win.length; i++) rets.push(Math.log(win[i].v / win[i - 1].v));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(252);
}

// ── episode definitions ───────────────────────────────────────────────────────

const EPISODES = [
  { key: 'DOTCOM',      label: 'Dot-com bust',      from: '2000-01-01', to: '2003-06-30', preset: 'DOTCOM_2000_LITE' },
  { key: 'LOST_DECADE', label: 'Lost decade',       from: '2000-01-01', to: '2013-12-31', preset: 'LOST_DECADE_2000' },
  { key: 'DEPRESSION',  label: '1929-1932 (context)', from: '1929-01-01', to: '1940-12-31', preset: null },
  { key: 'GFC',         label: 'Global financial crisis', from: '2007-06-01', to: '2009-12-31', preset: 'MARKET_CRASH_2008_LITE' },
  { key: 'COVID',       label: 'Pandemic crash',    from: '2020-01-01', to: '2020-12-31', preset: 'COVID_2020_LITE' },
  { key: 'STAGFLATION', label: 'Stagflation',       from: '1972-12-01', to: '1982-12-31', preset: 'STAGFLATION_1970S_LITE' },
  { key: 'CORRECTION',  label: '2018 correction',   from: '2018-08-01', to: '2019-06-30', preset: 'MILD_CORRECTION' },
];

// ── report ────────────────────────────────────────────────────────────────────

const out = [];
const say = (...a) => out.push(a.join(' '));

const usEq = fred('SPASTT01USM661N');
const auEq = fred('SPASTT01AUM661N');
const nasd = fred('NASDAQCOM');
const cpi  = fred('CPIAUCSL');
const ff   = fred('FEDFUNDS');
const prime = fred('MPRIME');
const au3m = fred('IR3TIB01AUM156N');
const au10 = fred('IRLTLT01AUM156N');
const divs = fred('DIVIDEND');
const spx  = shiller('SP500_price');            // S&P 500, monthly average, 1871-
const spdiv= shiller('SP500_dividend_12m');     // S&P 500 dividend per share, trailing 12 mo
const spre = shiller('real_price');             // S&P 500 deflated by CPI
const sptr = shiller('real_total_return_price'); // S&P 500 real TOTAL return (dividends reinvested)
const fx   = fred('DEXUSAL');   // USD per AUD
const vix  = fred('VIXCLS');
const twd  = fred('TWEXMMTH');   // trade-weighted USD vs major currencies, 1973-2019

say('# Measured history behind the shock library');
say('');
say('Generated by `scripts/probes/measure-shock-history.mjs` from the CSVs in');
say('`docs/economic-shocks/data`. Do not hand-edit — re-run the script.');
say('');
say(`Generated: ${new Date().toISOString().slice(0, 10)}`);
say('');

// 1. Equity depth and duration -------------------------------------------------
say('## 1. Equity: depth, grind, and time back to the prior peak');
say('');
say('Two sources, deliberately. **Shiller** (`Shiller-SP500-monthly.csv`) is the S&P 500 —');
say('the index the popular "−49 %" figures are quoted from — as a monthly AVERAGE, so it');
say('is shallower than the intraday peak-to-trough numbers in press accounts. The **OECD**');
say('indices (`SPASTT01USM661N` / `SPASTT01AUM661N`) are one methodology applied to both');
say('countries, which is what makes the US-vs-AU asymmetry a like-for-like comparison — and');
say('they are BROAD indices, so the US line is shallower than the S&P in a bust concentrated');
say('in large-cap tech. All are PRICE indices: dividends excluded, which is the right basis');
say('for a level effect (the model reinvests dividends separately).');
say('');
say('`depth` is a running-peak maximum drawdown inside the window; `back to peak` searches');
say('to the end of the series, so it can exceed the window.');
say('');
say('| episode | market | peak | trough | depth | peak→trough | back to peak |');
say('|---|---|---|---|---|---|---|');
for (const e of EPISODES) {
  for (const [name, s] of [['S&P 500 (Shiller)', spx], ['S&P 500 real', spre],
                           ['US broad (OECD)', usEq], ['AU broad (OECD)', auEq], ['Nasdaq', nasd]]) {
    const d = drawdown(s, e.from, e.to);
    if (!d) continue;
    say(`| ${e.label} | ${name} | ${d.peakDate} | ${d.troughDate} | ${pct(d.depth)} | `
      + `${d.grindMonths} mo | ${d.recoverMonths != null ? `${d.recoverMonths} mo (${d.recoverDate})` : '—'} |`);
  }
}
say('');

// 2. Lost decade: the flat-decade fact ----------------------------------------
say('## 2. The "lost decade" claim, stated as a number');
say('');
say('| window | S&P 500 | S&P 500 real | US broad | AU broad | US CPI | S&P annualized (real) |');
say('|---|---|---|---|---|---|---|');
for (const [a, b] of [['2000-03-01', '2010-03-01'], ['2000-08-01', '2010-08-01'],
                      ['2000-03-01', '2012-12-01'], ['2000-03-01', '2013-03-01']]) {
  const sp = priceChange(spx, a, b), re = priceChange(spre, a, b);
  const us = priceChange(usEq, a, b), au = priceChange(auEq, a, b);
  const ci = priceChange(cpi, a, b);
  const yrs = months(a, b) / 12;
  say(`| ${a} → ${b} | ${pct(sp)} | ${pct(re)} | ${pct(us)} | ${pct(au)} | ${pct(ci)} `
    + `| ${pct((1 + re) ** (1 / yrs) - 1, 2)}/yr |`);
}
say('');
say('');
say('Those are PRICE returns. Shiller also carries a real TOTAL-return index, so the');
say('dividend contribution is measurable rather than assumed:');
say('');
say('| window | real price | real TOTAL return | dividend contribution |');
say('|---|---|---|---|');
for (const [a, b] of [['2000-03-01', '2010-03-01'], ['2000-03-01', '2012-12-01'],
                      ['2000-03-01', '2013-03-01']]) {
  const pr = priceChange(spre, a, b), tr = priceChange(sptr, a, b);
  const yrs = months(a, b) / 12;
  const prA = (1 + pr) ** (1 / yrs) - 1, trA = (1 + tr) ** (1 / yrs) - 1;
  say(`| ${a} → ${b} | ${pct(pr)} (${pct(prA, 2)}/yr) | ${pct(tr)} (${pct(trA, 2)}/yr) `
    + `| ${pp((trA - prA) * 100)}/yr |`);
}
say('');
say('So the real TOTAL return across 2000-2012 is mildly negative, not merely flat — which');
say('is the point of the preset: a decade in which equity delivered nothing.');
say('');

// 3. Dividends -----------------------------------------------------------------
say('## 3. Dividends — what `dividendAdjustment` is calibrated against');
say('');
say('`dividendAdjustment: -0.40` means *this shock cuts the dividend YIELD by 40 %* — it');
say('multiplies the payout, it is not a percentage-point move. So the number to compare it');
say('to is the peak-to-trough fall in **dividends per share**, not in the yield (which rises');
say('in a crash because the price falls faster than the payout).');
say('');
say('| episode | S&P 500 DPS peak | trough | **cut** | months | BEA aggregate cut |');
say('|---|---|---|---|---|---|');
for (const e of EPISODES) {
  const d = drawdown(spdiv, e.from, e.to);
  const b = drawdown(divs,  e.from, e.to);
  if (!d) continue;
  say(`| ${e.label} | ${d.peakDate} (${d.peakValue.toFixed(2)}) | ${d.troughDate} (${d.troughValue.toFixed(2)}) `
    + `| **${pct(d.depth)}** | ${d.grindMonths} | ${b ? pct(b.depth) : '—'} |`);
}
say('');
say('S&P 500 dividend per share is Shiller\'s series (trailing 12-month, interpolated');
say('monthly), which smooths the trough: a quarterly series bottoms lower. The BEA column');
say('(`DIVIDEND`, net corporate dividend payments) is economy-wide, so it picks up private');
say('and non-index payers; read it as a cross-check on SIGN and RANK, not as a second');
say('estimate of the same quantity.');
say('');

// 4. Inflation -----------------------------------------------------------------
say('## 4. Inflation (US CPI-U, `CPIAUCSL`, YoY)');
say('');
say('| date | US CPI YoY |');
say('|---|---|');
for (const d of ['1972-12-01', '1974-12-01', '1979-12-01', '1980-03-01', '1982-12-01',
                 '2000-03-01', '2001-12-01', '2002-12-01', '2007-12-01', '2009-07-01',
                 '2020-05-01', '2021-12-01', '2022-06-01']) {
  const y = yoy(cpi, d);
  if (y != null) say(`| ${d} | ${pct(y)} |`);
}
const seventies = between(cpi, '1972-01-01', '1982-12-01');
const yoys = seventies.map(r => yoy(cpi, r.date)).filter(Number.isFinite);
say('');
say(`1972-1982 US CPI YoY: mean ${pct(yoys.reduce((s, x) => s + x, 0) / yoys.length)}, `
  + `max ${pct(Math.max(...yoys))}, min ${pct(Math.min(...yoys))}. `
  + `Excess over a 2.5 % baseline: ${pp((yoys.reduce((s, x) => s + x, 0) / yoys.length - 0.025) * 100)}.`);
say('');

// 5. Policy rates --------------------------------------------------------------
say('## 5. Policy and prime rates');
say('');
say('| episode | series | from | to | move |');
say('|---|---|---|---|---|');
const RATE_WINDOWS = [
  ['Dot-com', '2000-12-01', '2003-12-01'],
  ['Lost decade', '2000-12-01', '2010-12-01'],
  ['GFC', '2007-08-01', '2009-06-01'],
  ['COVID', '2020-02-01', '2020-06-01'],
  ['Stagflation', '1972-12-01', '1981-06-01'],
];
for (const [label, a, b] of RATE_WINDOWS) {
  for (const [name, s] of [['Fed funds (FEDFUNDS)', ff], ['US prime (MPRIME)', prime],
                           ['AU 3-mo interbank', au3m], ['AU 10-yr govt', au10]]) {
    const m = rateMove(s, a, b);
    if (!m) continue;
    say(`| ${label} | ${name} | ${m.from.toFixed(2)} % (${m.fromDate}) | ${m.to.toFixed(2)} % (${m.toDate}) | ${pp(m.move)} |`);
  }
}
say('');

// 6. Curve twists --------------------------------------------------------------
say('## 6. Term structure — level move and twist about the 5-year anchor');
say('');
say('`yieldCurveTwist` in the library is stated RELATIVE to the level move, with the');
say('5-year point as the anchor (spread 0). The "twist" column below is exactly that:');
say('each tenor\'s change minus the 5-year change, so it is directly comparable to a preset.');
say('');
const CURVE_WINDOWS = [
  ['Dot-com easing (bull steepener)', '2000-12-29', '2003-06-13'],
  ['GFC easing',                      '2007-06-29', '2008-12-31'],
  ['COVID easing',                    '2020-01-02', '2020-08-03'],
  ['2022 hiking cycle (bear flattener)', '2021-12-31', '2022-11-01'],
  ['2000 inversion',                  '1999-06-01', '2000-11-01'],
  ['2006 inversion',                  '2004-06-01', '2006-11-01'],
  ['2019 inversion',                  '2018-11-01', '2019-08-27'],
  ['1979-81 stagflation',             '1978-12-29', '1981-09-30'],
];
for (const [label, a, b] of CURVE_WINDOWS) {
  const c = curveMove(a, b);
  say(`**${label}** (${a} → ${b}) — level (5y) ${pp(c.level)}`);
  say('');
  say('| tenor | from | to | move | twist vs 5y |');
  say('|---|---|---|---|---|');
  for (const [t, m] of Object.entries(c.moves)) {
    say(`| ${t}y | ${m.from.toFixed(2)} % | ${m.to.toFixed(2)} % | ${pp(m.move)} | ${pp(c.twist[t])} |`);
  }
  say('');
}

// 7. FX ------------------------------------------------------------------------
say('## 7. FX — USD_AUD drift and volatility');
say('');
say('`DEXUSAL` is quoted as **USD per AUD**; the model\'s `USD_AUD` is **AUD per USD**');
say('(`exchangeRateUsdToAud`, default 1.55), so the model rate is 1/DEXUSAL and the signs');
say('are opposite. Both are shown. `fxAdjustment` is ADDITIVE in model units, so on a 1.55');
say('base an `fxAdjustment: 0.08` is a 5.2 % AUD depreciation.');
say('');
say('**The AUD floated on 12 December 1983.** Before that the rate was pegged (to sterling,');
say('then the USD, then a trade-weighted basket), so a pre-1984 USD_AUD move is an');
say('administrative decision, not a market outcome, and the 1970s USD story cannot be read');
say('off it. The trade-weighted-dollar rows in 7b are the series that story actually lives in.');
say('');
say('| episode | window | USD/AUD | model USD_AUD (AUD per USD) | model drift |');
say('|---|---|---|---|---|');
const FX_WINDOWS = [
  ['Dot-com (to the USD peak)', '2000-01-03', '2001-04-02'],
  ['Dot-com (full episode)',    '2000-01-03', '2002-12-31'],
  ['GFC (to the spike)',        '2008-07-01', '2008-10-27'],
  ['GFC (12 months)',           '2008-07-01', '2009-06-30'],
  ['COVID (to the spike)',      '2020-01-02', '2020-03-19'],
  ['COVID (12 months)',         '2020-01-02', '2020-12-31'],
  ['Stagflation (AUD PEGGED — not a market rate)', '1973-01-02', '1980-12-31'],
];
for (const [label, a, b] of FX_WINDOWS) {
  const x = at(fx, a), y = at(fx, b);
  if (!x || !y) continue;
  const m0 = 1 / x.v, m1 = 1 / y.v;
  say(`| ${label} | ${a} → ${b} | ${x.v.toFixed(4)} → ${y.v.toFixed(4)} | ${m0.toFixed(4)} → ${m1.toFixed(4)} | ${pp(m1 - m0, 3)} (${pct(m1 / m0 - 1)}) |`);
}
say('');
say('| window | realized annualized vol of USD/AUD | vs baseline |');
say('|---|---|---|');
const baseVol = realizedVol(fx, '1995-01-01', '2005-01-01');
const VOL_WINDOWS = [
  ['Baseline 1995-2005',    '1995-01-01', '2005-01-01'],
  ['Baseline 2010-2019',    '2010-01-01', '2019-12-31'],
  ['Dot-com 2000-2002',     '2000-01-01', '2002-12-31'],
  ['GFC 2008-07..2009-06',  '2008-07-01', '2009-06-30'],
  ['COVID 2020-02..2020-06','2020-02-01', '2020-06-30'],
  ['Stagflation 1973-1980', '1973-01-01', '1980-12-31'],
];
for (const [label, a, b] of VOL_WINDOWS) {
  const v = realizedVol(fx, a, b);
  if (v == null) continue;
  say(`| ${label} | ${pct(v)} | ×${(v / baseVol).toFixed(2)} |`);
}
say('');

// 8. Equity vol (context for the FX vol multipliers) ---------------------------
say('### 7b. Trade-weighted USD (`TWEXMMTH`, major currencies, 1973-2019)');
say('');
say('The 1970s-USD-weakness claim is a trade-weighted claim. A rise in this index is a');
say('STRONGER dollar, so it moves in the same direction as the model\'s USD_AUD.');
say('');
say('| window | index | change |');
say('|---|---|---|');
for (const [label, a, b] of [['1973-1980 (stagflation)',   '1973-01-01', '1980-12-01'],
                             ['1976-1980 (2nd oil shock)', '1976-01-01', '1980-12-01'],
                             ['1980-1985 (Volcker)',       '1980-01-01', '1985-02-01'],
                             ['Dot-com 2000-2002',         '2000-01-01', '2002-12-01'],
                             ['GFC 2008-07..2009-03',      '2008-07-01', '2009-03-01']]) {
  const x = at(twd, a), y = at(twd, b);
  if (!x || !y) continue;
  say(`| ${label} | ${x.v.toFixed(1)} → ${y.v.toFixed(1)} | ${pct(y.v / x.v - 1)} |`);
}
say('');

say('## 8. VIX by episode (context — the model has no equity-vol knob)');
say('');
say('| window | mean VIX | max VIX |');
say('|---|---|---|');
for (const [label, a, b] of [['Calm 2004-2006', '2004-01-01', '2006-12-31'],
                             ['Dot-com 2000-2002', '2000-01-01', '2002-12-31'],
                             ['GFC 2008-2009', '2008-07-01', '2009-06-30'],
                             ['COVID 2020', '2020-02-01', '2020-06-30']]) {
  const w = between(vix, a, b);
  if (!w.length) continue;
  say(`| ${label} | ${(w.reduce((s, r) => s + r.v, 0) / w.length).toFixed(1) } | ${Math.max(...w.map(r => r.v)).toFixed(1)} |`);
}
say('');

// 9. Housing -------------------------------------------------------------------
say('## 9. Real estate');
say('');
say('| index | peak | trough | depth | peak→trough | back to peak |');
say('|---|---|---|---|---|---|');
for (const [name, id] of [['Case-Shiller US national', 'CSUSHPINSA'],
                          ['Case-Shiller San Francisco', 'SFXRSA'],
                          ['BIS US residential (nominal)', 'QUSN628BIS'],
                          ['BIS AU residential (nominal)', 'QAUN628BIS'],
                          ['BIS AU residential (real)',    'QAUR628BIS']]) {
  const d = drawdown(fred(id), '2005-01-01', '2013-12-31');
  if (!d) continue;
  say(`| ${name} | ${d.peakDate} | ${d.troughDate} | ${pct(d.depth)} | ${d.grindMonths} mo | `
    + `${d.recoverMonths != null ? `${d.recoverMonths} mo (${d.recoverDate})` : '—'} |`);
}
say('');

const text = out.join('\n') + '\n';
if (process.argv.includes('--write')) {
  const dest = path.join(ROOT, 'docs/economic-shocks/MEASUREMENTS.md');
  fs.writeFileSync(dest, text);
  console.log(`wrote ${dest}`);
} else {
  console.log(text);
}
