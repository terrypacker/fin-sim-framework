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
 * structured-param-editors.js — typed editors for the params that used to be raw JSON.
 *
 * Eleven schema params carried real structure — an allocation mix, a term structure,
 * a per-year path, a placement policy — behind `type: 'Object'`, which renders a JSON
 * textarea. That shape has three costs the scalar params never pay:
 *
 *   1. **The invariant is invisible until it throws.** A target mix must name EVERY
 *      allocation and sum to 1 (`assertTotalMix`, design 61 §12.2 Q3) — and is
 *      REJECTED, not rescaled, when it doesn't. In a textarea you learn that at
 *      Rebuild, after typing the whole map. Here the grid always writes all four
 *      classes (so totality is structural, not a rule to remember) and shows Σ live,
 *      so a 1.25 mix is red while you are still looking at it. A non-unit mix also
 *      offers an explicit Normalize (the prohibition is on a SILENT rescale, not on
 *      offering the fix) and blocks Rebuild outright — see `_guardAuthoredMixes` in
 *      the scenario presenter, which runs the compiler's own rule before compiling,
 *      because that throw otherwise escapes the boot path and empties the page.
 *   2. **The vocabulary is invisible.** Which regime tags exist, which account roles,
 *      which rate keys — all of it lived only in the description string. Selects and
 *      fixed key rows put the closed list on screen.
 *   3. **A period band doesn't read as one.** `allocationGlidepath` and
 *      `yieldCurveSchedule` are banded paths (by age, by year), the same shape the
 *      panel already renders as a table for `spendingAgeBands` and `primeSchedule`.
 *      Rendering them as JSON hid that they are the same kind of thing.
 *
 * ─── what "blank" means, per editor ──────────────────────────────────────────
 *
 * The two blanks differ and the difference is load-bearing:
 *
 *   - A blank **weight cell** is 0 — "hold none of this class". It cannot mean
 *     "absent", because an absent key and a deliberate 0 decide whether a class is
 *     held or liquidated, and the mix validator rejects the absent one outright.
 *   - A blank **rate-key cell** (a beta, an idiosyncratic vol) drops the key, which
 *     means "use the built-in default" — the placeholder shows what that default is.
 *
 * An emptied list normalises to `null` (the schema default for all of these), which
 * is what every consumer reads as "no override".
 */

import { ALLOCATION_VALUES, MIX_SUM_EPSILON } from '../../finance/holdings/allocation.js';
import { REGIME_TAG }          from '../../finance/economic-regimes/regime-tag.js';
import { ACCOUNT_ROLES }       from '../../finance/state/account-roles.js';
import { buildRowListEditor }  from '../components/row-list-editor.js';
// Design 110 §4.2 / §17.2's rule: the readouts under the tables DERIVE by calling the
// compiler's own functions, and never re-implement one. `normalizeLiquidityGraph` is what
// decides what the author wrote, `compileToDrawdownSequence` is what decides the spend order
// the run will use, and `claimValueNative` is the authority on what one claim is worth.
import { normalizeLiquidityGraph, compileToDrawdownSequence }
  from '../../finance/pools/liquidity-graph.js';
import { claimValueNative } from '../../finance/pools/pool-metrics.js';
import { describeRunSource } from '../../finance/mpc/run-schedule.js';
import { describeScaledTarget } from '../../finance/pools/pool-target-scale.js';
import { collapseTargetRuns }   from '../../finance/pools/pool-target-schedule.js';

// ─── small DOM helpers (shared shape with the band editors in scenario-tab-view) ──

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function headerRow(labels, grid, trailingSpacers = 0) {
  const header = el('div', 'age-band-row age-band-header');
  header.style.gridTemplateColumns = grid;
  for (const label of labels) header.appendChild(el('span', 'age-band-col-label', label));
  for (let i = 0; i < trailingSpacers; i++) header.appendChild(el('span'));
  return header;
}

function numberInput({ value, step, min, max, placeholder, id }) {
  const input = el('input', 'age-band-input');
  input.type = 'number';
  if (step        != null) input.step        = step;
  if (min         != null) input.min         = min;
  if (max         != null) input.max         = max;
  if (placeholder != null) input.placeholder = placeholder;
  if (id) input.dataset.id = id;
  input.value = value ?? '';
  return input;
}

function textInput({ value, placeholder, id }) {
  const input = el('input', 'age-band-input');
  input.type = 'text';
  if (placeholder != null) input.placeholder = placeholder;
  if (id) input.dataset.id = id;
  input.value = value ?? '';
  return input;
}

function selectInput({ value, options, id }) {
  const sel = el('select', 'age-band-input');
  if (id) sel.dataset.id = id;
  for (const opt of options) {
    const o = el('option', null, opt);
    o.value = opt;
    sel.appendChild(o);
  }
  // A stored value with no matching option (a tag renamed, a role removed) would
  // otherwise silently select the FIRST option and re-save as that — a different
  // plan the user never chose. Keep it, marked, so it stays visible and editable.
  if (value != null && !options.includes(value)) {
    const orphan = el('option', null, `${value} (not found)`);
    orphan.value = value;
    sel.appendChild(orphan);
  }
  sel.value = value ?? options[0] ?? '';
  return sel;
}

function removeButton(title, onClick) {
  const btn = el('button', 'btn btn-warn age-band-remove', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.dataset.id = 'removeRow';
  btn.addEventListener('click', onClick);
  return btn;
}

function addButton(label, onClick, id = 'addRow') {
  const btn = el('button', 'btn btn-sm age-band-add-btn', label);
  btn.type = 'button';
  btn.dataset.id = id;
  btn.addEventListener('click', onClick);
  return btn;
}

// ─── allocation mixes ─────────────────────────────────────────────────────────

const MIX_GRID   = ALLOCATION_VALUES.map(() => '1fr').join(' ');
/** The mix the "+ Set Mix" / "+ Add Anchor" buttons seed — the documented 60/40. */
const SEED_MIX   = Object.freeze({ EQUITY: 0.6, BOND: 0.4 });

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Coerce to a TOTAL mix — every allocation present as a finite number.
 *
 * This is `assertTotalMix`'s precondition, applied on the way IN rather than checked
 * on the way out: the editor cannot produce a partial mix, so the "missing GOLD
 * silently liquidated the gold sleeve" failure this validator exists to catch is not
 * reachable from this surface at all.
 */
function totalMix(src) {
  const out = {};
  for (const alloc of ALLOCATION_VALUES) {
    const n = Number(src?.[alloc]);
    out[alloc] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function mixSum(mix) {
  return ALLOCATION_VALUES.reduce((s, a) => s + Number(mix?.[a] ?? 0), 0);
}

/** Keep a normalized weight readable in the cell (and JSON) rather than 0.7599999999. */
function round6(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * The four weight cells plus a live Σ readout, shared by every mix-valued editor.
 *
 * `setMix` is handed a fresh TOTAL map on every keystroke, so the caller never has to
 * merge or backfill. Σ updates on `input` (not `change`) because the whole point is to
 * see the sum go wrong while typing, not after leaving the field.
 */
function buildMixGrid(getMix, setMix) {
  const wrap = el('div', 'mix-grid');
  wrap.appendChild(headerRow(ALLOCATION_VALUES, MIX_GRID));

  const row = el('div', 'age-band-row');
  row.style.gridTemplateColumns = MIX_GRID;

  const inputs = new Map();

  const foot = el('div', 'mix-foot');
  const sum  = el('div', 'mix-sum');

  // Explicit, user-clicked rescale. The design-61 §12.2 Q3 prohibition is on a SILENT
  // rescale — one the author never saw — not on offering the fix. Shown only while the
  // mix is non-unit, and it scales proportionally, so the ratios the author typed are
  // exactly what survives; the Σ readout updates in place so the result is on screen
  // before anything is rebuilt.
  const normalize = el('button', 'btn btn-sm mix-normalize', 'Normalize');
  normalize.type = 'button';
  normalize.dataset.id = 'normalizeMix';
  normalize.title = 'Scale these weights proportionally so they sum to 1.';
  normalize.addEventListener('click', () => {
    const mix   = totalMix(getMix());
    const total = mixSum(mix);
    if (!(total > 0)) return;
    const next = {};
    for (const alloc of ALLOCATION_VALUES) next[alloc] = round6(mix[alloc] / total);
    // Rounding six places can leave the sum a hair off; push the residue onto the
    // largest weight so the result validates rather than failing by 1e-6.
    const largest = ALLOCATION_VALUES.reduce((a, b) => (next[b] > next[a] ? b : a));
    next[largest] = round6(next[largest] + (1 - mixSum(next)));
    setMix(next);
    for (const alloc of ALLOCATION_VALUES) inputs.get(alloc).value = next[alloc];
    refresh();
  });

  const refresh = () => {
    const total = mixSum(getMix());
    sum.textContent = `\u03a3 ${total.toFixed(4)}`;
    const ok = Math.abs(total - 1) <= MIX_SUM_EPSILON;
    sum.classList.toggle('mix-sum-ok',  ok);
    sum.classList.toggle('mix-sum-bad', !ok);
    sum.title = ok
      ? 'Weights sum to 1.'
      : 'Weights must sum to 1. A non-unit mix is REJECTED at Rebuild, not rescaled '
        + '\u2014 a silent rescale once turned an authored 0.75 equity into an executed 0.6.';
    normalize.style.display = ok || !(total > 0) ? 'none' : '';
    wrap.classList.toggle('mix-grid-bad', !ok);
  };

  for (const alloc of ALLOCATION_VALUES) {
    const input = numberInput({ value: getMix()?.[alloc], step: '0.01', min: '0', max: '1', id: alloc });
    input.addEventListener('input', () => {
      const raw  = input.value.trim();
      const next = totalMix(getMix());
      // Blank is 0 here, never "absent" \u2014 see the header note.
      next[alloc] = raw === '' ? 0 : Number(raw);
      setMix(totalMix(next));
      refresh();
    });
    inputs.set(alloc, input);
    row.appendChild(input);
  }

  foot.appendChild(sum);
  foot.appendChild(normalize);

  wrap.appendChild(row);
  wrap.appendChild(foot);
  refresh();
  return wrap;
}

/**
 * `MixList` — one target allocation mix (`rebalanceTargetAllocation`).
 *
 * Null is a real, distinct state ("use the strategy default"), so it is shown as such
 * rather than as a grid of zeros, and "Use default" gets back to it. A grid of zeros
 * would read as an authored all-cash plan and be rejected as Σ0.
 */
export function buildMixListEditor(param) {
  const container = el('div', 'age-band-list-editor mix-list-editor');

  const render = () => {
    container.innerHTML = '';

    if (!isPlainObject(param.value)) {
      container.appendChild(el('div', 'row-list-empty', 'Using the strategy default mix.'));
      container.appendChild(addButton('+ Set Mix', () => {
        param.value = totalMix(SEED_MIX);
        render();
      }, 'setMix'));
      return;
    }

    container.appendChild(buildMixGrid(() => param.value, m => { param.value = m; }));

    const clear = el('button', 'btn btn-sm btn-warn age-band-add-btn', 'Use default');
    clear.type = 'button';
    clear.dataset.id = 'clearMix';
    clear.title = 'Clear the authored mix and fall back to the strategy default.';
    clear.addEventListener('click', () => { param.value = null; render(); });
    container.appendChild(clear);
  };

  render();
  return container;
}

/**
 * `AllocationGlidepath` — the age-banded target path (`allocationGlidepath`).
 *
 * `[{ age, weights }]`, kept sorted by age because the interpolator walks the anchors
 * in order. One block per anchor rather than one wide row: seven numeric columns in a
 * dock panel is unreadable, and the age is a band boundary, not just another cell.
 */
export function buildAllocationGlidepathEditor(param) {
  // Clone on the way in so in-place edits can never reach a shared schema default.
  const anchors = (Array.isArray(param.value) ? param.value : []).map(a => ({
    age:     Number.isFinite(Number(a?.age)) ? Number(a.age) : null,
    weights: totalMix(a?.weights),
  }));
  const byAge = (a, b) => (a.age ?? 0) - (b.age ?? 0);
  const sync  = () => { param.value = anchors.length ? anchors : null; };
  sync();

  const container = el('div', 'age-band-list-editor glidepath-editor');

  const render = () => {
    container.innerHTML = '';

    if (!anchors.length) {
      container.appendChild(el('div', 'row-list-empty',
        'No anchors — the static mix applies for the whole run.'));
    }

    anchors.forEach((anchor, idx) => {
      const block = el('div', 'mix-block');

      const head = el('div', 'mix-block-head');
      head.appendChild(el('span', 'age-band-col-label', 'Age'));
      const ageInput = numberInput({ value: anchor.age, step: '1', min: '0', max: '120', id: 'age' });
      ageInput.addEventListener('change', () => {
        const raw = ageInput.value.trim();
        anchor.age = raw === '' ? null : Number(raw);
        anchors.sort(byAge);
        sync();
        render();
      });
      head.appendChild(ageInput);
      head.appendChild(removeButton('Remove anchor', () => { anchors.splice(idx, 1); sync(); render(); }));
      block.appendChild(head);

      block.appendChild(buildMixGrid(() => anchor.weights, m => { anchor.weights = m; sync(); }));
      container.appendChild(block);
    });

    container.appendChild(addButton('+ Add Anchor', () => {
      const last = anchors[anchors.length - 1];
      anchors.push({
        age:     (last?.age ?? 50) + 10,
        weights: totalMix(last?.weights ?? SEED_MIX),
      });
      anchors.sort(byAge);
      sync();
      render();
    }));
  };

  render();
  return container;
}

/** `NORMAL` is the implicit no-active-stress bucket, not a REGIME_TAG value. */
const REGIME_OPTIONS = Object.freeze(['NORMAL', ...Object.values(REGIME_TAG)]);

/**
 * `AllocationRegimeTargets` — the regime-conditioned mix map (`allocationRegimeTargets`).
 *
 * The value is `{ tag: mix }`, but the editor holds an ordered ROW list and rebuilds
 * the map from it, because a map cannot represent a half-renamed key: retyping a tag
 * in place on the object would drop the old entry's weights the moment the new key was
 * written. Row order is preserved and matters — `resolveRegimeTarget` takes the FIRST
 * active tag it finds — so a duplicate tag (where the later row silently wins) is
 * flagged rather than quietly collapsed.
 */
export function buildAllocationRegimeTargetsEditor(param) {
  const rows = isPlainObject(param.value)
    ? Object.entries(param.value).map(([tag, mix]) => ({ tag, weights: totalMix(mix) }))
    : [];
  const sync = () => {
    if (!rows.length) { param.value = null; return; }
    const out = {};
    for (const r of rows) if (r.tag) out[r.tag] = r.weights;
    param.value = out;
  };
  sync();

  const container = el('div', 'age-band-list-editor regime-targets-editor');

  const render = () => {
    container.innerHTML = '';

    if (!rows.length) {
      container.appendChild(el('div', 'row-list-empty',
        'No regime targets — the static mix applies in every regime.'));
    }

    const seen = new Set();
    rows.forEach((row, idx) => {
      const block = el('div', 'mix-block');
      const duplicate = row.tag && seen.has(row.tag);
      seen.add(row.tag);
      if (duplicate) block.classList.add('mix-block-dup');

      const head = el('div', 'mix-block-head');
      head.appendChild(el('span', 'age-band-col-label', 'Regime'));
      const tagSel = selectInput({ value: row.tag, options: REGIME_OPTIONS, id: 'tag' });
      tagSel.addEventListener('change', () => { row.tag = tagSel.value; sync(); render(); });
      if (duplicate) tagSel.title = 'Duplicate tag — only the LAST row with this tag is used.';
      head.appendChild(tagSel);
      head.appendChild(removeButton('Remove regime target', () => { rows.splice(idx, 1); sync(); render(); }));
      block.appendChild(head);

      block.appendChild(buildMixGrid(() => row.weights, m => { row.weights = m; sync(); }));
      container.appendChild(block);
    });

    container.appendChild(addButton('+ Add Regime', () => {
      const unused = REGIME_OPTIONS.find(t => !rows.some(r => r.tag === t)) ?? REGIME_OPTIONS[0];
      rows.push({ tag: unused, weights: totalMix(rows[rows.length - 1]?.weights ?? SEED_MIX) });
      sync();
      render();
    }));
  };

  render();
  return container;
}

// ─── placement policy ─────────────────────────────────────────────────────────

const ROLE_OPTIONS = Object.freeze(Object.values(ACCOUNT_ROLES).map(r => [r, r]));

/**
 * `LocationPolicy` — allocation → ordered preferred account roles.
 *
 * Serves both `allocationLocationPolicy` (design 61 Lever D) and `assetLocationPolicy`
 * (STRATEGIC_ASSET_LOCATION), which are the same `{ ALLOCATION: [role, ...] }` shape.
 * The array is a PREFERENCE ORDER (first choice first, spilling when full), so the
 * editor is a flat ordered `{ allocation, role }` row list with a move-up button
 * rather than a map of unordered checkboxes — the order is the datum.
 */
export function buildLocationPolicyEditor(param) {
  const rows = [];
  if (isPlainObject(param.value)) {
    for (const [allocation, roles] of Object.entries(param.value)) {
      for (const role of (Array.isArray(roles) ? roles : [roles])) {
        if (role != null) rows.push({ allocation, role: String(role) });
      }
    }
  }

  const sync = () => {
    const out = {};
    for (const { allocation, role } of rows) {
      if (!allocation || !role) continue;
      (out[allocation] ??= []).push(role);
    }
    param.value = Object.keys(out).length ? out : null;
  };
  sync();

  return buildRowListEditor({
    rows,
    columns: [
      { field: 'allocation', label: 'Class', type: 'select',
        options: ALLOCATION_VALUES.map(a => [a, a]) },
      { field: 'role', label: 'Preferred account role', type: 'select',
        options: ROLE_OPTIONS, width: '1.7fr' },
    ],
    // Seed the next unused role for that class rather than the first one every time: a
    // preference list is a RANKING, so two identical rows say nothing, and clicking
    // "+ Add Preference" twice is exactly how you get them.
    newRow: () => {
      const allocation = ALLOCATION_VALUES[0];
      const taken = new Set(rows.filter(r => r.allocation === allocation).map(r => r.role));
      const role  = ROLE_OPTIONS.map(([v]) => v).find(v => !taken.has(v)) ?? ROLE_OPTIONS[0][0];
      return { allocation, role };
    },
    addLabel:   '+ Add Preference',
    emptyText:  'No policy — the jurisdiction-aware default applies.',
    reorderable: true,
    onChange:   sync,
  });
}

// ─── yield curves ─────────────────────────────────────────────────────────────

/**
 * The `[{ tenor, spread }]` anchor table, over a get/set pair so it can drive both a
 * standalone param (`usYieldCurveShape`) and one country of one schedule row.
 *
 * Sorted by tenor: the interpolator walks the points in order and clamps to the
 * endpoints, so an out-of-order point silently reshapes the whole curve.
 */
function buildShapePointsEditor(get, set) {
  const rows = (Array.isArray(get()) ? get() : []).map(p => ({
    tenor:  Number.isFinite(Number(p?.tenor))  ? Number(p.tenor)  : null,
    spread: Number.isFinite(Number(p?.spread)) ? Number(p.spread) : null,
  }));
  const sync = () => set(rows.length ? rows : null);
  sync();

  return buildRowListEditor({
    rows,
    columns: [
      { field: 'tenor',  label: 'Tenor (yrs)', step: '1',     min: '0' },
      { field: 'spread', label: 'Spread',      step: '0.001', placeholder: '0.000' },
    ],
    newRow: () => {
      const last = rows[rows.length - 1];
      return { tenor: (last?.tenor ?? 0) + (last ? 5 : 1), spread: 0 };
    },
    addLabel:  '+ Add Point',
    emptyText: 'Flat curve — every tenor uses the level.',
    sortBy:    (a, b) => (a.tenor ?? 0) - (b.tenor ?? 0),
    onChange:  sync,
  });
}

/** `YieldCurveShape` — a standalone term-structure overlay (US or AU). */
export function buildYieldCurveShapeEditor(param) {
  return buildShapePointsEditor(() => param.value, v => { param.value = v; });
}

/**
 * `YieldCurveSchedule` — the per-year curve path (`yieldCurveSchedule`).
 *
 * `[{ year, US: [...], AU: [...] }]`: a year band whose payload is two nested shapes.
 * A country key that is ABSENT means "leave that country alone for this step" (the
 * compiler tests `Array.isArray(entry[cc])`), which is not the same as an empty list,
 * so clearing a country's points deletes the key rather than writing `[]`.
 */
export function buildYieldCurveScheduleEditor(param) {
  const entries = (Array.isArray(param.value) ? param.value : []).map(e => {
    const out = { year: Number.isFinite(Number(e?.year)) ? Number(e.year) : null };
    for (const cc of ['US', 'AU']) {
      if (Array.isArray(e?.[cc])) out[cc] = e[cc].map(p => ({ ...p }));
    }
    return out;
  });
  const byYear = (a, b) => (a.year ?? 0) - (b.year ?? 0);
  const sync   = () => { param.value = entries.length ? entries : null; };
  sync();

  const container = el('div', 'age-band-list-editor yield-schedule-editor');

  const render = () => {
    container.innerHTML = '';

    if (!entries.length) {
      container.appendChild(el('div', 'row-list-empty',
        'No scheduled twists — the static shape holds for the whole run.'));
    }

    entries.forEach((entry, idx) => {
      const block = el('div', 'mix-block');

      const head = el('div', 'mix-block-head');
      head.appendChild(el('span', 'age-band-col-label', 'Year'));
      const yearInput = numberInput({ value: entry.year, step: '1', min: '1900', id: 'year' });
      yearInput.addEventListener('change', () => {
        const raw = yearInput.value.trim();
        entry.year = raw === '' ? null : Number(raw);
        entries.sort(byYear);
        sync();
        render();
      });
      head.appendChild(yearInput);
      head.appendChild(removeButton('Remove year', () => { entries.splice(idx, 1); sync(); render(); }));
      block.appendChild(head);

      for (const cc of ['US', 'AU']) {
        const section = el('div', 'yield-country');
        section.dataset.id = `country-${cc}`;
        section.appendChild(el('div', 'payroll-group-heading', `${cc} — absolute shape`));
        section.appendChild(buildShapePointsEditor(
          () => entry[cc],
          v => { if (v == null) delete entry[cc]; else entry[cc] = v; sync(); },
        ));
        block.appendChild(section);
      }

      container.appendChild(block);
    });

    container.appendChild(addButton('+ Add Year', () => {
      const last = entries[entries.length - 1];
      entries.push({ year: (last?.year ?? new Date().getUTCFullYear()) + 1 });
      entries.sort(byYear);
      sync();
      render();
    }));
  };

  render();
  return container;
}

// ─── per-sleeve numeric maps (betas, idiosyncratic vols) ──────────────────────

/**
 * `RateKeyMap` — a `{ rateKey: number }` override map over a CLOSED key set.
 *
 * The keys come from the schema (`param.options`) and the built-in fallbacks from
 * `param.optionDefaults`, so every sleeve gets a fixed row whose placeholder shows the
 * value it will use if left blank. That is the honest rendering of these params: they
 * are not free maps, they are four (or two) optional overrides, and the interesting
 * question — "what is it right now if I don't touch it?" — was unanswerable in a
 * textarea showing `null`.
 *
 * Blank drops the key (⇒ the default). All blank ⇒ `null`. A key already in the value
 * but not in the schema list (a regional key like `REAL_ESTATE_US-SF-BAY`) gets its own
 * row, marked, so it is editable rather than invisibly carried.
 */
export function buildRateKeyMapEditor(param) {
  const keys     = Array.isArray(param.options) ? param.options : [];
  const defaults = isPlainObject(param.optionDefaults) ? param.optionDefaults : {};
  const container = el('div', 'age-band-list-editor rate-key-map-editor');
  const GRID = '1.7fr 1fr';

  const write = (key, raw) => {
    const base = isPlainObject(param.value) ? { ...param.value } : {};
    if (raw.trim() === '') {
      delete base[key];
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      base[key] = n;
    }
    param.value = Object.keys(base).length ? base : null;
  };

  const render = () => {
    container.innerHTML = '';

    const extra = isPlainObject(param.value)
      ? Object.keys(param.value).filter(k => !keys.includes(k))
      : [];
    const allKeys = [...keys, ...extra];

    if (!allKeys.length) {
      container.appendChild(el('div', 'row-list-empty', 'No sleeves declared for this param.'));
      return;
    }

    container.appendChild(headerRow(['Sleeve', 'Value'], GRID));

    for (const key of allKeys) {
      const row = el('div', 'age-band-row');
      row.style.gridTemplateColumns = GRID;

      const label = el('span', 'age-band-col-label rate-key-label', key);
      if (extra.includes(key)) {
        label.classList.add('rate-key-unknown');
        label.title = 'Not one of this param’s declared sleeves — kept so it is not silently carried.';
      }
      row.appendChild(label);

      const dflt = defaults[key];
      const input = numberInput({
        value:       isPlainObject(param.value) ? param.value[key] : undefined,
        step:        '0.01',
        placeholder: dflt == null ? 'default' : String(dflt),
        id:          key,
      });
      input.title = dflt == null
        ? 'Blank = the built-in default.'
        : `Blank = the built-in default (${dflt}).`;
      input.addEventListener('change', () => write(key, input.value));
      row.appendChild(input);

      container.appendChild(row);
    }
  };

  render();
  return container;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DESIGN 97 — the drawdown sequence and the liquidity POOL GRAPH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Both design-97 params shipped as `type: 'Object'` — a JSON textarea — and the schema
 * comment said why: "the list is an ORDER over pairs of (account, sleeve set), and a control
 * that expresses that honestly is real UI work; a textarea over validated JSON says what it
 * is, a half-editor would not."
 *
 * That reasoning was about the ORDER. `buildRowListEditor` gained `reorderable` since (a
 * move-up button per row), which is the missing piece, so an honest control is now a
 * composition of parts that already exist rather than new UI work. What these two editors
 * add on top is two column types (`text` for an invented id, `checkset` for the sleeves) and
 * the cross-table refresh a graph needs.
 *
 * ─── why a graph is THREE flat tables, not one nested editor ─────────────────
 *
 * A pool holds a LIST of claims, so the natural shape is a list of lists — and a nested
 * repeating-row editor is the thing the original comment correctly called real UI work.
 * Splitting claims into their own table keyed by pool id makes all three tables flat, so all
 * three are the same shared component. It also makes the multi-account pool (the "one year
 * of cash across two savings accounts" case, which is the whole reason a pool is a node and
 * not a sequence entry) as easy to author as the single-account one: add a row.
 *
 * The cost is that a pool's identity is a string the user types in one table and selects in
 * two others. That is what `refresh` is for: renaming a pool re-renders the claim and flow
 * tables so an orphaned reference shows as "(not found)" immediately, rather than at Rebuild.
 *
 * ─── validation stays where it is ────────────────────────────────────────────
 *
 * These editors deliberately do NOT re-implement `normalizeLiquidityGraph`. Design 97 §6/§12.7
 * put validation at the config boundary precisely because every way of getting a graph wrong
 * produces a run that completes and lies; a second copy in the UI would be a second thing to
 * keep in step. What the editors do is make the *vocabulary* visible — the account list, the
 * sleeve set, the target and capacity modes, the gate kinds — so most of those errors are no
 * longer typable.
 */

/** The ALLOCATION sleeves a claim may narrow to — the drawdown-relevant classes. */
const SLEEVE_OPTIONS = Object.freeze(
  ALLOCATION_VALUES.filter(a => a !== 'OTHER').map(a => [a, a]));

// `YEARS_OF_SPEND_REMAINDER` reads as a longer sentence than the other three because it is
// one: it sizes this pool from an AGGREGATE held across several, which is a different kind of
// statement from "this pool holds N years" and should not look like a variant of it.
const TARGET_MODE_OPTIONS = Object.freeze([
  ['',                         '— none —'],
  ['YEARS_OF_SPEND',           'years of spend'],
  ['PERCENT',                  '% of book'],
  ['AMOUNT',                   'amount'],
  ['YEARS_OF_SPEND_REMAINDER', 'remainder of N years across pools'],
]);

/**
 * Design 97 §24.5 — whether this pool may be reached by paying the early-withdrawal penalty.
 * Worded as the CONSEQUENCE rather than as the enum, because "PENALTY_FREE" reads like a
 * property of the money and it is a decision about the household.
 */
const ACCESS_MODE_OPTIONS = Object.freeze([
  ['PENALTY_FREE',  'penalty-free only'],
  ['ALLOW_PENALTY', 'may be raided early (10% penalty)'],
]);

/** The target modes whose `after` cell is meaningful. One entry today; a list so it reads. */
const TARGET_NEEDS_AFTER = Object.freeze(['YEARS_OF_SPEND_REMAINDER']);

const CAPACITY_MODE_OPTIONS = Object.freeze([
  ['BALANCE',        'balance (no ceiling)'],
  ['OFFSET_CAP',     'offset cap (min of cash, loan)'],
  ['AMOUNT',         'amount'],
  ['YEARS_OF_SPEND', 'years of spend'],
]);

const TRIGGER_OPTIONS = Object.freeze([
  ['',                    'under target'],
  ['belowYears',          'below N years'],
  ['belowAmount',         'below amount'],
  ['belowTargetFraction', 'below fraction of target'],
]);

// The market-state pair is listed first for history rather than for preference: §16.1b reached
// for it because a trailing-high gate on the peak BALANCE cannot tell a falling market from
// the pool being drawn down. Design 97 §20.14 measured that as a property of the SERIES —
// `sourceDrawdownUnder` on the INDEX basis is flow-neutral, and beats the return pair on
// median, win rate, left tail and interest paid in a plan being spent down.
//
// "last year" is in the labels because it is the whole meaning of the control. These gates act
// on the last COMPLETED calendar year, not the year they fire in (design 97 §20.2) — a gate
// that read the current year would be pausing sales in the year the market is about to fall,
// which no household can do. The difference between "sell only in an up market" and "sell only
// after an up year" is a year of foresight, and only the second is a rule anyone can follow.
const GATE_OPTIONS = Object.freeze([
  ['sourceReturnOver',    'source returned over X last year'],
  ['targetReturnUnder',   'destination returned under X last year'],
  ['sourceDrawdownUnder', 'source within X of its high'],
  ['targetDrawdownOver',  'destination X below its high'],
]);

// The SENSE of a clause — design 97 §12.3's `not`, on the row rather than as a nested node.
// It is the only way to say a condition the four clause kinds state in one direction: "fire
// only when the source is NOT within x of its high" is a down-market rule, and the positive
// clauses cannot say it because a drawdown threshold has no upper bound to invert.
//
// The negation wraps the CLAUSE, and any dwell then rides on the negation — "the source has
// NOT been within 5 % of its high for two years" — which is the reading `gateNodeToRow`
// refuses to invent when a saved gate puts the dwell the other side of the `not`.
const GATE_SENSE_OPTIONS = Object.freeze([
  ['',    'when'],
  ['NOT', 'when NOT'],
]);

// design 97 §20.14. Which series a drawdown clause measures against, and the labels say the
// difference because it is the whole point: a peak BALANCE counts the household's own spending
// as drawdown, so in a plan being spent down the gate latches shut for a reason that has
// nothing to do with the market. INDEX is the pool's compounded return, which no withdrawal
// can move. Blank on a RETURN clause, which has no series to choose.
const GATE_BASIS_OPTIONS = Object.freeze([
  ['BALANCE', 'peak balance (spending counts as drawdown)'],
  ['INDEX',   'return index (flow-neutral)'],
]);

/**
 * The basis options for ONE row, because a RETURN clause has no series to choose.
 *
 * `sourceReturnOver` / `targetReturnUnder` read the pool's own prior-year return; there is no
 * second series they could be measured against, which is why `normalizeGate` REFUSES a
 * `drawdownBasis` on a gate with no drawdown clause ("it would round-trip a setting that
 * decides nothing"). The table therefore has to offer the empty choice on such a row rather
 * than the two real ones — a fixed two-option list left the cell holding a value no option
 * matched, and `buildSelect` renders that, correctly and alarmingly, as "(not found)".
 *
 * The blank is labelled rather than empty: a bare "—" in a column headed "Measured against"
 * reads as a setting the author forgot, and this one is a setting the clause cannot have.
 */
const GATE_BASIS_NA_OPTIONS = Object.freeze([['', 'n/a — a return clause']]);

/**
 * Does this clause kind measure a pool against a trailing high, and so name a series?
 *
 * One predicate, used by the options list, the row-normalizer and the save path, because
 * three copies of `includes('drawdown')` is three chances for the cell, the row and the
 * saved gate to disagree about what a clause is.
 */
const isDrawdownClause = (kind) => String(kind ?? '').toLowerCase().includes('drawdown');

/**
 * §12.4c. Labelled by what the gate DOES, not by the enum name: "SOURCE"/"EDGE" alone reads as
 * a topology choice, and the whole difficulty this control exists for is that the two are
 * different POLICIES over the same topology.
 */
const GATE_SCOPE_OPTIONS = Object.freeze([
  ['SOURCE', 'selling the source pool'],
  ['EDGE',   'filling the destination pool'],
]);

const gateBasisOptionsFor = (row) =>
  (isDrawdownClause(row?.gateKind) ? GATE_BASIS_OPTIONS : GATE_BASIS_NA_OPTIONS);

// design 97 §12.6. PERIOD is the default; ANNUAL restricts an edge to the first period of the
// calendar year. Authorable because a market gate reads an ANNUAL signal (the equity tick runs
// once a year), so an edge free to fire on every advance is re-deciding on an unchanged
// reading — and because an arm built in a script and not reproducible in the app is a study
// nobody can check.
const CADENCE_OPTIONS = Object.freeze([
  ['PERIOD',   'every period'],
  ['ANNUAL',   'once a year'],
  // Design 107 §5.1. Not a frequency like the other two: a PAYCHECK edge is invisible to the
  // period advances entirely and fires only on the SPENDING_REFILL event, whose schedule is
  // the paycheck's own (annual on either income year, or quarterly). It is the only way to
  // put a refill on the AU calendar — `ANNUAL` is keyed on the CALENDAR year, so it always
  // fires on the 1 January advance whatever it was meant to mean.
  ['PAYCHECK', 'on the paycheck'],
]);

const AMOUNT_OPTIONS = Object.freeze([
  ['toTarget',         'fill to target'],
  ['fractionOfSource', 'fraction of source'],
]);

/** Account options as `[stateKey, label]`, from the live account list. */
function accountOptions(accounts) {
  return (accounts ?? []).map(a => [a.stateKey, a.name ? `${a.name} (${a.stateKey})` : a.stateKey]);
}

/**
 * The sleeves a row may narrow to, given the account it names.
 *
 * Empty for anything but a brokerage, because §3.1's rule is that sleeves only MEAN
 * something on an account whose draw runs through `consumeHoldings` — narrowing a savings or
 * offset account reads as a pool boundary and enforces nothing, and the normalizer throws on
 * it. Returning no options is what turns that from an error you can type and discover at
 * Rebuild into a choice that is not on screen.
 */
function sleeveOptionsFor(accounts) {
  const typeOf = new Map((accounts ?? []).map(a => [a.stateKey, a.type]));
  return (row) => (typeOf.get(row?.key) === 'brokerage' ? SLEEVE_OPTIONS : []);
}

/**
 * `DrawdownSequence` — design 97 §3's ordered pool list, `[{ key, sleeves }]`.
 *
 * ORDER is the datum here, so the list is `reorderable` and deliberately NOT sorted: there
 * is no invariant to sort by, and re-sorting would destroy the only thing the param says.
 *
 * Blank sleeves = the whole account, which is why the checkset's `blankValue` is null rather
 * than `[]`: §3.1 rule 3 gives an unnarrowed entry a different meaning (it claims everything),
 * and an empty array would be rejected by the normalizer as a claim of nothing.
 */
export function buildDrawdownSequenceEditor(param, accounts = []) {
  const rows = (Array.isArray(param.value) ? param.value : []).map(e => ({
    key:     typeof e === 'string' ? e : (e?.key ?? null),
    sleeves: Array.isArray(e?.sleeves) && e.sleeves.length ? [...e.sleeves] : null,
  }));
  const sync = () => {
    const kept = rows.filter(r => r.key);
    param.value = kept.length
      ? kept.map(r => ({ key: r.key, ...(r.sleeves?.length ? { sleeves: [...r.sleeves] } : {}) }))
      : null;
  };
  sync();

  return buildRowListEditor({
    rows,
    reorderable: true,
    columns: [
      { field: 'key',     label: 'Account', type: 'select', options: accountOptions(accounts),
        rerender: true, width: '1.6fr' },
      { field: 'sleeves', label: 'Sleeves (blank = whole account)', type: 'checkset',
        options: sleeveOptionsFor(accounts), blankValue: null, width: '2fr',
        emptyText: 'whole account' },
    ],
    newRow:    () => ({ key: accounts?.[0]?.stateKey ?? null, sleeves: null }),
    addLabel:  '+ Add Pool',
    emptyText: 'No sequence — accounts are drawn in drawdownPriority order (the default).',
    onChange:  sync,
  });
}

/**
 * The keys of an authored sub-object that no column draws, kept so an edit somewhere else in
 * the table does not delete them.
 *
 * The same rule as `ui` and `rawGate`, one level down: a `floor`, a `spendBasis` or an
 * `amount.max` that the tables cannot show is still a policy the author wrote, and a graph
 * that silently lost it on the next keystroke would still load and still run — this design's
 * named failure mode. Carried, not drawn; making them editable is a column each, later.
 */
function extraKeys(obj, drawn) {
  if (!isPlainObject(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!drawn.includes(k) && v != null) out[k] = v;
  return Object.keys(out).length ? out : null;
}

/** Capacity modes that carry an authored size; BALANCE and OFFSET_CAP are derived from state. */
const CAPACITY_NEEDS_VALUE = Object.freeze(['AMOUNT', 'YEARS_OF_SPEND']);

/**
 * What a pool size cell may hold, per MODE — the compiler's own bounds (`sizeSpec` in
 * liquidity-graph.js), restated as cell attributes.
 *
 * The Size cell means three different quantities depending on the mode beside it, and the
 * three do not share a range: PERCENT is a FRACTION of the book (0.05 is 5 %), so a 100
 * typed there is 10,000 % — the compiler rejects it, and because the rejection happens at
 * LOAD the scenario becomes unopenable in the very editor that could fix it. One static
 * bound cannot serve all three, so the cell reads its bound off its own row.
 *
 * `null` marks a mode that derives its size from live state and takes no value at all.
 */
const SIZE_BOUNDS = Object.freeze({
  PERCENT:        { min: '0', max: '1',  step: '0.01', title: 'A FRACTION of the book — 0.05 is 5%.' },
  YEARS_OF_SPEND: { min: '0', max: '50', step: '0.5',  title: 'Years of spending.' },
  YEARS_OF_SPEND_REMAINDER: { min: '0', max: '50', step: '0.5',
    title: 'The AGGREGATE, in years of spending, held across this pool and the ones ticked '
         + 'beside it. This pool holds whatever of it they do not.' },
  AMOUNT:         { min: '0', max: null, step: '1000', title: 'A figure in the valuation base currency.' },
  BALANCE:        null,
  OFFSET_CAP:     null,
  '':             null,
});
const boundsFor = (mode) => SIZE_BOUNDS[mode ?? ''] ?? null;
/** A per-row accessor for one bound, for the row-list editor's function-valued attributes. */
const sizeAttr = (modeField, key) => (row) => boundsFor(row?.[modeField])?.[key] ?? null;

/**
 * `LiquidityGraph` — design 97 Part II, `{ pools, flows }`, as three flat tables.
 *
 * The value is rebuilt from the tables on every edit rather than mutated in place, for the
 * reason `buildAllocationRegimeTargetsEditor` gives about maps: a half-renamed pool id would
 * otherwise drop its claims the moment the new key was written.
 */
/**
 * `LiquidityGraphSchedule` — the year band that says which named shape is in charge
 * (design 109 §11).
 *
 * `[{ year, shape }]`, one row per year, sorted. The shape cell is a select over the ids in
 * `liquidityShapes` rather than free text, because a typo there is refused at LOAD and the
 * author would find out at Rebuild — the exact "invisible until it throws" shape this editor
 * exists to remove.
 *
 * The BASE graph is drawn as an implicit, non-editable row 0. Without it the table says "the
 * bridge shape starts in 2035" and leaves the first nine years of the plan looking
 * unauthored, when in fact `liquidityGraph` governs them.
 *
 * @param {object} param
 * @param {function(): Array<string>} shapeIdsProvider  the live `liquidityShapes` keys
 */
export function buildLiquidityGraphScheduleEditor(param, shapeIdsProvider = () => []) {
  // A row may select the BASE graph with `shape: null` (design 39 §14.9.8), which is how an
  // MPC decision to stay on or return to it is saved. A select cannot hold null, so the editor
  // carries it as a sentinel that never leaves this function. Without it, `sync()` below
  // (which runs on build) would drop every base row the moment the panel opened.
  const rows = (Array.isArray(param.value) ? param.value : []).map(r => ({
    year:  Number.isFinite(Number(r?.year)) ? Number(r.year) : null,
    shape: typeof r?.shape === 'string' ? r.shape
      : (r?.shape === null && r && Object.hasOwn(r, 'shape')) ? BASE_SHAPE_OPTION : null,
  }));
  const sync = () => {
    const kept = rows.filter(r => r.year != null && r.shape);
    param.value = kept.length
      ? kept.map(r => ({ year: r.year, shape: r.shape === BASE_SHAPE_OPTION ? null : r.shape }))
      : null;
  };
  sync();

  const container = el('div', 'age-band-list-editor liquidity-schedule-editor');

  const render = () => {
    container.innerHTML = '';
    const ids = shapeIdsProvider() ?? [];

    // Row 0, stated rather than implied. See the docstring.
    const base = el('div', 'row-list-empty');
    base.dataset.id = 'base-row';
    base.textContent = ids.length
      ? 'Before the first year below, the base Liquidity Pools graph governs.'
      : 'No shapes defined yet — add one under Liquidity Pool Shapes, then schedule it here.';
    container.appendChild(base);

    container.appendChild(buildRowListEditor({
      rows,
      columns: [
        { field: 'year',  label: 'From year', type: 'number', step: '1', min: '1900', width: '0.8fr' },
        // Only ids that EXIST are offered. A row pointing at a deleted shape keeps its value
        // and is shown as missing, the same way a claim pointing at a renamed pool is.
        { field: 'shape', label: 'Shape', type: 'select', width: '1.6fr',
          options: (row) => {
            const opts = [...ids.map(id => [id, id]), [BASE_SHAPE_OPTION, 'Base graph']];
            if (row?.shape && row.shape !== BASE_SHAPE_OPTION && !ids.includes(row.shape)) {
              opts.unshift([row.shape, `${row.shape} — not found`]);
            }
            return opts;
          } },
      ],
      newRow: () => {
        const last = rows[rows.length - 1];
        return { year: (last?.year ?? new Date().getUTCFullYear()) + 1, shape: ids[0] ?? null };
      },
      addLabel:  '+ Add Year',
      emptyText: 'One shape for the whole run — the base graph governs throughout.',
      sortBy:    (a, b) => (a.year ?? 0) - (b.year ?? 0),
      onChange:  () => { sync(); render(); },
    }));
  };

  render();
  return container;
}

/**
 * `LiquidityTargetSchedule` — dated changes to a pool's size (design 112).
 *
 * `[{ year, pool, scale, by? }]`. The pool cell is a select over every pool id in the base graph
 * and the shapes, because an unknown pool is refused at LOAD. The size column is DERIVED
 * (`describeScaledTarget`, the one formatter every surface uses): a factor is less legible than
 * a size, so the row says what the factor resolves to, in each graph the pool is in.
 *
 * Two design 112 obligations beyond the table:
 *   · R12 — a row an MPC session wrote carries `by`. The editor shows it and preserves it
 *     across edits (a hand edit of the factor keeps the mark, since the row still came from
 *     that session's decision; removing the row removes it).
 *   · R13 — a session that re-decides every year writes a row per pool per year. Above the
 *     table the rows are shown as RUNS of an unchanged factor ("cash 3y (×1.5), 2031–2040,
 *     10 rows"). Display only: storage keeps every row, so a replay is unchanged.
 *
 * @param {object} param
 * @param {function(): object} graphsProvider  live `{ liquidityGraph, liquidityShapes }`
 */
export function buildLiquidityTargetScheduleEditor(param, graphsProvider = () => ({})) {
  const rows = (Array.isArray(param.value) ? param.value : []).map(r => ({
    year:  Number.isFinite(Number(r?.year)) ? Number(r.year) : null,
    pool:  typeof r?.pool === 'string' && r.pool ? r.pool : null,
    scale: Number.isFinite(r?.scale) ? r.scale : null,
    by:    typeof r?.by === 'string' && r.by ? r.by : null,
  }));
  const sync = () => {
    const kept = rows.filter(r => r.year != null && r.pool && r.scale != null);
    param.value = kept.length
      ? kept.map(r => ({ year: r.year, pool: r.pool, scale: r.scale, ...(r.by ? { by: r.by } : {}) }))
      : null;
  };
  sync();

  const container = el('div', 'age-band-list-editor liquidity-target-schedule-editor');

  const poolIds = (g) => {
    const out = new Set();
    const add = (graph) => {
      for (const p of (Array.isArray(graph?.pools) ? graph.pools : [])) {
        if (p && typeof p.id === 'string' && p.id) out.add(p.id);
      }
    };
    add(g.liquidityGraph);
    const shapes = g.liquidityShapes;
    if (shapes && typeof shapes === 'object' && !Array.isArray(shapes)) Object.values(shapes).forEach(add);
    return [...out];
  };

  const render = () => {
    container.innerHTML = '';
    const g   = graphsProvider() ?? {};
    const ids = poolIds(g);

    const runs = collapseTargetRuns(param.value);
    if (runs.length) {
      const summary = el('div', 'row-list-empty liquidity-target-runs');
      summary.dataset.id = 'target-runs';
      for (const run of runs) {
        const line = el('div', 'liquidity-target-run');
        const span = run.lastYear === run.fromYear ? `from ${run.fromYear}`
          : `${run.fromYear}–${run.lastYear}`;
        const rowsNote = run.count > 1 ? `, ${run.count} rows` : '';
        const byNote   = run.by.length ? ` · by ${run.by.join(', ')}` : '';
        line.textContent = `${describeScaledTarget(g, run.pool, run.scale)}, ${span}${rowsNote}${byNote}`;
        summary.appendChild(line);
      }
      container.appendChild(summary);
    }

    container.appendChild(buildRowListEditor({
      rows,
      columns: [
        { field: 'year',  label: 'From year', type: 'number', step: '1', min: '1900', width: '0.7fr' },
        { field: 'pool',  label: 'Pool', type: 'select', width: '1fr',
          options: (row) => {
            const opts = ids.map(id => [id, id]);
            if (row?.pool && !ids.includes(row.pool)) opts.unshift([row.pool, `${row.pool} — not found`]);
            return opts;
          } },
        { field: 'scale', label: 'Factor', type: 'number', step: '0.05', min: '0', width: '0.6fr' },
        { field: 'size',  label: 'Size', type: 'note', width: '1.8fr',
          text: (row) => (row.pool && row.scale != null) ? describeScaledTarget(g, row.pool, row.scale) : '' },
        { field: 'by',    label: 'By', type: 'note', width: '0.8fr',
          text: (row) => row.by ?? '',
          title: (row) => row.by ? `Written by MPC session ${row.by}` : 'Written by hand' },
      ],
      newRow: () => {
        const last = rows[rows.length - 1];
        return { year: (last?.year ?? new Date().getUTCFullYear()) + 1,
                 pool: last?.pool ?? ids[0] ?? null, scale: 1, by: null };
      },
      addLabel:  '+ Add Row',
      emptyText: ids.length
        ? 'Every pool holds its authored target for the whole run.'
        : 'No pools defined yet — add one under Liquidity Pools (graph).',
      sortBy:    (a, b) => (a.year ?? 0) - (b.year ?? 0) || String(a.pool).localeCompare(String(b.pool)),
      onChange:  () => { sync(); render(); },
    }));
  };

  render();
  return container;
}

/** The schedule editor's stand-in for `shape: null` (the base graph). Never saved. */
const BASE_SHAPE_OPTION = '\u0000base';

/**
 * `LiquidityShapes` — the named alternative graphs (design 109 §11).
 *
 * `{ <shapeId>: { pools, flows } }` rendered as a list of named blocks, each holding the
 * EXISTING three-table graph editor over that shape's value. One editor, not two: a shape is
 * the same vocabulary as the base graph (§4), so a second authoring surface for it would be a
 * second place for the two to drift.
 *
 * **`+ Duplicate` is not a convenience.** §4 Q1 chose whole-graph shapes, whose cost is that
 * changing one pool's target in 2040 means authoring a second complete graph. Re-typing four
 * tables is how a pool id drifts, and §9 makes the id the handle for identity across a switch
 * — a renamed pool silently retires one pool and starts another whose trailing high is zero.
 * Duplication is the mechanism that keeps ids stable, so it sits beside Add rather than in a
 * menu.
 *
 * @param {object} param
 * @param {Array}  accounts
 */
export function buildLiquidityShapesEditor(param, accounts = [], flags = null) {
  const value  = isPlainObject(param.value) ? param.value : {};
  const shapes = Object.entries(value).map(([id, graph]) => ({ id, graph: graph ?? {} }));

  const sync = () => {
    const kept = shapes.filter(s => s.id);
    param.value = kept.length
      ? Object.fromEntries(kept.map(s => [s.id, s.graph ?? {}]))
      : null;
  };
  sync();

  const container = el('div', 'age-band-list-editor liquidity-shapes-editor');

  /**
   * Pools added / retired / carried, against the shape before this one.
   *
   * §9's rule made visible at the moment of authoring, and the single highest-value thing on
   * this screen: a RENAMED pool shows up here as one retired and one added, which is exactly
   * the mistake the line exists to catch.
   */
  const diffLine = (idx) => {
    const prev = idx === 0 ? null : shapes[idx - 1];
    const ids  = (s) => new Set((s?.graph?.pools ?? []).map(p => p?.id).filter(Boolean));
    const now  = ids(shapes[idx]);
    if (!prev) return `${now.size} pool(s).`;
    const was     = ids(prev);
    const added   = [...now].filter(id => !was.has(id));
    const retired = [...was].filter(id => !now.has(id));
    const kept    = [...now].filter(id => was.has(id));
    const parts = [`${kept.length} carried`];
    if (added.length)   parts.push(`added ${added.join(', ')}`);
    if (retired.length) parts.push(`retired ${retired.join(', ')}`);
    return `vs ${prev.id}: ${parts.join(' · ')}`;
  };

  const render = () => {
    container.innerHTML = '';

    if (!shapes.length) {
      container.appendChild(el('div', 'row-list-empty',
        'No named shapes — the base graph governs the whole run.'));
    }

    shapes.forEach((shape, idx) => {
      const block = el('div', 'mix-block');
      block.dataset.id = `shape-${idx}`;

      // FOUR controls, so it needs its own column template — see `.pool-shape-head`.
      const head = el('div', 'mix-block-head pool-shape-head');
      head.appendChild(el('span', 'age-band-col-label', 'Shape id'));
      const idInput = textInput({ value: shape.id, placeholder: 'bridge', id: 'shape-id' });
      idInput.addEventListener('change', () => {
        shape.id = idInput.value.trim() || null;
        sync();
        render();
      });
      head.appendChild(idInput);
      head.appendChild(addButton('+ Duplicate', () => {
        // The ids INSIDE are copied verbatim — that is the point (see the docstring).
        shapes.splice(idx + 1, 0, {
          id: `${shape.id ?? 'shape'}-copy`,
          graph: JSON.parse(JSON.stringify(shape.graph ?? {})),
        });
        sync();
        render();
      }));
      head.appendChild(removeButton('Remove shape', () => { shapes.splice(idx, 1); sync(); render(); }));
      block.appendChild(head);

      const diff = el('div', 'pool-shape-diff', diffLine(idx));
      diff.dataset.id = `shape-diff-${idx}`;
      block.appendChild(diff);

      // The SAME editor the base graph uses, over this shape's value.
      block.appendChild(buildLiquidityGraphEditor({
        name:  `${param.name}.${shape.id}`,
        get value() { return shape.graph; },
        set value(v) { shape.graph = v ?? {}; sync(); },
      }, accounts, () => ({ ...(typeof flags === 'function' ? flags() : flags),
                            // Read at call time, not captured: an id retyped in the head
                            // above must move this line with it, or the readouts below name
                            // the shape the author just stopped editing.
                            shapeId: shape.id ?? '(unnamed)' })));

      container.appendChild(block);
    });

    container.appendChild(addButton('+ Add Shape', () => {
      shapes.push({ id: null, graph: {} });
      sync();
      render();
    }));
  };

  render();
  return container;
}


// ═════════════════════════════════════════════════════════════════════════════
// Design 110 §4.2 — the four things the pool tables cannot say
//
// All four are DERIVED and read-only. None adds an authored field, and items 1, 3 and 4
// derive from the SAVED value by calling the same functions the compiler calls — §4.2's
// answer to the objection that every derived display is a second derivation, and the same
// rule §23.6's `_seriesSpecs` refactor exists to enforce one surface over.
//
// Item 2 ("what this claim holds today") is the exception and is allowed to be: it reads
// live account balances, which is not a compile and therefore cannot disagree with one.
// ═════════════════════════════════════════════════════════════════════════════

/** A claim's sleeves as a short phrase — the same words the checkset's `emptyText` uses. */
function claimScopeText(claim) {
  const sleeves = claim?.sleeves;
  return Array.isArray(sleeves) && sleeves.length ? sleeves.join('+') : 'whole account';
}

/**
 * §4.2 item 1 — a pool's claims, ON the pool's row.
 *
 * Today the claims table is joined to the pools table by id, in the reader's head, on every
 * read. This is that join performed once. Derived from the SAVED value rather than from the
 * claims row model, so a half-typed claim (no account picked yet) is not counted as one.
 */
function claimsSummaryOf(savedValue, poolId) {
  const pool = (savedValue?.pools ?? []).find(p => p?.id === poolId);
  if (!pool) return '—';
  const claims = pool.claims ?? [];
  if (!claims.length) return 'holds nothing';
  return claims.map(c => `${c.key} (${claimScopeText(c)})`).join(', ');
}

/**
 * §4.2 item 2 — what ONE claim would hold today, in the claimed account's OWN currency.
 *
 * Per CLAIM and never summed onto the pool, for two reasons §4.2 gives and both matter:
 * `claimValueNative` returns the account's own currency and the editor has no rate, so a
 * pool-level sum across an AUD and a USD claim would be a number with no unit; and the
 * mistake this catches IS per-claim — the wrong sleeve, or a claim that landed in the wrong
 * pool (§22.5 trap 2, which shipped as a DEFAULT fix precisely because nothing on the screen
 * said where the claim had gone).
 *
 * The value comes from `claimValueNative` — exported for this, not re-derived. Its sleeve
 * rule is the non-obvious half and a reader who guessed would have written `balance`: a
 * sleeve-narrowed claim on an account holding no lots is worth NOTHING, not its cash balance.
 */
function claimHoldsNow(accounts, key, sleeves) {
  if (!key) return '';
  const account = (accounts ?? []).find(a => a?.stateKey === key);
  // The account list is the live one. A claim naming a key that is not in it is already a
  // refusal at Rebuild (`normalizeLiquidityGraph` throws on an unknown claim key), so this
  // says the same thing early rather than inventing a zero that reads as an empty account.
  if (!account) return 'no such account';
  const value = claimValueNative(account, Array.isArray(sleeves) && sleeves.length ? sleeves : null);
  const code  = account.currency?.code ?? account.currency ?? '';
  const shown = Math.round(value).toLocaleString('en-US');
  return code ? `${shown} ${code}` : shown;
}

/**
 * §4.2 item 4 — one gate, as one sentence.
 *
 * The clause table is honest and unreadable: a two-branch gate with a dwell is four cells
 * across three rows and the author assembles the meaning themselves. This renders the SAME
 * rows as prose — driven from `gateToRows`, which is the function that populates the table,
 * so the sentence and the table cannot disagree by construction. That is what makes CTRL-3
 * ("the prose names every clause, its basis, its scope and its dwell") a property rather
 * than a pair of lists somebody has to keep in step.
 *
 * It is a description of what the gate SAYS, which is a different object from the panel
 * log's `reason` — that is the runtime evaluator's account of why a gate was shut in one
 * period. Neither can stand in for the other, and this one exists because the author has no
 * run yet.
 */
function describeGate(flowId, gate) {
  if (gate == null) return 'no gate — fires whenever its trigger and amount allow.';
  const rows = gateToRows(flowId, gate);
  // §20.15's escape hatch. A gate outside DNF is carried verbatim and the table does not draw
  // it, so the sentence must not pretend to: a PARTIAL sentence about a gate the author
  // cannot see in the table is worse than saying plainly that it is not drawn here.
  if (rows == null) return 'authored directly — this gate is outside what the clause table draws, '
    + 'and it is kept exactly as written.';
  if (!rows.length) return 'no gate — fires whenever its trigger and amount allow.';

  const scope = rows[0].gateScope === 'EDGE' ? 'filling the destination pool' : 'selling the source pool';
  const branches = [...new Set(rows.map(r => r.branch ?? 1))].sort((a, b) => a - b);
  const parts = branches.map(b => rows.filter(r => (r.branch ?? 1) === b)
    .map(describeClause).join(' AND '));
  const body = parts.length === 1 ? parts[0] : parts.map(t => `(${t})`).join(' OR ');
  return `blocks ${scope} unless ${body}.`;
}

/** One clause row as a phrase — the same words its cells use, plus the dwell. */
function describeClause(r) {
  const label = (GATE_OPTIONS.find(([k]) => k === r.gateKind)?.[1] ?? r.gateKind)
    .replace(' X ', ` ${r.gateValue} `)
    .replace(/ X$/, ` ${r.gateValue}`);
  // The basis is named only where it MEANS something. §20.14's whole point is that a peak
  // balance counts the household's own spending as drawdown while the return index cannot,
  // so a drawdown clause whose basis is unstated is a clause whose behaviour is unstated.
  const basis = isDrawdownClause(r.gateKind)
    ? ` (measured against ${r.gateBasis === 'INDEX' ? 'its return index' : 'its peak balance'})`
    : '';
  // §20.13 measured DURATION, not level, as the lever that moves the answer — the three
  // drawdown thresholds landed within $13k while the same gate family differing only in
  // dwell spread by $460k. It is named whenever it binds.
  const dwell = (r.gateYears ?? 1) > 1 ? ` for ${r.gateYears} consecutive years` : '';
  const sense = r.gateNegate === 'NOT' ? 'NOT ' : '';
  return `${sense}${label}${basis}${dwell}`;
}

/**
 * §10.5 / CTRL-15 — which of three states the graph on screen is in.
 *
 * The readouts render in ALL THREE. Hiding them when the graph is switched off would make
 * the switch a way to stop seeing the graph you are editing, and validation already refuses
 * to do that: `collectAuthoredGraphProblems` keeps reporting while `liquidityGraphEnabled`
 * is false, "because the switch is a run-time 'ignore this', not an authoring-time 'this is
 * fine'". But a compiled-order readout under `liquidityGraphEnabled: false` describes an
 * order the run will NOT use, so the line has to say so — §21.3's provenance strip solved
 * exactly this problem one surface over, and this reuses its vocabulary so the two surfaces
 * say the same words.
 */
function graphProvenanceText(flags) {
  // A named shape is a fourth state, and the three above would all lie about it: a shape is
  // live only in the years its schedule selects it, so "this is the order the run will use"
  // is false for every other year, and `liquidityGraphEnabled: false` switches the shapes off
  // with the base graph. Design 109 §7 makes the switch date and the authored year differ by
  // up to a cadence, which is exactly why this line names the SHAPE and not a date.
  if (flags?.shapeId) {
    if (flags?.liquidityGraphEnabled === false) {
      return `Shape '${flags.shapeId}' — liquidityGraphEnabled is OFF, so no shape is used at all.`;
    }
    return `Shape '${flags.shapeId}' — this is the order in the years the schedule selects it, `
      + 'not the whole run.';
  }
  if (flags?.liquidityGraphEnabled === false) {
    return 'liquidityGraphEnabled is OFF — these pools are authored, and this order will NOT be used: '
      + 'the run falls back to drawdownPriority.';
  }
  if (flags?.poolFlowsEnabled === false) {
    return 'poolFlowsEnabled is OFF — the spend order below IS used and the targets are live, '
      + 'but no refill edge will fire.';
  }
  return 'The graph is live — this is the order and these are the gates the run will use.';
}

/**
 * The advisories that belong to THIS editor instance (design 110 §4.3).
 *
 * A shape's editor shows the warnings naming that shape; the base graph's editor shows the
 * rest. Without the split, every one of the N shape editors on a scheduled plan would repeat
 * every warning — which is the "a run through three shapes reports the third" mistake §5.3
 * names, in the shape of saying everything everywhere instead of saying it in the wrong place.
 */
function advisoriesFor(flags, shapeId) {
  const all = (flags?.problems ?? []).filter(x => x?.severity === 'warn');
  return shapeId == null ? all.filter(x => x.shape == null) : all.filter(x => x.shape === shapeId);
}

/**
 * The block under the four tables: §4.2 items 3 and 4, behind §10.5's provenance line.
 *
 * `flags` is a PROVIDER, not a captured value, for the reason the schedule editor reads its
 * shape ids live (see `scenario-tab-view`): the two switches are sibling params, and one
 * toggled without a full re-render would otherwise leave this line stating the old state.
 *
 * Returns the container, carrying a `.refresh()` the editor calls after every sync.
 */
function buildGraphReadouts(param, accounts, flags) {
  const container = el('div', 'liquidity-graph-readouts');

  /** Which shape this editor instance is drawing, or null for the base graph. */
  const shapeIdOf = (f) => (typeof f === 'function' ? f() : f)?.shapeId ?? null;

  const render = () => {
    container.innerHTML = '';

    const provenance = el('div', 'pool-readout-provenance', graphProvenanceText(
      typeof flags === 'function' ? flags() : flags));
    provenance.dataset.id = 'graph-provenance';
    container.appendChild(provenance);

    // ── §4.3: the advisories, where an author can see them ───────────────────
    //
    // `_warnUnscheduledShapes` and `_warnResurrectedPools` were `console.warn`, and design
    // 109 §12 rule 3 says of the first: "an author who forgot to schedule the shape they just
    // wrote is the common case, and this is the ONLY signal they get." In the app that signal
    // went to the browser console and in the CLI tools it went nowhere at all
    // (`cli-tools-swallow-loader-warnings`). They are rendered here, above the readouts,
    // because they describe the graph the author is looking at — and they do NOT refuse
    // anything: every surface that decides a Rebuild filters them out with
    // `blockingProblems`.
    for (const w of advisoriesFor(typeof flags === 'function' ? flags() : flags, shapeIdOf(flags))) {
      const note = el('div', 'pool-readout pool-readout--warn', w.message);
      note.dataset.id = 'graph-advisory';
      container.appendChild(note);
    }

    const value = param.value;
    if (!value?.pools?.length) return;

    // ── §4.2 item 3: the compiled spend order ────────────────────────────────
    //
    // `compileToDrawdownSequence` is pure and available, and it takes a NORMALIZED graph —
    // so the normalizer runs first, and its throw is shown rather than swallowed. The author
    // sees the compiler's own sentence, which is the same rule `collectAuthoredGraphProblems`
    // follows. §22.5 trap 1 (a new pool behind `growth`, never reached, author concludes the
    // input is broken) was fixed by changing the default; this is what helps the author who
    // types 35 where they meant 15.
    let order = el('div', 'pool-readout');
    order.dataset.id = 'compiled-order';
    let normalized = null;
    let compileError = null;
    try {
      normalized = normalizeLiquidityGraph(value, accounts);
    } catch (e) {
      compileError = e;
    }
    const seq = normalized ? compileToDrawdownSequence(normalized) : null;
    if (compileError) {
      order.className = 'pool-readout pool-readout--problem';
      order.textContent = `Spend order: ${compileError.message}`;
    } else if (!seq?.length) {
      // §3.1 rule 3 made visible. A graph whose pools all have a blank `spendOrder` compiles
      // to NOTHING, and the run falls back to `drawdownPriority` — which looks identical to
      // "the graph did not load" from every other surface.
      order.textContent = 'Spend order: no pool has a Spend #, so nothing is drawn from the graph — '
        + 'the drawdownPriority order applies to every account.';
    } else {
      const spent = new Set(seq.map(e => e.key));
      const never = (normalized.pools ?? []).filter(p => p.spendOrder == null).map(p => p.id);
      // §3.1 rule 3 on its OWN element, not appended to the list. Run together they read as
      // one sentence ending "…22. spouseRothAccount (whole account) Anything this order does
      // not claim follows it…" — the runs of spaces that were meant to separate them collapse
      // in HTML, which is only visible in a browser (§12.2).
      order.textContent = 'Spend order: '
        + seq.map((e, i) => `${i + 1}. ${e.key} (${e.sleeves?.length ? e.sleeves.join('+') : 'whole account'})`
            + (e.allowPenalty ? ' [penalty OK]' : '')).join('  ·  ')
        + (never.length ? `  —  never spent from: ${never.join(', ')}.` : '');
      const rule = el('div', 'pool-readout pool-readout--rule',
        'Anything this order does not claim follows it in drawdownPriority order.');
      rule.dataset.id = 'compiled-order-rule';
      container.appendChild(order);
      container.appendChild(rule);
      order = null;
    }
    if (order) container.appendChild(order);

    // ── §4.2 item 1: each pool's claims ──────────────────────────────────────
    //
    // Under the tables, NOT as a cell on the Pools row as §4.2 first proposed. Measured in
    // the running app on a real plan (§12.2's "verify in the running app, not only in
    // jsdom"): the params pane is ~550px, the Pools table already has eleven columns in it,
    // and a twelfth took ~13% off every one of them — `Id` fell from 39px to 34px and
    // `Target` from 63px to 55px, on cells that were already truncating a mode name to three
    // characters. A derived readout must not cost the authoring surface the width it needs to
    // be authored in, and here it bought an ellipsis with somebody else's column.
    //
    // It reads better down here anyway: the whole string fits, so the join is legible rather
    // than hinted at behind a tooltip.
    const claimsHead = el('div', 'age-band-col-label', 'What each pool holds');
    container.appendChild(claimsHead);
    for (const pool of value.pools) {
      const line = el('div', 'pool-readout',
        `${pool.id}: ${claimsSummaryOf(value, pool.id)}`);
      line.dataset.id = `pool-claims-${pool.id}`;
      container.appendChild(line);
    }

    // ── §4.2 item 4: each gate as one sentence ───────────────────────────────
    //
    // Deliberately NOT behind the compile succeeding. This derives from `gateToRows` — the
    // function that fills the clause table — and needs no normalized graph, while "the graph
    // does not compile" is the state the author is in when they most need to read back what
    // they wrote. Making the sentence disappear with the first bad cell elsewhere in the
    // graph would be the §2.3 short-circuit repeated in a new place.
    const flows = value.flows ?? [];
    if (flows.length) {
      const head = el('div', 'age-band-col-label', 'Gates, as sentences');
      container.appendChild(head);
      for (const f of flows) {
        const line = el('div', 'pool-readout', `${f.id}: ${describeGate(f.id ?? null, f.gate ?? null)}`);
        line.dataset.id = `gate-prose-${f.id}`;
        container.appendChild(line);
      }
    }
  };

  render();
  container.refresh = render;
  return container;
}

export function buildLiquidityGraphEditor(param, accounts = [], flags = null) {
  const value = isPlainObject(param.value) ? param.value : {};

  // Pools, minus their claims — the claims live in their own table (see the header note).
  const pools = (Array.isArray(value.pools) ? value.pools : []).map(p => ({
    id:          p?.id ?? null,
    label:       p?.label ?? null,
    spendOrder:  Number.isFinite(Number(p?.spendOrder)) ? Number(p.spendOrder) : null,
    targetMode:  p?.target?.mode ?? '',
    targetValue: Number.isFinite(Number(p?.target?.value)) ? Number(p.target.value) : null,
    // §12.2b. Drawn, not carried, so it can be ticked rather than hand-authored — which means
    // it also has to come OUT of `targetExtra` below, or the sync writes it twice.
    targetAfter: Array.isArray(p?.target?.after) ? [...p.target.after] : [],
    // Design 107 §15.3. Drawn rather than carried, for the reason `targetAfter` is: it
    // decides whether the pool wants anything at all, so an author who cannot see it cannot
    // tell a float that is empty because it is abroad from one that is empty because it
    // failed to fill. Like `targetAfter`, being drawn means it must also come OUT of
    // `targetExtra` below or the sync writes it twice.
    targetWhenResident: p?.target?.whenResident ?? '',
    // §24.5. Absent is PENALTY_FREE — the default, and what every graph authored before it
    // means — so the cell always shows the policy in force rather than an empty box.
    access:      p?.access?.mode ?? 'PENALTY_FREE',
    capacity:    p?.capacity?.mode ?? 'BALANCE',
    // The capacity of an AMOUNT / YEARS_OF_SPEND pool. Without this cell those two modes are
    // selectable and unauthorable: `sizeSpec` requires a value for every non-derived mode, so
    // picking one wrote a graph that threw at Rebuild.
    capacityValue: Number.isFinite(Number(p?.capacity?.value)) ? Number(p.capacity.value) : null,
    // Carried, not drawn — see `extraKeys`.
    floor:         p?.floor ?? null,
    targetExtra:   extraKeys(p?.target,   ['mode', 'value', 'after', 'whenResident']),
    capacityExtra: extraKeys(p?.capacity, ['mode', 'value']),
    // Round-tripped untouched: `ui` is opaque to the engine and belongs to the editor that
    // effort 2 will build (design 97 §14). Dropping it here would silently discard a layout.
    ui:          p?.ui ?? null,
  }));

  const claims = (Array.isArray(value.pools) ? value.pools : []).flatMap(p =>
    (Array.isArray(p?.claims) ? p.claims : []).map(c => ({
      pool:    p?.id ?? null,
      key:     typeof c === 'string' ? c : (c?.key ?? null),
      sleeves: Array.isArray(c?.sleeves) && c.sleeves.length ? [...c.sleeves] : null,
    })));

  const flows = (Array.isArray(value.flows) ? value.flows : []).map(f => {
    const t = f?.trigger ?? {};
    const triggerKind = t.belowTargetFraction != null ? 'belowTargetFraction'
      : t.below?.mode === 'YEARS_OF_SPEND' ? 'belowYears'
      : t.below != null ? 'belowAmount' : '';
    const triggerValue = triggerKind === 'belowTargetFraction' ? t.belowTargetFraction
      : t.below?.value ?? null;
    // The gate lives in its own table (§20.15). `rawGate` is the escape hatch: a gate the
    // clause rows cannot express is carried through verbatim rather than flattened, because
    // silently dropping half a composed gate leaves a graph that still loads and still runs.
    const rows = gateToRows(f?.id ?? null, f?.gate ?? null);
    return {
      id: f?.id ?? null, from: f?.from ?? null, to: f?.to ?? null,
      priority: Number.isFinite(Number(f?.priority)) ? Number(f.priority) : 0,
      cadence: (f?.cadence === 'ANNUAL' || f?.cadence === 'PAYCHECK') ? f.cadence : 'PERIOD',
      triggerKind, triggerValue,
      rawGate: rows == null ? (f?.gate ?? null) : null,
      amountKind:  f?.amount?.fractionOfSource != null ? 'fractionOfSource' : 'toTarget',
      amountValue: f?.amount?.fractionOfSource ?? null,
      // Carried, not drawn — see `extraKeys`.
      amountExtra:  extraKeys(f?.amount, ['toTarget', 'fractionOfSource']),
      triggerExtra: extraKeys(f?.trigger?.below, ['mode', 'value']),
      // Round-tripped untouched, exactly as a pool's is. `normalizeLiquidityGraph` carries
      // `raw.ui` on flows as well as pools, so an edge CAN hold a layout; until CTRL-1 the
      // row model did not, and the first edit to any cell dropped it — the graph still loaded
      // and still ran, which is what made it invisible (design 110 §2.2).
      ui:           f?.ui ?? null,
    };
  });

  // Every representable flow's gate, as one flat table keyed by flow id and branch.
  const gateClauses = (Array.isArray(value.flows) ? value.flows : [])
    .flatMap(f => gateToRows(f?.id ?? null, f?.gate ?? null) ?? []);

  const poolIdOptions = () => pools.filter(p => p.id).map(p => [p.id, p.label || p.id]);

  const sync = () => {
    const kept = pools.filter(p => p.id);
    if (!kept.length) { param.value = null; return; }
    param.value = {
      pools: kept.map(p => ({
        id: p.id,
        ...(p.label ? { label: p.label } : {}),
        ...(p.spendOrder != null ? { spendOrder: p.spendOrder } : {}),
        ...(p.targetMode
          ? { target: { mode: p.targetMode, value: p.targetValue ?? 0,
                        // Pruned to pools that still exist: renaming one otherwise leaves a
                        // reference that is INVISIBLE in the checkset (only live ids are drawn)
                        // and throws at Rebuild — the exact "invisible until it throws" shape
                        // this editor exists to remove. Dropping it unticks a box the user can
                        // see instead.
                        ...(TARGET_NEEDS_AFTER.includes(p.targetMode)
                          ? { after: (p.targetAfter ?? []).filter(
                                id => id !== p.id && kept.some(q => q.id === id)) }
                          : {}),
                        ...(p.targetWhenResident ? { whenResident: p.targetWhenResident } : {}),
                        ...(p.targetExtra ?? {}) } }
          : {}),
        ...(p.capacity && p.capacity !== 'BALANCE'
          ? { capacity: { mode: p.capacity,
                          ...(CAPACITY_NEEDS_VALUE.includes(p.capacity)
                            ? { value: p.capacityValue ?? 0 } : {}),
                          ...(p.capacityExtra ?? {}) } }
          : {}),
        // §24.5 — written only when it DEVIATES from the default, on the §22.9 rule: the only
        // value that ever appears in a file is a decision somebody actually made, and absent
        // means "the default applies". Writing `PENALTY_FREE` on every pool would put the
        // default in every scenario file and make it look authored.
        ...(p.access === 'ALLOW_PENALTY' ? { access: { mode: 'ALLOW_PENALTY' } } : {}),
        ...(p.floor ? { floor: p.floor } : {}),
        ...(p.ui ? { ui: p.ui } : {}),
        claims: claims.filter(c => c.pool === p.id && c.key)
          .map(c => ({ key: c.key, ...(c.sleeves?.length ? { sleeves: [...c.sleeves] } : {}) })),
      })),
      ...(flows.some(f => f.id && f.from && f.to)
        ? { flows: flows.filter(f => f.id && f.from && f.to)
              .map(f => buildFlow(f, gateClauses.filter(c => c.flow === f.id))) }
        : {}),
    };
  };

  const container = el('div', 'age-band-list-editor liquidity-graph-editor');

  const claimsEditor = buildRowListEditor({
    rows: claims,
    columns: [
      { field: 'pool',    label: 'Pool',    type: 'select', options: poolIdOptions, width: '1.2fr' },
      { field: 'key',     label: 'Account', type: 'select', options: accountOptions(accounts),
        rerender: true, width: '1.6fr' },
      { field: 'sleeves', label: 'Sleeves (blank = whole account)', type: 'checkset',
        options: sleeveOptionsFor(accounts), blankValue: null, width: '2fr',
        emptyText: 'whole account' },
      // §4.2 item 2 — a DERIVED cell, in the claimed account's OWN currency and never summed
      // onto the pool. It is on the CLAIM row because that is where the mistake is: the wrong
      // sleeve, or a claim that landed in the wrong pool. A pool-level total needs FX and a
      // period, which is the panel's job and is done correctly there.
      { field: 'holdsNow', label: 'Holds today', type: 'note', width: '1.1fr',
        text: (row) => claimHoldsNow(accounts, row?.key, row?.sleeves),
        title: (row) => (row?.key
          ? `What a draw would find in ${row.key} (${claimScopeText(row)}) right now, in that `
            + 'account\u2019s own currency. Live balances \u2014 not a prediction of which pool a '
            + 'spend would reach (design 110 \u00a710.4).'
          : '') },
    ],
    // §22.5 trap 2 — the LAST pool, not the first. `+ Add Pool` then `+ Add Claim` is the
    // authoring order, so defaulting to `pools[0]` silently landed the new pool's first claim
    // in bucket 1 — a claim that reads correct in the table and belongs to the wrong pool.
    newRow:    () => ({ pool: pools[pools.length - 1]?.id ?? null,
                        key: accounts?.[0]?.stateKey ?? null, sleeves: null }),
    addLabel:  '+ Add Claim',
    emptyText: 'No claims — a pool with no claims holds nothing.',
    // The Pools table's derived "Claims" cell reads this table, so it has to be redrawn
    // here — the mirror of the refresh the pools table already does on the other two. A
    // `refresh()` re-renders and does NOT fire `onChange`, so the two cannot loop.
    onChange:  () => { sync(); poolsEditor.refresh(); readouts.refresh(); },
  });

  const flowsEditor = buildRowListEditor({
    rows: flows,
    columns: [
      { field: 'id',           label: 'Id',       type: 'text',   placeholder: 'g2r', width: '0.9fr' },
      { field: 'from',         label: 'From',     type: 'select', options: poolIdOptions, width: '1fr' },
      { field: 'to',           label: 'To',       type: 'select', options: poolIdOptions, width: '1fr' },
      { field: 'priority',     label: 'Pri',      type: 'number', step: '1', width: '0.5fr' },
      { field: 'triggerKind',  label: 'Trigger',  type: 'select', options: TRIGGER_OPTIONS, width: '1.2fr' },
      { field: 'triggerValue', label: 'at',       type: 'number', step: '0.01', width: '0.6fr' },
      { field: 'cadence',      label: 'Cadence',  type: 'select', options: CADENCE_OPTIONS, width: '1fr' },
      { field: 'amountKind',   label: 'Amount',   type: 'select', options: AMOUNT_OPTIONS, width: '1.1fr' },
      { field: 'amountValue',  label: 'f',        type: 'number', step: '0.05', min: '0', max: '1', width: '0.6fr' },
    ],
    newRow:    () => ({ id: null, from: pools[0]?.id ?? null, to: pools[1]?.id ?? null, priority: 0,
                        cadence: 'PERIOD', triggerKind: '', triggerValue: null, rawGate: null,
                        amountKind: 'toTarget', amountValue: null,
                        amountExtra: null, triggerExtra: null, ui: null }),
    addLabel:  '+ Add Flow',
    emptyText: 'No flows — pools are spent in order but never refilled by an explicit rule.',
    // Renaming a flow changes the option list the gate table selects from — the same reason
    // the pools table refreshes the claims and flows tables (§17.1).
    onChange:  () => { sync(); gateEditor.refresh(); readouts.refresh(); },
  });

  // §20.15's table. Keyed by flow id and branch: same-branch rows are ANDed, branches are
  // ORed — "within 5% of its high for a year, OR within 1% for two" is two rows, two branches.
  //
  // Only flows whose gate the table can DRAW are selectable. A flow carrying a `rawGate` keeps
  // its authored gate verbatim (see `buildFlow`), so a clause row typed against it would be
  // silently ignored — the row would be on screen, saved nowhere, and the flow would go on
  // running the gate the author could not see.
  const flowIdOptions = () => flows.filter(f => f.id && !f.rawGate).map(f => [f.id, f.id]);
  const gateableFlowIds = () => flows.filter(f => f.id && !f.rawGate).map(f => f.id);

  /**
   * The OR # is a POSITION, not a label: `rowsToGate` emits one `anyOf` branch per distinct
   * number in ascending order, so 1 and 3 save as — and reload as — 1 and 2, and a lone
   * branch collapses to a bare node with no number at all. Renumbering here makes the table
   * show that immediately, rather than letting the author discover on the next load that the
   * 3 they typed reads as a 2.
   */
  const renumberBranches = () => {
    let moved = false;
    for (const id of new Set(gateClauses.map(c => c.flow))) {
      const mine = gateClauses.filter(c => c.flow === id);
      const dense = new Map([...new Set(mine.map(c => c.branch ?? 1))]
        .sort((a, b) => a - b).map((n, i) => [n, i + 1]));
      for (const c of mine) {
        const next = dense.get(c.branch ?? 1);
        if (c.branch !== next) { c.branch = next; moved = true; }
      }
    }
    return moved;
  };

  /**
   * Keep each row's basis in step with its own clause kind.
   *
   * A kind change leaves the basis cell holding the previous kind's value, and the two
   * directions fail differently: a drawdown row switched to a RETURN keeps an 'INDEX' that no
   * longer means anything (and that `rowsToGate` already declines to save), while a return row
   * switched to a DRAWDOWN keeps a blank where the gate genuinely defaults to BALANCE. Neither
   * loses data — the save path is the authority on what reaches the graph — but both put a
   * value on screen that disagrees with the row it sits in, which is the same class of thing
   * as the "(not found)" this pass exists to stop.
   */
  const normalizeGateBases = () => {
    let moved = false;
    for (const c of gateClauses) {
      const want = isDrawdownClause(c.gateKind) ? (c.gateBasis || 'BALANCE') : '';
      if (c.gateBasis !== want) { c.gateBasis = want; moved = true; }
    }
    return moved;
  };
  /**
   * One gate, one scope (§12.4c). The scope is a property of the gate ROOT and the table is
   * one row per clause, so an edit on any row has to reach the rest of its flow — otherwise
   * `rowsToGate` picks a winner the author cannot see, and a two-clause gate would silently
   * save whichever row happened to say EDGE.
   *
   * The row that CHANGED is the one that differs from what this flow last agreed on, which is
   * why the previous value is remembered rather than re-read from the graph: by the time this
   * runs the graph has not been rebuilt yet.
   */
  const lastScope = new Map();
  const syncGateScopes = () => {
    let moved = false;
    for (const id of new Set(gateClauses.map(c => c.flow))) {
      const mine = gateClauses.filter(c => c.flow === id);
      const prev = lastScope.get(id);
      const changed = mine.find(c => c.gateScope !== prev);
      const want = (prev == null || !changed) ? (mine[0]?.gateScope ?? 'SOURCE') : changed.gateScope;
      for (const c of mine) if (c.gateScope !== want) { c.gateScope = want; moved = true; }
      lastScope.set(id, want);
    }
    return moved;
  };
  const gateEditor = buildRowListEditor({
    rows: gateClauses,
    columns: [
      { field: 'flow',      label: 'Flow',   type: 'select', options: flowIdOptions, width: '1fr' },
      // Rows sharing a number are ANDed; each distinct number is an OR branch. A number
      // rather than a group control because the shared row component is flat by design
      // (§17.1) and because it is what makes "add one more alternative" one more row.
      { field: 'branch',    label: 'OR #',   type: 'number', step: '1', min: '1', width: '0.5fr' },
      { field: 'gateNegate', label: 'Sense', type: 'select', options: GATE_SENSE_OPTIONS, width: '0.8fr' },
      // `rerender`: the Measured-against cell beside this one offers a different list per
      // clause kind, so a kind change has to redraw the row or the basis cell keeps the
      // options of the kind it no longer is.
      { field: 'gateKind',  label: 'Clause', type: 'select', options: GATE_OPTIONS,
        rerender: true, width: '1.8fr' },
      // No min of 0: a RETURN threshold is legitimately negative ("harvest unless the market
      // is down more than 10%"), while a drawdown fraction is not. The normalizer enforces
      // the per-kind range; the control must not pre-empt it with the tighter one.
      { field: 'gateValue', label: 'X',      type: 'number', step: '0.01', min: '-1', max: '1', width: '0.6fr' },
      { field: 'gateBasis', label: 'Measured against', type: 'select', options: gateBasisOptionsFor, width: '1.8fr' },
      // The lever design 97 §20.13 measured as the one that moves the answer: the three
      // drawdown thresholds landed within $13k of each other, while the same gate family
      // differing only in how long it stays shut spread by $460k. Years, never periods —
      // this reducer fires twice a year in a cross-border plan (§20.15).
      { field: 'gateYears', label: 'for N yrs', type: 'number', step: '1', min: '1', width: '0.7fr' },
      // §12.4c. One per GATE, not per clause — `syncGateScopes` propagates an edit to every
      // row of the same flow, so the table can never show one gate with two scopes. SOURCE is
      // the stricter reading and stays the default; see the design section before assuming
      // EDGE is simply safer.
      { field: 'gateScope', label: 'Vetoes', type: 'select', options: GATE_SCOPE_OPTIONS, width: '1.4fr' },
      // Design 110 §6.3 option A — the clause's optional ADDRESS, and the only reason a
      // threshold can be an axis at all. Blank is what every graph authored so far means:
      // positional, and not searchable. Filling it in generates `gate.<id>.threshold` and
      // `gate.<id>.dwell` at the next Rebuild.
      //
      // LAST column deliberately. It is the one cell that changes nothing about the run, so
      // putting it in front of the clause would push the gate's actual content off the read.
      { field: 'gateId',    label: 'Search id', type: 'text', placeholder: '—', width: '1fr' },
    ],
    newRow:    () => ({ flow: gateableFlowIds()[0] ?? null, branch: 1, gateNegate: '',
                        gateKind: 'sourceDrawdownUnder', gateValue: 0.05,
                        gateBasis: 'INDEX', gateYears: 1, gateScope: 'SOURCE', gateId: null }),
    addLabel:  '+ Add Gate Clause',
    emptyText: 'No gate clauses — every flow fires whenever its trigger and amount allow.',
    onChange:  () => {
      // All three, never short-circuited: each is a repair the table owes the author.
      const scoped     = syncGateScopes();
      const renumbered = renumberBranches();
      const rebased    = normalizeGateBases();
      const moved      = scoped || renumbered || rebased;
      sync();
      readouts.refresh();
      if (moved) gateEditor.refresh();
    },
  });

  const poolsEditor = buildRowListEditor({
    rows: pools,
    columns: [
      // `rerender` so a rename redraws the sibling rows' `Remainder of` checksets: only live
      // ids are drawn there, so without it a renamed pool leaves a tick the user cannot see
      // and cannot untick. `sync` prunes the reference; this is what makes the prune visible.
      { field: 'id',          label: 'Id',       type: 'text',   placeholder: 'reserve',
        rerender: true, width: '1fr' },
      { field: 'label',       label: 'Label',    type: 'text',   placeholder: 'Bucket 2', width: '1.3fr' },
      { field: 'spendOrder',  label: 'Spend #',  type: 'number', step: '10', placeholder: 'never', width: '0.7fr' },
      // `rerender` on both mode cells: the Size cell beside each one takes its bounds from
      // the mode, so a mode change has to redraw the row or the new mode keeps the old range.
      { field: 'targetMode',  label: 'Target',   type: 'select', options: TARGET_MODE_OPTIONS,
        rerender: true, width: '1.6fr' },
      { field: 'targetValue', label: 'Size',     type: 'number',
        step: sizeAttr('targetMode', 'step'), min: sizeAttr('targetMode', 'min'),
        max:  sizeAttr('targetMode', 'max'),  title: sizeAttr('targetMode', 'title'), width: '0.7fr' },
      // Design 107 §15.3 — the target applies only while the household lives there; elsewhere
      // it resolves to 0 (hold nothing here), which is what drives the cross-border float
      // hand-over and the sweep. Blank = always, i.e. every plan that does not move.
      { field: 'targetWhenResident', label: 'While in', type: 'select', width: '0.9fr',
        options: [['', 'anywhere'], ['US', 'US'], ['AU', 'AU']] },
      // §12.2b. Blank for every other target mode — `buildCheckSet` renders `emptyText` when a
      // row has no options, which is what a non-remainder row wants anyway.
      { field: 'targetAfter', label: 'Remainder of', type: 'checkset', width: '1.6fr',
        emptyText: '—',
        options: (row) => (TARGET_NEEDS_AFTER.includes(row?.targetMode)
          ? pools.filter(q => q.id && q.id !== row?.id
              // A remainder naming another remainder throws (the resolution ORDER would decide
              // the answer), so it is not offered — the same rule the compiler enforces, kept
              // off the screen rather than explained after the fact.
              && !TARGET_NEEDS_AFTER.includes(q.targetMode)).map(q => [q.id, q.label || q.id])
          : []) },
      // §24.5 — beside Spend # rather than at the end: both answer "when may this pool be
      // spent", and an early-access policy read in isolation from the spend order is the
      // §18.6 mistake (a pool nothing reaches cannot be raided either way).
      { field: 'access',      label: 'Early access', type: 'select', options: ACCESS_MODE_OPTIONS,
        width: '1.7fr' },
      { field: 'capacity',    label: 'Capacity', type: 'select', options: CAPACITY_MODE_OPTIONS,
        rerender: true, width: '1.5fr' },
      // Blank on BALANCE / OFFSET_CAP, whose ceiling is derived from live state.
      { field: 'capacityValue', label: 'Cap size', type: 'number',
        step: sizeAttr('capacity', 'step'), min: sizeAttr('capacity', 'min'),
        max:  sizeAttr('capacity', 'max'),  title: sizeAttr('capacity', 'title'), width: '0.7fr' },
    ],
    // §22.5 trap 1 — `spendOrder` starts BLANK ("never"), not `(pools.length + 1) * 10`.
    // Defaulting it put every new pool BEHIND `growth`, which on most plans is the residual
    // pool and never runs dry, so the new pool was never reached: §18.6's corollary says a
    // pool placed after one that never empties is not low-priority, it is UNCLAIMED. The
    // author added a pool, rebuilt, saw no change, and concluded the input did not work. Blank
    // makes the position a decision — the placeholder already reads `never`.
    newRow:    () => ({ id: null, label: null, spendOrder: null, access: 'PENALTY_FREE',
                        targetMode: '', targetValue: null, targetAfter: [], capacity: 'BALANCE',
                        capacityValue: null, floor: null, targetExtra: null, targetWhenResident: '',
                        capacityExtra: null, ui: null }),
    addLabel:  '+ Add Pool',
    emptyText: 'No pools — the drawdownPriority order applies and nothing refills (the default).',
    // Renaming or adding a pool changes the option list the OTHER two tables select from,
    // so both are re-rendered. Without this a renamed pool leaves its claims pointing at a
    // dead id and the user finds out at Rebuild.
    onChange:  () => { sync(); claimsEditor.refresh(); flowsEditor.refresh(); readouts.refresh(); },
  });

  container.appendChild(el('div', 'age-band-col-label', 'Pools'));
  container.appendChild(poolsEditor);
  container.appendChild(el('div', 'age-band-col-label', 'Claims — which accounts and sleeves each pool holds'));
  container.appendChild(claimsEditor);
  container.appendChild(el('div', 'age-band-col-label', 'Flows — refill edges between pools'));
  container.appendChild(flowsEditor);
  container.appendChild(el('div', 'age-band-col-label',
    'Gate clauses — when a flow\'s SOURCE may be sold. Rows sharing an OR # are ANDed; each OR # is '
    + 'an alternative, renumbered from 1. “when NOT” negates the clause, which is how a DOWN-market '
    + 'rule is said. A flow whose authored gate the table cannot draw is not listed.'));
  container.appendChild(gateEditor);

  // §4.2 items 3 and 4, behind §10.5's provenance line. Built AFTER the tables so its first
  // render sees the value `sync()` below writes — and referenced by every table's `onChange`
  // above, which is a closure and therefore reaches it whatever the declaration order.
  const readouts = buildGraphReadouts(param, accounts, flags);
  container.appendChild(readouts);

  sync();
  readouts.refresh();
  return container;
}

/**
 * A flow's `gate` ⇄ a flat list of clause rows (design 97 §20.15, and §17.1's argument).
 *
 * The engine's gate is a TREE. §17.1's rule for the graph applies to it unchanged: a list of
 * lists becomes a flat table keyed by the id above it, so every table in this editor is the
 * same shared component and none is bespoke. The keys here are the flow id and a BRANCH
 * number — rows sharing a branch are ANDed, and the branches are ORed:
 *
 *   flow  branch  clause                                     for
 *   g2o     1     source within 0.05 of its high (INDEX)      1      ⎫ OR
 *   g2o     2     source within 0.01 of its high (INDEX)      2      ⎭
 *
 * which is exactly `{ anyOf: [ {…}, {…} ] }` — disjunctive normal form. Every gate the engine
 * accepts is not expressible this way (a nested `not`, an OR inside an AND), and the editor
 * must not mangle one it cannot draw: `gateToRows` returns null for anything outside DNF, and
 * the flow keeps its authored gate verbatim in `rawGate`, round-tripped the way `ui` is.
 */
const GATE_CLAUSE_KINDS = ['sourceReturnOver', 'targetReturnUnder',
                           'sourceDrawdownUnder', 'targetDrawdownOver'];

/** One node → one row, or null when the node says more than a row can. */
function gateNodeToRow(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  // `{ not: {…} }`, optionally carrying the dwell on the node that HOLDS the negation, is one
  // negated row. The two places a dwell can sit under a `not` say different things — "the
  // clause has not held for n years" (inner) versus "its negation has held for n years"
  // (outer) — and the row can only mean the second, so an inner dwell is left to `rawGate`
  // rather than silently re-read as the other policy.
  if (node.not != null) {
    if (Object.keys(node).some(k => k !== 'not' && k !== 'sustainedYears' && k !== 'id')) return null;
    const inner = gateNodeToRow(node.not);
    if (!inner || inner.gateNegate === 'NOT' || inner.gateYears > 1) return null;
    // The id belongs to the node the ROW IS — the `not`, which is also where the dwell sits. An
    // id on the clause INSIDE the negation is a second address for the same row and the table
    // cannot show two, so such a gate goes to `rawGate` verbatim rather than losing one of them.
    if (inner.gateId != null) return null;
    return { ...inner, gateNegate: 'NOT', gateYears: node.sustainedYears ?? 1,
             gateId: typeof node.id === 'string' ? node.id : null };
  }
  if (node.anyOf || node.allOf) return null;                      // a child: not a leaf row
  const kinds = GATE_CLAUSE_KINDS.filter(k => node[k] != null);
  if (kinds.length !== 1) return null;                            // 0 says nothing, 2+ is an AND
  // `id` is design 110 §6.3's optional ADDRESS. It joins the known set rather than sending the
  // clause to `rawGate`: it is drawable (one text cell) and, unlike a nested scope, it round-trips
  // faithfully — which is the guard's actual test.
  const known = new Set([...GATE_CLAUSE_KINDS, 'sustainedYears', 'drawdownBasis', 'id']);
  if (Object.keys(node).some(k => !known.has(k))) return null;    // a clause the table lacks
  const kind = kinds[0];
  return {
    gateNegate: '',
    gateKind:  kind,
    gateValue: node[kind],
    gateBasis: isDrawdownClause(kind) ? (node.drawdownBasis ?? 'BALANCE') : '',
    gateYears: node.sustainedYears ?? 1,
    gateId:    typeof node.id === 'string' ? node.id : null,
  };
}

/** A flow's gate → clause rows in DNF, or null when it is not expressible as rows. */
function gateToRows(flowId, gate) {
  if (gate == null) return [];
  // §12.4c — `scope` is a property of the gate ROOT, not a clause, so it is split off BEFORE
  // the leaf test. On a single-clause gate the root IS the leaf, and `gateNodeToRow`'s
  // unknown-key guard would otherwise see `scope`, refuse the row, and send the whole flow to
  // `rawGate` — the gate survives (buildFlow returns it verbatim) but the table draws NOTHING,
  // so an author who set the scope and reopened the editor saw their gate vanish.
  //
  // Stripped here rather than added to that guard's `known` set on purpose: the guard's job is
  // to send anything it cannot faithfully draw to `rawGate`, and a scope nested on a CLAUSE is
  // exactly such a thing (`normalizeGate` rejects one outright). Widening the leaf's vocabulary
  // would make a nested scope silently drawable and then silently dropped on save.
  const isArr = Array.isArray(gate);
  const scope = (!isArr && gate.scope) || 'SOURCE';
  const root  = isArr ? gate : Object.fromEntries(Object.entries(gate).filter(([k]) => k !== 'scope'));
  const branches = isArr ? [{ allOf: root }]
    : root.anyOf ? root.anyOf : [root];
  // An `anyOf` carrying clauses of its own is an AND-over-an-OR; the table cannot say it.
  if (!isArr && root.anyOf && (root.not || root.allOf || GATE_CLAUSE_KINDS.some(k => root[k] != null))) return null;
  const rows = [];
  for (const [i, branch] of branches.entries()) {
    const nodes = Array.isArray(branch) ? branch : (branch?.allOf ?? [branch]);
    if (branch?.allOf && (branch.anyOf || branch.not || branch.sustainedYears != null)) return null;
    for (const node of nodes) {
      const row = gateNodeToRow(node);
      if (!row) return null;
      // §12.4c — the scope lives on the gate ROOT, but the table is one row per CLAUSE, so it
      // is repeated onto every row of this flow and kept in step by `syncGateScopes`. Repeating
      // beats a per-flow sub-table: §17.1's whole argument is that the row component stays flat.
      rows.push({ flow: flowId, branch: i + 1, gateScope: scope, ...row });
    }
  }
  return rows;
}

/** Clause rows for ONE flow → the authored gate, or undefined when there are none. */
function rowsToGate(rows) {
  const byBranch = new Map();
  for (const r of rows) {
    if (!r.gateKind || r.gateValue == null) continue;             // half-typed row: not a clause
    const clause = { [r.gateKind]: r.gateValue };
    // Only when they are not the defaults, for the reason `cadence` is: an authored default on
    // every clause would make every previously-saved graph differ from itself on the next save.
    if (r.gateBasis === 'INDEX' && isDrawdownClause(r.gateKind)) clause.drawdownBasis = 'INDEX';
    // The dwell rides on the node the row IS — which, for a negated row, is the `not` holding
    // the clause: "the source has NOT been within 5% of its high for two years".
    const node = r.gateNegate === 'NOT' ? { not: clause } : clause;
    if (Number(r.gateYears) > 1) node.sustainedYears = Number(r.gateYears);
    // Design 110 §6.3 — the optional address, on the node the row IS (the `not` for a negated
    // row, matching where the dwell goes). Blank means positional, exactly as before, so a graph
    // authored without ids round-trips byte-identically.
    const gateId = typeof r.gateId === 'string' ? r.gateId.trim() : '';
    if (gateId) node.id = gateId;
    const key = r.branch ?? 1;
    byBranch.set(key, [...(byBranch.get(key) ?? []), node]);
  }
  if (!byBranch.size) return undefined;
  const branches = [...byBranch.entries()].sort((a, b) => a[0] - b[0])
    .map(([, nodes]) => (nodes.length === 1 ? nodes[0] : { allOf: nodes }));
  const root = branches.length === 1 ? branches[0] : { anyOf: branches };
  // One scope per gate, on the root — `normalizeGate` rejects a nested one, so writing it
  // anywhere else would make a graph the editor produced fail to load. SOURCE is the default
  // and is left off, so a graph authored before §12.4c round-trips byte-identically.
  const scope = rows.find(r => r.gateScope === 'EDGE') ? 'EDGE' : null;
  return scope ? { ...root, scope } : root;
}

/** One flow row → the authored edge shape `normalizeLiquidityGraph` reads. */
function buildFlow(f, clauses = []) {
  const out = { id: f.id, from: f.from, to: f.to };
  if (f.priority) out.priority = f.priority;
  if (f.triggerKind && f.triggerValue != null) {
    out.trigger = f.triggerKind === 'belowTargetFraction'
      ? { belowTargetFraction: f.triggerValue }
      : { below: { mode: f.triggerKind === 'belowYears' ? 'YEARS_OF_SPEND' : 'AMOUNT',
                   value: f.triggerValue, ...(f.triggerExtra ?? {}) } };
  }
  // A gate the table could not draw is returned exactly as authored; otherwise the clause
  // rows ARE the gate, so deleting the last row deletes the gate (an edge with no gate is a
  // legitimate, and common, thing to want).
  const gate = f.rawGate ?? rowsToGate(clauses);
  if (gate) out.gate = gate;
  // Only when it is not the default: an authored `cadence: 'PERIOD'` on every edge would make
  // every previously-saved graph differ from itself on the next save, for nothing.
  if (f.cadence === 'ANNUAL' || f.cadence === 'PAYCHECK') out.cadence = f.cadence;
  if (f.amountKind === 'fractionOfSource' && f.amountValue != null) {
    out.amount = { fractionOfSource: f.amountValue, ...(f.amountExtra ?? {}) };
  } else if (f.amountExtra) {
    out.amount = { ...f.amountExtra };
  }
  // Opaque to the engine, preserved by the serializer, and the editor's job is to not lose it
  // (§14's constraint, asserted by CTRL-1). Written only when present, on the same rule as
  // every other elided default: a `ui: null` on every edge would make every previously-saved
  // graph differ from itself on the next save.
  if (f.ui) out.ui = f.ui;
  return out;
}


// ─── design 81 — recorded MPC runs ────────────────────────────────────────────

/** The `COCKPIT_CONTROLS` keys a decision row's `lever` column may name. */
const MPC_LEVERS = [
  'SPENDING', 'ROTH', 'EARLY_WITHDRAWAL',
  'DRAWDOWN_XBORDER', 'DRAWDOWN_WITHINTIER', 'DRAWDOWN_WEIGHTS', 'DRAWDOWN_SLEEVE',
  'ALLOCATION_MIX', 'BOND_LADDER',
];

/**
 * `mpcActiveRun` — the select that turns a recorded run on (design 81 §8, 5a).
 *
 * This IS the "use optimized parameters" control; there is no separate mode flag. Two things
 * it must do that a plain `Enum` cannot:
 *
 *  1. **Label from `source`.** A raw run id (`run:2026-09-18`) is not a choice anyone can make.
 *     `describeRunSource` is the one formatter, shared with the run editor and `run:save`.
 *  2. **Keep a dangling selection VISIBLE.** §15's sharp edge: a selection naming a deleted or
 *     renamed entry must degrade to "no run" *visibly*. `selectInput`'s orphan row is the
 *     established way to say so — the alternative is a select that silently re-points at the
 *     first run in the bag and re-saves as that, which is a different plan the user never chose.
 *
 * The bag is read at BUILD time from the sibling param, and the select re-reads it on focus, so
 * a run deleted in the editor below does not leave a stale option standing here.
 */
export function buildMpcRunSelect(param, getBag) {
  const container = el('div', 'mpc-run-select');
  const NONE = '';

  const render = () => {
    container.innerHTML = '';
    const bag = getBag?.() ?? null;
    const ids = isPlainObject(bag) ? Object.keys(bag) : [];

    const sel = el('select', 'age-band-input');
    sel.dataset.id = 'mpcActiveRun';
    const none = el('option', null, '— none —');
    none.value = NONE;
    sel.appendChild(none);
    for (const id of ids) {
      const o = el('option', null, `${id} — ${describeRunSource(bag[id]?.source, id)}`);
      o.value = id;
      sel.appendChild(o);
    }
    const current = typeof param.value === 'string' ? param.value : '';
    if (current && !ids.includes(current)) {
      const orphan = el('option', null, `${current} (not found)`);
      orphan.value = current;
      sel.appendChild(orphan);
    }
    sel.value = current;
    sel.addEventListener('change', () => {
      // `null`, not `''`: `resolveActiveMpcRun` treats both as "no run", but the param's
      // declared default is null and a scenario that round-trips through the editor should
      // come back byte-identical to one that was never opened.
      param.value = sel.value === NONE ? null : sel.value;
      render();
    });
    sel.addEventListener('focus', render);
    container.appendChild(sel);

    const note = el('div', 'row-list-empty');
    note.dataset.id = 'mpcActiveRunNote';
    if (!ids.length) {
      note.textContent = 'No recorded runs in this scenario — run the MPC cockpit and press '
        + '“Save run to plan”.';
    } else if (!current) {
      note.textContent = `${ids.length} recorded run(s) available, none playing — the base plan runs.`;
    } else if (!ids.includes(current)) {
      note.textContent = `“${current}” is not in this scenario’s runs, so the BASE plan runs. `
        + 'Select an existing run, or clear the selection.';
    } else {
      const src = bag[current]?.source ?? {};
      const rows = bag[current]?.decisions?.length ?? 0;
      note.textContent = `Playing ${rows} recorded decision(s)`
        + (src.first ? `, ${String(src.first).slice(0, 10)} → ${String(src.last).slice(0, 10)}` : '')
        + '. Each takes effect at the first period advance on or after its date.';
    }
    container.appendChild(note);
  };

  render();
  container.refresh = render;
  return container;
}

/**
 * The order `resolveActiveMpcRun` normalizes a run's rows into — date, then lever, then key.
 *
 * The tie-break is not decoration: two rows for the same (lever, key) on the same date are a
 * last-wins collapse, and "last" has to mean the same thing in the editor as it does at load
 * or the table shows one winner and the simulation plays another.
 */
const DECISION_ORDER = (a, b) =>
  String(a?.date ?? '').localeCompare(String(b?.date ?? ''))
  || String(a?.lever ?? '').localeCompare(String(b?.lever ?? ''))
  || String(a?.key ?? '').localeCompare(String(b?.key ?? ''));

/**
 * `mpcRuns` — the run picker (design 81 §8, 5b).
 *
 * Named blocks over `buildRowListEditor`, the shape `buildLiquidityShapesEditor` already uses
 * for a bag-of-named-things param. Each entry shows its `source` line, its row count, Delete,
 * and expands to the decision table.
 *
 * ─── why the decision table is FLAT (§4.4) ───────────────────────────────────────
 *
 * Four scalar columns, not a `{ date, params: {…} }` blob per epoch. Flat buys the interaction
 * for free: filter to one lever, sort by date, delete the one epoch that was wrong, change the
 * one value you want to try. A JSON blob in a table cell is the shape every structured editor
 * in this repo exists to avoid.
 *
 * ─── `derivedFrom` renders as a tree, held as a parent pointer (§4.3) ────────────
 *
 * `DecisionRecordStorage.save` persists nodes without edges, so lineage cannot live on graph
 * edges and survive a reload. The entry carries its parent's id and the block states it.
 */
export function buildMpcRunsEditor(param, onSelectionMayChange = null) {
  const value = isPlainObject(param.value) ? param.value : {};
  const runs  = Object.entries(value).map(([id, entry]) => ({ id, entry: entry ?? {} }));

  const sync = () => {
    const kept = runs.filter(r => r.id);
    // `null` rather than `{}` for an emptied bag: the param's default is null, and an empty
    // object would make a scenario that once held a run differ from one that never did.
    param.value = kept.length ? Object.fromEntries(kept.map(r => [r.id, r.entry ?? {}])) : null;
  };
  sync();

  const container = el('div', 'age-band-list-editor mpc-runs-editor');

  const render = () => {
    container.innerHTML = '';
    if (!runs.length) {
      container.appendChild(el('div', 'row-list-empty',
        'No recorded runs. The MPC cockpit’s “Save run to plan” writes one here.'));
    }

    runs.forEach((run, idx) => {
      const block = el('div', 'mix-block');
      block.dataset.id = `mpc-run-${idx}`;

      const head = el('div', 'mix-block-head');
      head.appendChild(el('span', 'age-band-col-label', 'Run id'));
      const idInput = textInput({ value: run.id, placeholder: 'run:2026-09-18', id: 'run-id' });
      idInput.addEventListener('change', () => {
        run.id = idInput.value.trim() || null;
        sync();
        // A rename orphans `mpcActiveRun`, which the select above renders as "(not found)"
        // rather than silently re-pointing. Tell it to re-read (§15's sharp edge).
        onSelectionMayChange?.();
        render();
      });
      head.appendChild(idInput);
      head.appendChild(removeButton('Delete run', () => {
        runs.splice(idx, 1); sync(); onSelectionMayChange?.(); render();
      }));
      block.appendChild(head);

      const src = isPlainObject(run.entry.source) ? run.entry.source : null;
      const provenance = el('div', 'pool-shape-diff', describeRunSource(src, run.id));
      provenance.dataset.id = `mpc-run-source-${idx}`;
      block.appendChild(provenance);

      if (src?.derivedFrom) {
        const lineage = el('div', 'pool-shape-diff', `re-solved from ${src.derivedFrom}`);
        lineage.dataset.id = `mpc-run-derived-${idx}`;
        block.appendChild(lineage);
      }

      if (!Array.isArray(run.entry.decisions)) run.entry.decisions = [];
      // Sorted ON OPEN, not only after an edit: the table must read in the order the run
      // PLAYS from the moment it is opened, and this is the comparator `resolveActiveMpcRun`
      // already applies on every load — so the sorted form IS the canonical one, and writing
      // it back makes the saved file match what the simulation does with it.
      run.entry.decisions.sort(DECISION_ORDER);
      block.appendChild(buildRowListEditor({
        rows: run.entry.decisions,
        columns: [
          { field: 'date',  label: 'Date',  type: 'text',   placeholder: '2031-01-01', width: '1.2fr' },
          { field: 'lever', label: 'Lever', type: 'select',
            options: MPC_LEVERS.map(k => [k, k]), width: '1.4fr' },
          // Free text, deliberately: the legal keys depend on the lever AND on the plan
          // (`band@69` exists only if that band does), so a select would either be wrong or
          // would need the whole param bag. A typo'd key is inert, not dangerous — `applyAt`
          // skips a row it cannot parse.
          { field: 'key',   label: 'Key',   type: 'text',   placeholder: 'band@69', width: '1.4fr' },
          { field: 'value', label: 'Value', type: 'text',   placeholder: '9000', width: '1fr' },
        ],
        newRow: () => ({ date: '', lever: MPC_LEVERS[0], key: '', value: '' }),
        addLabel: '+ Add Decision',
        emptyText: 'No decisions — this run changes nothing.',
        // The same comparator after every edit, so a retyped date jumps to where it belongs.
        sortBy: DECISION_ORDER,
        onChange: () => { sync(); render(); },
      }));

      container.appendChild(block);
    });

    container.appendChild(addButton('+ Add Run', () => {
      runs.push({ id: null, entry: { source: { recordedAt: new Date().toISOString() }, decisions: [] } });
      sync();
      render();
    }, 'addRun'));
  };

  render();
  container.refresh = render;
  return container;
}
