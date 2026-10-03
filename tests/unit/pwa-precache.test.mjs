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
 * pwa-precache.test.mjs — the service worker's precache manifest (scripts/lib/pwa-precache.mjs).
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { precacheManifest, renderServiceWorker } from '../../scripts/lib/pwa-precache.mjs';

const files = () => [
  { path: 'index.html',                bytes: '<html>' },
  { path: 'assets/index-abc.js',       bytes: 'app' },
  { path: 'assets/mc-worker-def.js',   bytes: 'mc' },
  { path: 'help/help-index.json',      bytes: '{"topics":[]}' },
  { path: 'CNAME',                     bytes: 'finsim.example.com' },
  { path: 'sw.js',                     bytes: 'old worker' },
  { path: 'assets/index-abc.js.map',   bytes: 'map' },
  { path: 'img/.DS_Store',             bytes: 'x' },
];

test('precaches the app and public files, sorted, under the base path', () => {
  assert.deepEqual(precacheManifest(files()).urls, [
    '/assets/index-abc.js', '/assets/mc-worker-def.js', '/help/help-index.json', '/index.html',
  ]);
  assert.deepEqual(precacheManifest(files(), '/finsim/').urls[0], '/finsim/assets/index-abc.js');
});

test('the host-only files, the worker itself, source maps and .DS_Store are not precached', () => {
  const urls = precacheManifest(files()).urls;
  for (const u of ['/CNAME', '/sw.js', '/assets/index-abc.js.map', '/img/.DS_Store']) {
    assert.ok(!urls.includes(u), u);
  }
});

test('build id follows CONTENT: an unhashed public file edit alone yields a new build', () => {
  const a = precacheManifest(files()).build;
  const edited = files().map(f => f.path === 'help/help-index.json' ? { ...f, bytes: '{"topics":[1]}' } : f);
  assert.notEqual(precacheManifest(edited).build, a);
});

test('build id is independent of file order and of excluded files', () => {
  const a = precacheManifest(files()).build;
  const shuffled = files().reverse().map(f => f.path === 'CNAME' ? { ...f, bytes: 'other' } : f);
  assert.equal(precacheManifest(shuffled).build, a);
});

test('the rendered worker is the manifest assignment followed by the source', () => {
  const out = renderServiceWorker('const x = 1;', { build: 'b', urls: ['/index.html'] });
  assert.equal(out, 'self.__FINSIM_SW__ = {"build":"b","urls":["/index.html"]};\nconst x = 1;');
});
