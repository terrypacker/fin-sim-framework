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
 * Register the service worker (src/pwa/service-worker.js → dist/sw.js) and tell the user
 * when a new build is ready.
 *
 * Production builds only: under `vite dev` there is no sw.js, and a worker serving a
 * cached build would fight HMR.
 *
 * Updates are offered, never forced. A new build installs in the background and waits;
 * the status bar shows "New version ready · Reload", and only that click activates it.
 * When another window takes the update, this window is told rather than reloaded, since
 * its own code is now a build the worker no longer caches.
 */

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** @param {{ statusEl?: HTMLElement|null }} [opts] where to show the update prompt */
export function registerServiceWorker({ statusEl = null } = {}) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const start = () => register(statusEl).catch((e) => {
    console.warn('[pwa] service worker registration failed:', e);
  });
  // Precaching downloads the whole app; let the page finish loading first.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

async function register(statusEl) {
  const sw  = navigator.serviceWorker;
  const reg = await sw.register('/sw.js', { scope: '/' });

  // No controller ⇒ first install: the activation that follows is not an "update".
  const hadController = !!sw.controller;
  let   requested     = false;

  const offer = (worker) => show(statusEl, 'New version ready', 'Reload',
    'Switch this window to the new version of FinSim', () => {
      requested = true;
      worker.postMessage('SKIP_WAITING');
    });

  if (reg.waiting && sw.controller) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && sw.controller) offer(worker);
    });
  });

  sw.addEventListener('controllerchange', () => {
    if (requested) { window.location.reload(); return; }
    if (hadController) {
      show(statusEl, 'Updated in another window', 'Reload',
        'FinSim was updated from another window; reload to use the new version',
        () => window.location.reload());
    }
  });

  const check = () => reg.update().catch(() => {});   // offline is not an error
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

function show(el, message, action, title, onClick) {
  if (!el) return;
  const btn = document.createElement('button');
  btn.type        = 'button';
  btn.className   = 'btn btn-sm app-update-btn';
  btn.textContent = action;
  btn.title       = title;
  btn.addEventListener('click', onClick, { once: true });

  const text = document.createElement('span');
  text.textContent = message;

  el.replaceChildren(text, btn);
  el.hidden = false;
}
