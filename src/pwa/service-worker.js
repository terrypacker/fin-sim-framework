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
 * service-worker.js — offline support for the installed app.
 *
 * NOT imported by the app. The `finsim-service-worker` plugin in vite.config.js prefixes
 * this file with `self.__FINSIM_SW__ = { build, urls }` (scripts/lib/pwa-precache.mjs)
 * and writes it to dist/sw.js, so it is only ever served from a production build.
 *
 * Strategy: one cache per build, holding the whole app.
 *
 *  - install   precaches every url, atomically (addAll fails if any one does). It does
 *              NOT skipWaiting: a new build waits until the page asks for it, so an open
 *              window never has its code swapped underneath it.
 *  - activate  deletes the previous build's cache and claims the open pages.
 *  - fetch     same-origin GETs are served from this build's cache, falling back to the
 *              network; Google Fonts (typography.css) are cached as they are fetched, so
 *              the app keeps its fonts offline. Everything else passes through.
 */

const { build, urls } = self.__FINSIM_SW__;

const APP_CACHE  = `finsim-app-${build}`;
const FONT_CACHE = 'finsim-fonts';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache, so a stale CDN copy of an unhashed public
  // file (the help index) cannot be baked into a fresh build's cache.
  event.waitUntil(caches.open(APP_CACHE)
    .then(cache => cache.addAll(urls.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('finsim-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // The app is one page; '/' and '/?anything' are index.html. Matching on the
    // pathname (not the full url) lets a query string still hit the cache.
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    event.respondWith(
      caches.match(path, { cacheName: APP_CACHE }).then(hit => hit ?? fetch(req)));
    return;
  }

  if (FONT_HOSTS.has(url.hostname)) event.respondWith(fromFontCache(event));
});

/** Stale-while-revalidate: font files are immutable, the CSS rarely changes. */
async function fromFontCache(event) {
  const cache = await caches.open(FONT_CACHE);
  const hit   = await cache.match(event.request);
  const fresh = fetch(event.request)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => hit);
  event.waitUntil(fresh);
  return hit ?? fresh;
}
