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
 * Two ways out, in the order they are worth trying:
 *   1. **Fix the value.** When the failure is one the mix validator can localize, each
 *      bad mix gets its own editable weight row, with a Normalize that scales the
 *      authored ratios to 1. The rescale is offered and shown, never applied silently
 *      — the whole point of the validator that rejected the value in the first place.
 *   2. **Open a different scenario.** Recovery of last resort; the broken one is left
 *      untouched and stays in the list.
 */

import { ALLOCATION_VALUES }           from '../../finance/holdings/allocation.js';
import { collectAuthoredMixProblems }  from '../../finance/behavioral/rebalance-to-target-reducer.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

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
  const problems = collectAuthoredMixProblems(bag);
  const paramByName = new Map(params.map(p => [p.name, p]));

  const root = el('div', 'scenario-load-error');
  const card = el('div', 'sle-card');
  root.appendChild(card);

  card.appendChild(el('h1', 'sle-title', 'This scenario could not be loaded'));
  card.appendChild(el('p', 'sle-sub',
    `"${config?.name ?? 'The active scenario'}" failed to compile, so the workbench did ` +
    `not start. Nothing has been changed or lost — fix the value below, or open a ` +
    `different scenario.`));

  // The raw throw, but only when the repair section below is not already showing it:
  // the loader rethrows the FIRST mix problem verbatim, so printing both makes the page
  // look like there are two failures.
  if (!problems.length) {
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

    const save = el('button', 'btn btn-primary sle-save', 'Save fixes and reload');
    save.type = 'button';
    save.addEventListener('click', () => {
      const stillBad = collectAuthoredMixProblems(bag);
      if (stillBad.length) {
        // Reloading into the same failure would just redraw this page. Say why.
        alert('Still invalid — every mix must sum to exactly 1:\n\n' +
              stillBad.map(p => `• ${p.message}`).join('\n'));
        return;
      }
      // The mixes were edited in place on the record's own param values, so saving the
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

  // ── 2. open a different scenario ────────────────────────────────────────────
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

  document.body.appendChild(root);
  return root;
}
