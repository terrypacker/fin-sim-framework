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
 * parallel.mjs — fan a job list out across worker PROCESSES.
 *
 * A full-horizon deterministic run is on the order of 10–20 seconds and a useful
 * grid is in the hundreds of cells, so serial execution turns a coffee break into
 * an afternoon. This is the one implementation of that fan-out; before it existed,
 * every grid driver carried its own copy and they drifted.
 *
 * PROCESSES, not worker_threads or an in-process loop, for a specific reason:
 * `ServiceRegistry` is a process-global singleton that `openSim` resets on every
 * run. Two sims in one process cannot be in flight at once, and a leaked registry
 * from run N silently contaminates run N+1. A process boundary makes that
 * impossible to get wrong.
 *
 * Jobs are dealt round-robin (`i % workers`) rather than in contiguous blocks so a
 * systematic cost gradient along the job list — later cells often run longer
 * because a solvent scenario keeps stepping — spreads evenly instead of leaving
 * one worker holding all the slow cells.
 */

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile }  from 'node:child_process';
import { tmpdir }    from 'node:os';
import { join }      from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @param {object}   opts
 * @param {Array}    opts.jobs      `[{ id, levers }, …]`
 * @param {object}   opts.source    `{ file, index }` — how workers load the base cfg
 * @param {string}   opts.worker    absolute path to the worker script
 * @param {number}   [opts.workers] process count (default 8)
 * @param {string}   [opts.label]   prefix for progress lines
 * @param {boolean}  [opts.progress] per-worker completion lines (default true)
 * @returns {Promise<Array>} results, one row per job, order not guaranteed
 */
export async function runJobsParallel({
  jobs, source, worker, workers = 8, label = 'jobs', progress = true,
}) {
  if (!jobs.length) return [];
  const n = Math.max(1, Math.min(workers, jobs.length));
  const dir = mkdtempSync(join(tmpdir(), 'finsim-grid-'));
  const shards = Array.from({ length: n }, () => []);
  jobs.forEach((j, i) => shards[i % n].push(j));

  const started = Date.now();
  console.error(`${jobs.length} ${label} across ${n} workers`);

  try {
    const settled = await Promise.all(shards.map(async (shard, i) => {
      const inF  = join(dir, `in${i}.json`);
      const outF = join(dir, `out${i}.json`);
      writeFileSync(inF, JSON.stringify({ source, jobs: shard }));
      await execFileAsync('node', [worker, inF, outF], { maxBuffer: 1 << 28 });
      if (progress) {
        console.error(`  worker ${i} done — ${shard.length} runs, ${elapsed(started)}`);
      }
      return JSON.parse(readFileSync(outF, 'utf8'));
    }));
    console.error(`${jobs.length} ${label} complete in ${elapsed(started)}`);
    return settled.flat();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const elapsed = (since) => `${((Date.now() - since) / 1000).toFixed(0)}s`;

/** `--workers N`, defaulting to 8. */
export function parseWorkers(argv, dflt = 8) {
  const i = argv.indexOf('--workers');
  return i >= 0 ? Math.max(1, Number(argv[i + 1]) || dflt) : dflt;
}
