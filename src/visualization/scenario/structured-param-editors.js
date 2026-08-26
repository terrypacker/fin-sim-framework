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
 *      so a 1.25 mix is red while you are still looking at it.
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

  const sum = el('div', 'mix-sum');
  const refresh = () => {
    const total = mixSum(getMix());
    sum.textContent = `Σ ${total.toFixed(4)}`;
    const ok = Math.abs(total - 1) <= MIX_SUM_EPSILON;
    sum.classList.toggle('mix-sum-ok',  ok);
    sum.classList.toggle('mix-sum-bad', !ok);
    sum.title = ok
      ? 'Weights sum to 1.'
      : 'Weights must sum to 1. A non-unit mix is REJECTED at Rebuild, not rescaled '
        + '— a silent rescale once turned an authored 0.75 equity into an executed 0.6.';
  };

  for (const alloc of ALLOCATION_VALUES) {
    const input = numberInput({ value: getMix()?.[alloc], step: '0.01', min: '0', max: '1', id: alloc });
    input.addEventListener('input', () => {
      const raw  = input.value.trim();
      const next = totalMix(getMix());
      // Blank is 0 here, never "absent" — see the header note.
      next[alloc] = raw === '' ? 0 : Number(raw);
      setMix(totalMix(next));
      refresh();
    });
    row.appendChild(input);
  }

  wrap.appendChild(row);
  wrap.appendChild(sum);
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
