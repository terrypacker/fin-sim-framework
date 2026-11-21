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
 * pwa-precache.mjs — the service worker's precache manifest, built from the finished
 * dist/ tree by the `finsim-service-worker` plugin in vite.config.js.
 *
 * Everything the app can load is precached: one module bundle, two worker bundles, the
 * stylesheet, index.html and public/ (icons, schemas, the help index). The whole app is
 * a few MB and the one runtime fetch is the help index, so there is no case for a
 * runtime-caching strategy per route.
 *
 * The build id is a hash of every precached file's CONTENT, not of the file names.
 * Vite hashes the bundle names, but public/ is copied as-is: a help-topic edit changes
 * help/help-index.json and nothing else, and a name-only id would leave installed
 * copies serving the old help forever.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SW_FILENAME = 'sw.js';

/** Served by the host, never fetched by the app: no reason to put them in a cache. */
const EXCLUDE = [
  /^CNAME$/,
  new RegExp(`^${SW_FILENAME.replace('.', '\\.')}$`),
  /\.map$/,
  /(^|\/)\.DS_Store$/,
];

/**
 * @param {{ path: string, bytes: Buffer|Uint8Array|string }[]} files  dist-relative, '/'-separated
 * @param {string} [base]  the app's public base path (vite `base`)
 * @param {object|null} [release]  releaseInfo(), carried so a waiting worker can name its commit
 * @returns {{ build: string, urls: string[], release: object|null }}  urls sorted, so the output is reproducible
 */
export function precacheManifest(files, base = '/', release = null) {
  const kept = files
    .filter(f => !EXCLUDE.some(re => re.test(f.path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const h = createHash('sha256');
  for (const f of kept) h.update(f.path).update('\0').update(f.bytes).update('\0');

  return { build: h.digest('hex').slice(0, 16), urls: kept.map(f => base + f.path), release };
}

/**
 * The commit being built, for the status-bar build stamp and the update prompt:
 * `{ sha, date, dirty }`, or nulls when git is unavailable.
 *
 * `date` is the COMMIT date, not the build time, so rebuilding a commit stays byte-identical
 * (the build id hashes the bundle, and the stamp is compiled into it). `dirty` marks a local
 * build with uncommitted tracked changes, which the stamp shows as a trailing '+'.
 */
export function releaseInfo({ cwd = process.cwd(), git = runGit } = {}) {
  try {
    const [sha, date] = git(['log', '-1', '--format=%H%n%cI'], cwd).trim().split('\n');
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], cwd).trim() !== '';
    return { sha, date, dirty };
  } catch {
    return { sha: null, date: null, dirty: false };
  }
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Every file under `dir`, as `{ path, bytes }` with a '/'-separated relative path. */
export function readTree(dir) {
  const out = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split(sep).join('/'), bytes: readFileSync(p) });
    }
  })(dir);
  return out;
}

/**
 * The deployable worker: the manifest as a leading assignment, then the worker source.
 * Kept as a plain prefix rather than a templating placeholder so the source file stays
 * valid, lintable JavaScript.
 */
export function renderServiceWorker(source, manifest) {
  return `self.__FINSIM_SW__ = ${JSON.stringify(manifest)};\n${source}`;
}
