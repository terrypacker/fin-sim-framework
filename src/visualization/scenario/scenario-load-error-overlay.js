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
 * scenario-load-error-overlay.js — the recovery surface for a scenario that will not compile.
 *
 * `ScenarioLoader.load()` is called during boot, before any tab exists. Anything it
 * throws — a non-unit allocation mix is the one that actually happens (design 61
 * §12.2 Q3 rejects it rather than rescaling) — escapes into `main.js` and leaves a
 * blank page whose only diagnosis is a console stack. The saved value is then
 * unreachable: the editor that could fix it never renders.
 *
 * So the boot path catches instead, and this overlay takes over the page. It is
 * deliberately standalone — no shell, no plugins, no services beyond the scenario
 * registry — because everything else may be half-initialized by the time it runs.
 *
 * ── two paths reach this page, and they have different cheapest exits ────────
 * A scenario can fail to compile because the value is IN STORAGE (opened, boot dies), or
 * because it is an unsaved in-flight edit the user just hit Rebuild on. The second is the
 * cheaper failure by far — the stored copy still loads — but from the live record alone
 * the two look identical, and the escape list deliberately omits the active scenario, so
 * the user could not get back to their own saved copy. Comparing the live params against
 * `scenarioRegistry.getStored()` tells them apart, and when the stored copy is both
 * DIFFERENT and clean this page offers the exit that costs nothing but the edits.
 *
 * Four ways out, in the order they are worth trying:
 *   1. **Fix the value.** Every failure a validator can LOCALIZE gets its own control,
 *      bound to the live record so the edit lands on the value that will be re-serialized:
 *      a bad allocation mix gets its weight rows and a Normalize that scales the authored
 *      ratios to 1; a bad liquidity-pool size gets its mode and its value, with the bounds
 *      that mode actually allows. Nothing is repaired silently — offering and showing the
 *      rescale is the whole point of the validator that rejected the value.
 *   2. **Discard the unsaved changes.** Offered only when the stored copy differs from
 *      what is in memory AND compiles — then a plain reload is the whole repair, because
 *      the edits only ever lived in this page.
 *   3. **Open a different scenario.** The broken one is left untouched and stays in the list.
 *   4. **Delete this scenario.** Last resort, for the case the repair controls cannot
 *      reach: the record is unreachable through the workbench UI while it will not
 *      compile, so the only way back to a saved copy is to drop it and re-upload the JSON.
 *      Behind a confirm, and it says what cannot be undone.
 */

import { ALLOCATION_VALUES }           from '../../finance/holdings/allocation.js';
import { collectAuthoredMixProblems }  from '../../finance/behavioral/rebalance-to-target-reducer.js';
import { collectAuthoredGraphProblems, POOL_TARGET_MODE, POOL_CAPACITY_MODE }
  from '../../finance/pools/liquidity-graph.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

/** The params whose problems `collectAuthoredMixProblems` reports — i.e. the mix rule's. */
const ALLOCATION_PARAMS = new Set([
  'rebalanceTargetAllocation', 'allocationGlidepath', 'allocationRegimeTargets',
]);

function mixSum(mix) {
  return ALLOCATION_VALUES.reduce((s, a) => s + Number(mix?.[a] ?? 0), 0);
}

/**
 * The mix object a reported problem points at, resolved out of the live cfg so edits
 * land on the value that will be re-serialized — not on a copy.
 *
 * @returns {object|null} the weight map, or null when the problem isn't a mix (a
 *          non-numeric age, a malformed anchor) and so has no weights to repair here.
 */
function mixFor(paramValue, problem) {
  if (problem.param === 'rebalanceTargetAllocation') return paramValue ?? null;
  if (problem.param === 'allocationGlidepath') {
    const anchor = Array.isArray(paramValue) ? paramValue[problem.index] : null;
    return anchor && typeof anchor === 'object' ? (anchor.weights ?? null) : null;
  }
  if (problem.param === 'allocationRegimeTargets') {
    const entries = paramValue && typeof paramValue === 'object' ? Object.values(paramValue) : [];
    return entries[problem.index] ?? null;
  }
  return null;
}

/**
 * The params of a record, as a comparable string.
 *
 * Params are the axis both validators read, so a difference here is what decides whether
 * the failing value is one the user typed and never saved. Sorted by name because the
 * order a param list is rebuilt in is not meaningful and would otherwise read as an edit.
 */
function paramSignature(record) {
  const params = Array.isArray(record?.params) ? record.params : [];
  return JSON.stringify(
    params.map(p => [p?.name ?? '', p?.value ?? null])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/**
 * The stored copy of this scenario, when going back to it is a real way out.
 *
 * Both conditions matter. DIFFERENT, or the "discard" would discard nothing and reload
 * straight back into this page. CLEAN, for the same reason — a stored copy that fails the
 * same validators is not an escape, it is this page again.
 *
 * @returns {object|null} the stored record worth returning to, or null
 */
function cleanStoredCopy(config, scenarioRegistry) {
  const stored = scenarioRegistry?.getStored?.(config?.id);
  if (!stored) return null;                       // a prebuilt, or never persisted
  if (paramSignature(stored) === paramSignature(config)) return null;
  const bag = {};
  for (const p of (Array.isArray(stored.params) ? stored.params : [])) bag[p.name] = p.value;
  const bad = [...collectAuthoredMixProblems(bag),
               ...collectAuthoredGraphProblems(bag, stored.accounts ?? [])];
  return bad.length ? null : stored;
}

/**
 * The modes a pool size spec may take, and the bounds each one puts on its value.
 *
 * These ARE the compiler's bounds (`sizeSpec` in liquidity-graph.js), restated as control
 * attributes so the control cannot express what the validator will reject. PERCENT is the
 * one that matters here: it is a FRACTION of the book, so 100 means "10,000 %" and is the
 * mistake this overlay exists to undo.
 */
const SIZE_MODES = {
  target:   Object.values(POOL_TARGET_MODE),
  floor:    Object.values(POOL_TARGET_MODE),
  capacity: Object.values(POOL_CAPACITY_MODE),
};
const SIZE_DEFAULT_MODE = {
  target:   POOL_TARGET_MODE.YEARS_OF_SPEND,
  floor:    POOL_TARGET_MODE.AMOUNT,
  capacity: POOL_CAPACITY_MODE.BALANCE,
};
/** `null` bounds mean the mode derives its value from live state and takes none. */
const MODE_BOUNDS = {
  [POOL_TARGET_MODE.PERCENT]:          { min: 0, max: 1, step: 0.01,
                                         hint: 'a FRACTION of the book — 0.05 is 5 %' },
  [POOL_TARGET_MODE.YEARS_OF_SPEND]:   { min: 0, max: 50, step: 0.5, hint: 'years of spending' },
  [POOL_TARGET_MODE.AMOUNT]:           { min: 0, max: Infinity, step: 1000,
                                         hint: 'a figure in the valuation base currency' },
  [POOL_CAPACITY_MODE.BALANCE]:        null,
  [POOL_CAPACITY_MODE.OFFSET_CAP]:     null,
};

/**
 * One repair control for a pool's `target` / `floor` / `capacity`: the mode, and the value
 * under that mode's own bounds.
 *
 * The spec is rewritten on the live graph object rather than mutated in place because a
 * bare number is legal sugar for `{ mode, value }` — editing the mode of a number has to
 * produce the object form, and the extra keys a spec may carry (`spendBasis`,
 * `trailingYears`) have to survive that promotion or the repair would silently drop half
 * the authored policy.
 */
function buildSizeSpecRepair(pool, field, onEdit) {
  const raw   = pool?.[field];
  const spec  = (raw != null && typeof raw === 'object') ? { ...raw } : {};
  if (typeof raw === 'number') spec.value = raw;
  spec.mode = spec.mode ?? SIZE_DEFAULT_MODE[field];

  const block = el('div', 'sle-mix-grid sle-spec');

  const modeCell = el('label', 'sle-cell');
  modeCell.appendChild(el('span', 'sle-cell-label', `${field} mode`));
  const modeSel = el('select', 'sle-cell-input');
  for (const mode of SIZE_MODES[field]) {
    const opt = el('option', null, mode);
    opt.value = mode;
    modeSel.appendChild(opt);
  }
  modeSel.value = spec.mode;
  modeCell.appendChild(modeSel);

  const valueCell = el('label', 'sle-cell');
  const valueLabel = el('span', 'sle-cell-label', `${field} value`);
  const valueInput = el('input', 'sle-cell-input');
  valueInput.type = 'number';
  valueCell.appendChild(valueLabel);
  valueCell.appendChild(valueInput);

  // Offered only when it is the repair the numbers actually suggest: a PERCENT authored as
  // a percentage. Shown rather than applied, on `Normalize to 1`'s rule.
  const asFraction = el('button', 'btn btn-sm', 'Read as a percent (÷ 100)');
  asFraction.type = 'button';
  asFraction.title = 'Divide by 100 — what "100" means if it was typed as a percentage.';

  const write = () => {
    const bounds = MODE_BOUNDS[spec.mode];
    const next = { ...spec };
    if (!bounds) delete next.value;
    pool[field] = next;
    onEdit();
  };

  const refresh = () => {
    const bounds = MODE_BOUNDS[spec.mode];
    valueCell.hidden = !bounds;
    asFraction.hidden = !(spec.mode === POOL_TARGET_MODE.PERCENT && Number(spec.value) > 1);
    if (bounds) {
      valueLabel.textContent = `${field} value — ${bounds.hint}`;
      valueInput.min  = String(bounds.min);
      valueInput.step = String(bounds.step);
      if (Number.isFinite(bounds.max)) valueInput.max = String(bounds.max);
      else valueInput.removeAttribute('max');
      valueInput.value = spec.value ?? '';
      const bad = !(Number(spec.value) >= bounds.min && Number(spec.value) <= bounds.max);
      valueInput.classList.toggle('sle-bad', bad);
    }
  };

  modeSel.addEventListener('change', () => {
    spec.mode = modeSel.value;
    if (MODE_BOUNDS[spec.mode] && spec.value == null) spec.value = 0;
    write();
    refresh();
  });
  valueInput.addEventListener('input', () => {
    const rawValue = valueInput.value.trim();
    spec.value = rawValue === '' ? 0 : Number(rawValue);
    write();
    refresh();
  });
  asFraction.addEventListener('click', () => {
    spec.value = round6(Number(spec.value) / 100);
    write();
    refresh();
  });

  block.appendChild(modeCell);
  block.appendChild(valueCell);
  const foot = el('div', 'sle-mix-foot');
  foot.appendChild(asFraction);

  const wrap = el('div');
  wrap.appendChild(block);
  wrap.appendChild(foot);
  refresh();
  return wrap;
}

/**
 * Take over the page with the recovery UI.
 *
 * @param {object} opts
 * @param {Error}  opts.error            - what the loader threw
 * @param {object} opts.config           - the scenario record that failed to compile
 * @param {object} opts.scenarioRegistry - used to persist a repair and to switch scenarios
 * @param {() => void} [opts.onReload]   - defaults to a full page reload
 */
export function showScenarioLoadError({ error, config, scenarioRegistry, onReload }) {
  const reload = onReload ?? (() => window.location.reload());

  // Read the params off the record itself: the compile that would have produced a
  // resolved bag is exactly what failed.
  const params = Array.isArray(config?.params) ? config.params : [];
  const bag = {};
  for (const p of params) bag[p.name] = p.value;
  // Two validator families report field-local problems, and either can be the throw that
  // stopped the boot. Both are collected: a record with a bad mix AND a bad pool size must
  // not be repaired one failure per reload.
  //
  // The graph pass needs the accounts its claims name; the record carries them whenever a
  // graph snapshot was harvested, and `collectAuthoredGraphProblems` skips the whole-graph
  // leg when it has none rather than reporting every claim as an orphan.
  const problems      = collectAuthoredMixProblems(bag);
  const graphProblems = collectAuthoredGraphProblems(bag, config?.accounts ?? []);
  const repairs       = problems.length + graphProblems.length;
  const paramByName = new Map(params.map(p => [p.name, p]));

  const root = el('div', 'scenario-load-error');
  const card = el('div', 'sle-card');
  root.appendChild(card);

  // Which of the two paths reached this page (see the header note).
  const storedCopy = cleanStoredCopy(config, scenarioRegistry);

  card.appendChild(el('h1', 'sle-title', storedCopy
    ? 'These changes could not be loaded'
    : 'This scenario could not be loaded'));
  card.appendChild(el('p', 'sle-sub', storedCopy
    ? `"${config?.name ?? 'The active scenario'}" would not compile with the changes made ` +
      `since it was last saved, so the workbench did not start. Those changes were never ` +
      `saved — fix the value below to keep them, or discard them and reload the stored ` +
      `copy, which still loads.`
    : `"${config?.name ?? 'The active scenario'}" failed to compile, so the workbench did ` +
      `not start. Nothing has been changed or lost — fix the value below, or open a ` +
      `different scenario.`));

  // The raw throw, but only when the repair section below is not already showing it:
  // the loader rethrows the FIRST mix problem verbatim, so printing both makes the page
  // look like there are two failures.
  if (!repairs) {
    card.appendChild(el('pre', 'sle-error', String(error?.message ?? error)));
  }

  // ── 1. repair the offending mixes ───────────────────────────────────────────
  const dirty = new Set();

  if (problems.length) {
    card.appendChild(el('h2', 'sle-section', problems.length === 1
      ? 'The invalid allocation mix'
      : `The ${problems.length} invalid allocation mixes`));

    for (const problem of problems) {
      const param = paramByName.get(problem.param);
      const mix   = mixFor(param?.value, problem);

      const block = el('div', 'sle-mix');
      block.appendChild(el('div', 'sle-mix-where', problem.message));

      if (!mix) {
        // A malformed anchor or a non-numeric age: there is no weight row to offer,
        // and guessing a repair would be inventing a plan the user never authored.
        block.appendChild(el('div', 'sle-mix-note',
          'This one has no weights to repair here — open a different scenario, then ' +
          'fix it in the Parameters list.'));
        card.appendChild(block);
        continue;
      }

      const grid   = el('div', 'sle-mix-grid');
      const inputs = new Map();
      const sum    = el('div', 'sle-mix-sum');

      const refresh = () => {
        const total = mixSum(mix);
        sum.textContent = `Σ ${total.toFixed(6)}`;
        sum.classList.toggle('sle-bad', Math.abs(total - 1) > 1e-9);
      };

      for (const alloc of ALLOCATION_VALUES) {
        const cell  = el('label', 'sle-cell');
        cell.appendChild(el('span', 'sle-cell-label', alloc));
        const input = el('input', 'sle-cell-input');
        input.type = 'number';
        input.step = '0.01';
        input.min  = '0';
        input.value = Number(mix[alloc] ?? 0);
        input.addEventListener('input', () => {
          const raw = input.value.trim();
          mix[alloc] = raw === '' ? 0 : Number(raw);
          dirty.add(problem.param);
          refresh();
        });
        inputs.set(alloc, input);
        cell.appendChild(input);
        grid.appendChild(cell);
      }

      const normalize = el('button', 'btn btn-sm', 'Normalize to 1');
      normalize.type = 'button';
      normalize.title = 'Scale these weights proportionally so they sum to 1, keeping ' +
                        'the ratios you authored.';
      normalize.addEventListener('click', () => {
        const total = mixSum(mix);
        if (!(total > 0)) return;
        for (const alloc of ALLOCATION_VALUES) mix[alloc] = round6(Number(mix[alloc] ?? 0) / total);
        const largest = ALLOCATION_VALUES.reduce((a, b) => (mix[b] > mix[a] ? b : a));
        mix[largest] = round6(mix[largest] + (1 - mixSum(mix)));
        for (const alloc of ALLOCATION_VALUES) inputs.get(alloc).value = mix[alloc];
        dirty.add(problem.param);
        refresh();
      });

      const foot = el('div', 'sle-mix-foot');
      foot.appendChild(sum);
      foot.appendChild(normalize);

      block.appendChild(grid);
      block.appendChild(foot);
      card.appendChild(block);
      refresh();
    }
  }

  // ── 1b. repair the offending pool sizes ─────────────────────────────────────
  if (graphProblems.length) {
    card.appendChild(el('h2', 'sle-section', graphProblems.length === 1
      ? 'The invalid liquidity pool'
      : `The ${graphProblems.length} invalid liquidity pools`));

    const graph = paramByName.get('liquidityGraph')?.value;
    for (const problem of graphProblems) {
      const pool = problem.index != null ? graph?.pools?.[problem.index] : null;
      const block = el('div', 'sle-mix');
      block.appendChild(el('div', 'sle-mix-where', problem.message));
      if (!pool || !problem.field) {
        // A claim that names a dead account, a duplicate id, a cycle: real failures with no
        // single cell to type into. Naming them beats offering a control that cannot fix them.
        block.appendChild(el('div', 'sle-mix-note',
          'This one is a shape problem, not a value — open a different scenario, then fix ' +
          'the graph in the Parameters list.'));
        card.appendChild(block);
        continue;
      }
      block.appendChild(buildSizeSpecRepair(pool, problem.field, () => dirty.add('liquidityGraph')));
      card.appendChild(block);
    }
  }

  if (repairs) {
    const save = el('button', 'btn btn-primary sle-save', 'Save fixes and reload');
    save.type = 'button';
    save.addEventListener('click', () => {
      // Re-run BOTH validators, not the one whose section was edited: a repaired mix on a
      // record that still carries a bad pool would reload straight back into this page.
      const stillBad = [...collectAuthoredMixProblems(bag),
                        ...collectAuthoredGraphProblems(bag, config?.accounts ?? [])];
      if (stillBad.length) {
        // Reloading into the same failure would just redraw this page. Say why — including
        // the rule, because the message alone reads as "the number is wrong" without it.
        const rules = [];
        if (stillBad.some(p => ALLOCATION_PARAMS.has(p.param))) {
          rules.push('Allocation weights must sum to exactly 1 — they are NOT rescaled for you.');
        }
        if (stillBad.some(p => p.param === 'liquidityGraph')) {
          rules.push('A pool size must be in range for its mode — a PERCENT is a FRACTION, so 0.05 is 5%.');
        }
        alert(['Still invalid:', '', ...stillBad.map(p => `• ${p.message}`), '', ...rules].join('\n'));
        return;
      }
      // The values were edited in place on the record's own param values, so saving the
      // record persists them. `params` is also mirrored into the `parameters` bag on
      // some records; keep the two stores in step or the fix looks like it did nothing.
      if (config.parameters && typeof config.parameters === 'object') {
        for (const name of dirty) {
          if (name in config.parameters) config.parameters[name] = paramByName.get(name)?.value;
        }
      }
      scenarioRegistry.save(config, true);
      reload();
    });
    card.appendChild(save);
  }

  // ── 2. discard the unsaved changes ──────────────────────────────────────────
  // The exit the Rebuild path needs and the escape list cannot offer: the scenario itself
  // is the active one, so it is (rightly) not in that list — but its STORED copy is a
  // different config from the one in memory, and it compiles. The edits only ever lived in
  // this page, so reloading without saving IS the repair.
  if (storedCopy) {
    card.appendChild(el('h2', 'sle-section', 'Or go back to the saved version'));
    card.appendChild(el('p', 'sle-sub',
      'Reloads "' + (storedCopy.name ?? config.name ?? 'this scenario') + '" as it is stored ' +
      'in this browser. The unsaved changes made since — including the one above — are lost; ' +
      'nothing is written, so the stored copy is exactly what it was.'));
    const revert = el('button', 'btn btn-primary', 'Discard changes and reload the saved version');
    revert.type = 'button';
    // Deliberately no registry.save: the in-memory record is the broken one, and persisting
    // it is the single thing that would turn a cheap failure into the expensive one.
    revert.addEventListener('click', () => reload());
    card.appendChild(revert);
  }

  // ── 3. open a different scenario ────────────────────────────────────────────
  const others = (scenarioRegistry?.getAll?.() ?? []).filter(s => s.id !== config?.id);
  if (others.length) {
    card.appendChild(el('h2', 'sle-section', 'Or open a different scenario'));
    const list = el('div', 'sle-others');
    for (const other of others) {
      const btn = el('button', 'btn btn-sm', other.name ?? other.id);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        scenarioRegistry.setActiveById(other.id);
        reload();
      });
      list.appendChild(btn);
    }
    card.appendChild(list);
  }

  // ── 4. delete this scenario ─────────────────────────────────────────────────
  // The last resort, and the reason it exists: while the record will not compile the
  // workbench never renders, so its own Delete control is unreachable — a scenario broken
  // by a value no control here can repair would otherwise be permanent. Deleting it makes
  // another scenario active, which is enough to get back into the UI and re-upload a
  // saved copy of this one.
  if (config?.id && others.length) {
    card.appendChild(el('h2', 'sle-section', 'Or delete this scenario'));
    card.appendChild(el('p', 'sle-sub',
      'Removes it from this browser. Anything not downloaded as JSON is gone — but the ' +
      'workbench opens on another scenario, from which an exported copy can be uploaded again.'));
    // Labelled by what it does, not by the scenario's name: the escape list above is a row
    // of buttons that ARE scenario names, and a destructive twin wearing one of those names
    // is a misclick waiting to happen. The confirm names it.
    const del = el('button', 'btn btn-warn', 'Delete this scenario');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!window.confirm(`Delete "${config.name ?? config.id}"? This cannot be undone.`)) return;
      scenarioRegistry.delete(config.id);
      reload();
    });
    card.appendChild(del);
  }

  document.body.appendChild(root);
  return root;
}
