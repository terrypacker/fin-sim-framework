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
 * cli.mjs — flag parsing for study scripts.
 *
 * Seventeen scripts declared `process.argv.slice(2)` and then defined a `flag()`
 * helper, in four mutually incompatible spellings. That is not a duplication problem
 * so much as a silence problem: every one of those helpers returns `undefined` for a
 * flag it does not know, so `node study.mjs --shock-yr 2033` (for `--shock-year`)
 * runs the default and says nothing. A mistyped `--shock` is one of the two failures
 * that produced a complete, plausible, meaningless grid in `offset-bond-pool`.
 *
 * So the contract here is: **declare the flags, and an unknown one is an error.**
 * Everything else — types, defaults, `--help` — falls out of the declaration.
 *
 *   const opts = parseFlags(process.argv.slice(2), {
 *     usage:    'node scenarios/x/run-study.mjs [options]',
 *     scenario: { type: 'string', default: 'scenarios/x/plan.json', help: 'base export' },
 *     n:        { type: 'number', default: 300, help: 'paths per arm' },
 *     only:     { type: 'list',   default: [],  help: 'subset of column ids' },
 *     paths:    { type: 'flag',                 help: 'stochastic return paths' },
 *   });
 *   opts.scenario, opts.n, opts.only, opts.paths
 *
 * Flags are `--kebab-case` on the command line and `camelCase` on the result, so
 * `--shock-year` reads back as `opts.shockYear`. `-h` / `--help` prints the usage
 * built from `help:` strings and exits 0.
 */

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Parse `argv` against `spec`, printing a clean message and exiting 2 on misuse.
 *
 * Exits rather than throws because every caller is a command-line entry point, and a
 * V8 stack trace above the one line that matters teaches the reader to skim past it —
 * which is how a typo'd flag gets ignored twice. `parseFlagsOrThrow` is the same
 * function for a caller that wants to handle the error itself.
 *
 * @param {string[]} argv  usually `process.argv.slice(2)`
 * @param {object}   spec  `{ usage?, <name>: { type, default?, help?, choices? } }`
 *        type: 'string' | 'number' | 'flag' | 'list' (comma-separated → string[])
 * @returns {object} parsed values, keyed camelCase
 */
export function parseFlags(argv, spec = {}) {
  try {
    return parseFlagsOrThrow(argv, spec);
  } catch (e) {
    console.error(`\n${e.message}\n`);
    process.exit(2);
  }
}

/** @see parseFlags */
export function parseFlagsOrThrow(argv, spec = {}) {
  const { usage = '', ...flags } = spec;
  const byFlag = new Map();
  for (const [name, def] of Object.entries(flags)) byFlag.set(`--${kebab(name)}`, [name, def]);

  const help = () => {
    const lines = Object.entries(flags).map(([name, def]) => {
      const arg = def.type === 'flag' ? '' : ` <${def.type}>`;
      const dflt = def.default !== undefined && def.type !== 'flag'
        ? `  (default: ${Array.isArray(def.default) ? def.default.join(',') || '—' : def.default})` : '';
      return `  --${kebab(name)}${arg}`.padEnd(28) + `${def.help ?? ''}${dflt}`;
    });
    console.log(`\n${usage}\n\n${lines.join('\n')}\n`);
  };

  if (argv.includes('-h') || argv.includes('--help')) { help(); process.exit(0); }

  const out = {};
  for (const [name, def] of Object.entries(flags)) {
    out[camel(name)] = def.type === 'flag' ? false : def.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`cli: unexpected argument "${token}". This script takes flags only.`);
    }
    const hit = byFlag.get(token);
    if (!hit) {
      // The whole point. A typo that silently selects the default is the failure this
      // module exists to prevent, so name the near-miss rather than just refusing.
      const known = [...byFlag.keys()];
      const near = known.filter(k => k.startsWith(token.slice(0, 5)) || token.startsWith(k.slice(0, 5)));
      throw new Error(`cli: unknown flag "${token}".`
        + (near.length ? `  Did you mean ${near.join(' or ')}?` : '')
        + `\n     known flags: ${known.join(' ')}`);
    }
    const [name, def] = hit;
    if (def.type === 'flag') { out[camel(name)] = true; continue; }

    const raw = argv[++i];
    if (raw === undefined || raw.startsWith('--')) {
      throw new Error(`cli: ${token} needs a value.`);
    }
    let value;
    if (def.type === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`cli: ${token} expects a number, got "${raw}".`);
    } else if (def.type === 'list') {
      value = raw.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      value = raw;
    }
    if (def.choices && !(def.type === 'list'
      ? value.every(v => def.choices.includes(v))
      : def.choices.includes(value))) {
      throw new Error(`cli: ${token} must be one of ${def.choices.join(', ')} — got "${raw}".`);
    }
    out[camel(name)] = value;
  }
  return out;
}

/**
 * Set a scenario param, writing BOTH stores.
 *
 * `variant.mjs` exports `makeSetParam(cfg)` for the same job and is what a tool built
 * on the lever bag should use. This is the raw version for a study that holds a parsed
 * scenario document rather than a loaded cfg, and it exists because thirteen study
 * scripts wrote `cfg.params.find(p => (p.key || p.name) === k).value = v` inline —
 * which has two failure modes they were each one edit away from:
 *
 *  · `name` is the IDENTITY field. `ScenarioLoader` syncs `cfg.parameters[p.name]`, so
 *    a row matched or created with only `key` reads back correctly here and is silently
 *    dropped on the way to the compiler. That cost this codebase two grids.
 *  · A param absent from the list throws on `.value` rather than being added, so a
 *    lever the plan never authored cannot be set at all.
 *
 * @returns {object} the cfg, for chaining
 */
export function setParam(cfg, key, value) {
  const row = (cfg.params ??= []).find(x => (x.name ?? x.key) === key);
  if (row) { row.value = value; } else { cfg.params.push({ name: key, key, value }); }
  if (cfg.parameters) cfg.parameters[key] = value;
  return cfg;
}

/** Read a param's value from either store. */
export const getParam = (cfg, key) =>
  cfg.params?.find(x => (x.name ?? x.key) === key)?.value ?? cfg.parameters?.[key];
