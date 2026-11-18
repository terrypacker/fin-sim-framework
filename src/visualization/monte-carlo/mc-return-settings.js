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
 * The Monte Carlo tab's own editor for the return processes and the historical years a batch
 * samples (design 133). The same params as the Parameters panel's Economic Shocks rows, written
 * the same way (the live record's typed entry, by reference), so the two never disagree. They
 * are here because they decide what a batch means, and the Monte Carlo tab is where a batch is
 * set up and read; the Parameters list holds them among ~60 others.
 *
 * Only what changes a batch's history: the processes, then, under the bootstrap, how starts are
 * picked, the first year sampled, and a pinned opening run. Rolling replaces the pinned start,
 * so the pinned rows hide under it, as Start Run hides until a Start Year is set.
 */

/** The params this editor shows, in order. */
export const RETURN_SETTING_NAMES = [
  'mcEquityReturnModel',
  'mcInflationModel',
  'mcEquityBootstrapStarts',
  'equityReturnBootstrapFromYear',
  'equityReturnBootstrapStartYear',
  'equityReturnBootstrapStartRun',
];

const BOOTSTRAP_ONLY = new Set(RETURN_SETTING_NAMES.slice(2));

const PLACEHOLDER = {
  equityReturnBootstrapFromYear:  'automatic',
  equityReturnBootstrapStartYear: 'random',
  equityReturnBootstrapStartRun:  'to 2023',
};

/** "Monte Carlo: Equity Return Process" → "Equity Return Process"; "Historical Bootstrap — Start Year" → "Start Year". */
function shortLabel(param) {
  return String(param.label ?? param.name)
    .replace(/^Monte Carlo:\s*/, '')
    .replace(/^Historical Bootstrap\s*—\s*/, '');
}

/**
 * Which rows show. Bootstrap rows only when the batch runs the bootstrap (`bootstrap`, from the
 * return-paths info's window); the pinned start only when starts are random; Start Run only once
 * a Start Year is set.
 *
 * @param {Map<string, object>} byName  param name → typed entry
 * @param {boolean} bootstrap
 * @returns {string[]}
 */
export function visibleReturnSettings(byName, bootstrap) {
  const rolling = byName.get('mcEquityBootstrapStarts')?.value === 'ROLLING';
  const startSet = byName.get('equityReturnBootstrapStartYear')?.value != null;
  return RETURN_SETTING_NAMES.filter(name => {
    if (!byName.has(name)) return false;
    if (BOOTSTRAP_ONLY.has(name) && !bootstrap) return false;
    if (rolling && name === 'equityReturnBootstrapStartYear') return false;
    if ((rolling || !startSet) && name === 'equityReturnBootstrapStartRun') return false;
    return true;
  });
}

/**
 * Build the rows into `host` (emptied first).
 *
 * @param {HTMLElement} host
 * @param {object[]} params       the live record's typed entries (edited in place)
 * @param {{ bootstrap: boolean, onEdit: (name: string) => void, onOpenHelp?: Function }} opts
 */
export function renderReturnSettings(host, params, { bootstrap, onEdit, onOpenHelp = null }) {
  host.innerHTML = '';
  const byName = new Map((params ?? []).map(p => [p.name, p]));
  for (const name of visibleReturnSettings(byName, bootstrap)) {
    const param = byName.get(name);
    const row = document.createElement('label');
    row.className = 'mc-return-setting';
    row.dataset.paramName = name;
    row.title = param.description ?? '';

    const text = document.createElement('span');
    text.className = 'mc-return-setting-label';
    text.textContent = shortLabel(param);
    row.appendChild(text);

    let input;
    if (param.type === 'Enum') {
      input = document.createElement('select');
      for (const opt of param.options ?? []) {
        const el = document.createElement('option');
        el.value = opt;
        el.textContent = param.optionLabels?.[opt] ?? opt;
        input.appendChild(el);
      }
      input.value = param.value ?? param.options?.[0] ?? '';
      input.addEventListener('change', () => { param.value = input.value; onEdit(name); });
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.step = '1';
      input.placeholder = PLACEHOLDER[name] ?? '';
      input.value = param.value == null ? '' : String(param.value);
      input.addEventListener('change', () => {
        const raw = input.value.trim();
        param.value = raw === '' ? null : parseInt(raw, 10);
        onEdit(name);
      });
    }
    input.className = 'mc-return-setting-input';
    row.appendChild(input);

    if (typeof onOpenHelp === 'function') {
      const help = document.createElement('button');
      help.type = 'button';
      help.className = 'param-help-btn';
      help.textContent = '?';
      help.title = `Help: ${param.label ?? name}`;
      help.addEventListener('click', (e) => { e.preventDefault(); onOpenHelp({ param: name }); });
      row.appendChild(help);
    }
    host.appendChild(row);
  }
}
