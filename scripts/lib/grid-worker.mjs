#!/usr/bin/env node
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
 * grid-worker.mjs — the worker half of ./parallel.mjs. Not run by hand.
 *
 * Reads `{ source, jobs: [{ id, levers }] }` from a file, applies each lever bag to
 * the base cfg, runs it, and writes `[{ id, ...row }]` back out. One process per
 * shard; the base cfg is loaded once here and cloned per job.
 *
 * Errors are CAPTURED PER JOB rather than allowed to kill the shard: one bad cell
 * (a lever naming a stateKey this scenario lacks) would otherwise take a few dozen
 * good results with it. A failed cell comes back with an `error` field, and the
 * reporters render it as `?` — visibly missing rather than silently absent.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { loadBaseConfig } from './scenario-source.mjs';
import { buildVariant }   from './variant.mjs';
import { run }            from './run.mjs';

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('usage: grid-worker.mjs <inFile> <outFile>   (invoked by parallel.mjs)');
  process.exit(2);
}

const { source, jobs } = JSON.parse(readFileSync(inFile, 'utf8'));
const { cfg } = loadBaseConfig(source ?? {});

const out = jobs.map(({ id, levers }) => {
  try {
    return { id, ...run(buildVariant(cfg, levers ?? {})) };
  } catch (err) {
    return { id, error: err?.message ?? String(err) };
  }
});

writeFileSync(outFile, JSON.stringify(out));
