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

const TARGET_MODE_OPTIONS = Object.freeze([
  ['',               '— none —'],
  ['YEARS_OF_SPEND', 'years of spend'],
  ['PERCENT',        '% of book'],
  ['AMOUNT',         'amount'],
]);

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

const gateBasisOptionsFor = (row) =>
  (isDrawdownClause(row?.gateKind) ? GATE_BASIS_OPTIONS : GATE_BASIS_NA_OPTIONS);

// design 97 §12.6. PERIOD is the default; ANNUAL restricts an edge to the first period of the
// calendar year. Authorable because a market gate reads an ANNUAL signal (the equity tick runs
// once a year), so an edge free to fire on every advance is re-deciding on an unchanged
// reading — and because an arm built in a script and not reproducible in the app is a study
// nobody can check.
const CADENCE_OPTIONS = Object.freeze([
  ['PERIOD', 'every period'],
  ['ANNUAL', 'once a year'],
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
export function buildLiquidityGraphEditor(param, accounts = []) {
  const value = isPlainObject(param.value) ? param.value : {};

  // Pools, minus their claims — the claims live in their own table (see the header note).
  const pools = (Array.isArray(value.pools) ? value.pools : []).map(p => ({
    id:          p?.id ?? null,
    label:       p?.label ?? null,
    spendOrder:  Number.isFinite(Number(p?.spendOrder)) ? Number(p.spendOrder) : null,
    targetMode:  p?.target?.mode ?? '',
    targetValue: Number.isFinite(Number(p?.target?.value)) ? Number(p.target.value) : null,
    capacity:    p?.capacity?.mode ?? 'BALANCE',
    // The capacity of an AMOUNT / YEARS_OF_SPEND pool. Without this cell those two modes are
    // selectable and unauthorable: `sizeSpec` requires a value for every non-derived mode, so
    // picking one wrote a graph that threw at Rebuild.
    capacityValue: Number.isFinite(Number(p?.capacity?.value)) ? Number(p.capacity.value) : null,
    // Carried, not drawn — see `extraKeys`.
    floor:         p?.floor ?? null,
    targetExtra:   extraKeys(p?.target,   ['mode', 'value']),
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
      cadence: f?.cadence === 'ANNUAL' ? 'ANNUAL' : 'PERIOD',
      triggerKind, triggerValue,
      rawGate: rows == null ? (f?.gate ?? null) : null,
      amountKind:  f?.amount?.fractionOfSource != null ? 'fractionOfSource' : 'toTarget',
      amountValue: f?.amount?.fractionOfSource ?? null,
      // Carried, not drawn — see `extraKeys`.
      amountExtra:  extraKeys(f?.amount, ['toTarget', 'fractionOfSource']),
      triggerExtra: extraKeys(f?.trigger?.below, ['mode', 'value']),
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
          ? { target: { mode: p.targetMode, value: p.targetValue ?? 0, ...(p.targetExtra ?? {}) } }
          : {}),
        ...(p.capacity && p.capacity !== 'BALANCE'
          ? { capacity: { mode: p.capacity,
                          ...(CAPACITY_NEEDS_VALUE.includes(p.capacity)
                            ? { value: p.capacityValue ?? 0 } : {}),
                          ...(p.capacityExtra ?? {}) } }
          : {}),
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
    ],
    newRow:    () => ({ pool: pools[0]?.id ?? null, key: accounts?.[0]?.stateKey ?? null, sleeves: null }),
    addLabel:  '+ Add Claim',
    emptyText: 'No claims — a pool with no claims holds nothing.',
    onChange:  sync,
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
                        amountExtra: null, triggerExtra: null }),
    addLabel:  '+ Add Flow',
    emptyText: 'No flows — pools are spent in order but never refilled by an explicit rule.',
    // Renaming a flow changes the option list the gate table selects from — the same reason
    // the pools table refreshes the claims and flows tables (§17.1).
    onChange:  () => { sync(); gateEditor.refresh(); },
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
    ],
    newRow:    () => ({ flow: gateableFlowIds()[0] ?? null, branch: 1, gateNegate: '',
                        gateKind: 'sourceDrawdownUnder', gateValue: 0.05,
                        gateBasis: 'INDEX', gateYears: 1 }),
    addLabel:  '+ Add Gate Clause',
    emptyText: 'No gate clauses — every flow fires whenever its trigger and amount allow.',
    onChange:  () => {
      // Both, never short-circuited: each is a repair the table owes the author.
      const renumbered = renumberBranches();
      const rebased    = normalizeGateBases();
      const moved      = renumbered || rebased;
      sync();
      if (moved) gateEditor.refresh();
    },
  });

  const poolsEditor = buildRowListEditor({
    rows: pools,
    columns: [
      { field: 'id',          label: 'Id',       type: 'text',   placeholder: 'reserve', width: '1fr' },
      { field: 'label',       label: 'Label',    type: 'text',   placeholder: 'Bucket 2', width: '1.3fr' },
      { field: 'spendOrder',  label: 'Spend #',  type: 'number', step: '10', placeholder: 'never', width: '0.7fr' },
      // `rerender` on both mode cells: the Size cell beside each one takes its bounds from
      // the mode, so a mode change has to redraw the row or the new mode keeps the old range.
      { field: 'targetMode',  label: 'Target',   type: 'select', options: TARGET_MODE_OPTIONS,
        rerender: true, width: '1.2fr' },
      { field: 'targetValue', label: 'Size',     type: 'number',
        step: sizeAttr('targetMode', 'step'), min: sizeAttr('targetMode', 'min'),
        max:  sizeAttr('targetMode', 'max'),  title: sizeAttr('targetMode', 'title'), width: '0.7fr' },
      { field: 'capacity',    label: 'Capacity', type: 'select', options: CAPACITY_MODE_OPTIONS,
        rerender: true, width: '1.5fr' },
      // Blank on BALANCE / OFFSET_CAP, whose ceiling is derived from live state.
      { field: 'capacityValue', label: 'Cap size', type: 'number',
        step: sizeAttr('capacity', 'step'), min: sizeAttr('capacity', 'min'),
        max:  sizeAttr('capacity', 'max'),  title: sizeAttr('capacity', 'title'), width: '0.7fr' },
    ],
    newRow:    () => ({ id: null, label: null, spendOrder: (pools.length + 1) * 10,
                        targetMode: '', targetValue: null, capacity: 'BALANCE',
                        capacityValue: null, floor: null, targetExtra: null,
                        capacityExtra: null, ui: null }),
    addLabel:  '+ Add Pool',
    emptyText: 'No pools — the drawdownPriority order applies and nothing refills (the default).',
    // Renaming or adding a pool changes the option list the OTHER two tables select from,
    // so both are re-rendered. Without this a renamed pool leaves its claims pointing at a
    // dead id and the user finds out at Rebuild.
    onChange:  () => { sync(); claimsEditor.refresh(); flowsEditor.refresh(); },
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

  sync();
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
    if (Object.keys(node).some(k => k !== 'not' && k !== 'sustainedYears')) return null;
    const inner = gateNodeToRow(node.not);
    if (!inner || inner.gateNegate === 'NOT' || inner.gateYears > 1) return null;
    return { ...inner, gateNegate: 'NOT', gateYears: node.sustainedYears ?? 1 };
  }
  if (node.anyOf || node.allOf) return null;                      // a child: not a leaf row
  const kinds = GATE_CLAUSE_KINDS.filter(k => node[k] != null);
  if (kinds.length !== 1) return null;                            // 0 says nothing, 2+ is an AND
  const known = new Set([...GATE_CLAUSE_KINDS, 'sustainedYears', 'drawdownBasis']);
  if (Object.keys(node).some(k => !known.has(k))) return null;    // a clause the table lacks
  const kind = kinds[0];
  return {
    gateNegate: '',
    gateKind:  kind,
    gateValue: node[kind],
    gateBasis: isDrawdownClause(kind) ? (node.drawdownBasis ?? 'BALANCE') : '',
    gateYears: node.sustainedYears ?? 1,
  };
}

/** A flow's gate → clause rows in DNF, or null when it is not expressible as rows. */
function gateToRows(flowId, gate) {
  if (gate == null) return [];
  const branches = Array.isArray(gate) ? [{ allOf: gate }]
    : gate.anyOf ? gate.anyOf : [gate];
  // An `anyOf` carrying clauses of its own is an AND-over-an-OR; the table cannot say it.
  if (gate.anyOf && (gate.not || gate.allOf || GATE_CLAUSE_KINDS.some(k => gate[k] != null))) return null;
  const rows = [];
  for (const [i, branch] of branches.entries()) {
    const nodes = Array.isArray(branch) ? branch : (branch?.allOf ?? [branch]);
    if (branch?.allOf && (branch.anyOf || branch.not || branch.sustainedYears != null)) return null;
    for (const node of nodes) {
      const row = gateNodeToRow(node);
      if (!row) return null;
      rows.push({ flow: flowId, branch: i + 1, ...row });
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
    const key = r.branch ?? 1;
    byBranch.set(key, [...(byBranch.get(key) ?? []), node]);
  }
  if (!byBranch.size) return undefined;
  const branches = [...byBranch.entries()].sort((a, b) => a[0] - b[0])
    .map(([, nodes]) => (nodes.length === 1 ? nodes[0] : { allOf: nodes }));
  return branches.length === 1 ? branches[0] : { anyOf: branches };
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
  if (f.cadence === 'ANNUAL') out.cadence = 'ANNUAL';
  if (f.amountKind === 'fractionOfSource' && f.amountValue != null) {
    out.amount = { fractionOfSource: f.amountValue, ...(f.amountExtra ?? {}) };
  } else if (f.amountExtra) {
    out.amount = { ...f.amountExtra };
  }
  return out;
}
