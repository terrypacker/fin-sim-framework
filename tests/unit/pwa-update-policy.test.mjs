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
 * pwa-update-policy.test.mjs — when a new build is applied, the ?update=force escape hatch,
 * and the build stamp (src/pwa/update-policy.js, scripts/lib/pwa-precache.mjs releaseInfo).
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { appCacheNames, forceUpdateTarget, formatBuildStamp, shouldApplyOnLoad,
         STARTUP_WINDOW_MS } from '../../src/pwa/update-policy.js';
import { precacheManifest, releaseInfo, renderServiceWorker }
  from '../../scripts/lib/pwa-precache.mjs';

test('a build ready at startup, before any interaction, is applied', () => {
  assert.equal(shouldApplyOnLoad({ hasController: true, interacted: false, sinceLoadMs: 4000 }), true);
});

test('after a click or keypress the build is only offered', () => {
  assert.equal(shouldApplyOnLoad({ hasController: true, interacted: true, sinceLoadMs: 4000 }), false);
});

test('a build that lands after the startup window is only offered', () => {
  assert.equal(shouldApplyOnLoad({ hasController: true, interacted: false,
                                   sinceLoadMs: STARTUP_WINDOW_MS }), true);
  assert.equal(shouldApplyOnLoad({ hasController: true, interacted: false,
                                   sinceLoadMs: STARTUP_WINDOW_MS + 1 }), false);
});

test('the first install (no controller) is not an update', () => {
  assert.equal(shouldApplyOnLoad({ hasController: false, interacted: false, sinceLoadMs: 0 }), false);
});

test('?update=force reloads to the same url without the parameter', () => {
  assert.equal(forceUpdateTarget('https://finsim.example.com/?update=force'),
               'https://finsim.example.com/');
  assert.equal(forceUpdateTarget('https://finsim.example.com/?a=1&update=force&b=2#tab'),
               'https://finsim.example.com/?a=1&b=2#tab');
});

test('no force without the exact parameter value', () => {
  assert.equal(forceUpdateTarget('https://finsim.example.com/'), null);
  assert.equal(forceUpdateTarget('https://finsim.example.com/?update=1'), null);
  assert.equal(forceUpdateTarget('https://finsim.example.com/?force'), null);
});

test('a forced update deletes only the app worker caches', () => {
  assert.deepEqual(appCacheNames(['finsim-app-abc', 'finsim-fonts', 'other-site', 'workbox-x']),
                   ['finsim-app-abc', 'finsim-fonts']);
});

test('the build stamp is the short sha and the commit day, read from the string', () => {
  const s = formatBuildStamp({ sha: 'b05abeb6c0ffee1234567890', date: '2026-11-21T23:30:00-05:00',
                               dirty: false });
  assert.equal(s.text, 'b05abeb6 · 21 Nov 2026');      // not shifted into the viewer's zone
  assert.match(s.title, /b05abeb6c0ffee1234567890/);
  assert.match(s.title, /2026-11-21T23:30:00-05:00/);
});

test('a dirty build is marked, and a dev build says so', () => {
  assert.equal(formatBuildStamp({ sha: 'b05abeb6c0ffee', date: null, dirty: true }).text, 'b05abeb6+');
  assert.equal(formatBuildStamp(null).text, 'dev build');
  assert.equal(formatBuildStamp({ sha: null }).text, 'dev build');
});

test('releaseInfo reads the commit, the commit date and a dirty tree from git', () => {
  const git = (args) => (args[0] === 'log' ? 'abc123\n2026-11-21T09:00:00+11:00\n' : ' M src/x.js\n');
  assert.deepEqual(releaseInfo({ git }), { sha: 'abc123', date: '2026-11-21T09:00:00+11:00', dirty: true });
  const clean = (args) => (args[0] === 'log' ? 'abc123\n2026-11-21T09:00:00+11:00\n' : '');
  assert.equal(releaseInfo({ git: clean }).dirty, false);
});

test('releaseInfo falls back to nulls when git is unavailable', () => {
  assert.deepEqual(releaseInfo({ git: () => { throw new Error('no git'); } }),
                   { sha: null, date: null, dirty: false });
});

test('the release rides in the worker manifest, and does not change the build id', () => {
  const files   = [{ path: 'index.html', bytes: '<html>' }];
  const release = { sha: 'abc123', date: '2026-11-21T09:00:00+11:00', dirty: false };
  const m = precacheManifest(files, '/', release);
  assert.deepEqual(m.release, release);
  assert.equal(m.build, precacheManifest(files).build);
  assert.match(renderServiceWorker('', m), /"release":\{"sha":"abc123"/);
});
