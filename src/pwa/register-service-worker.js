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
 * Register the service worker (src/pwa/service-worker.js → dist/sw.js), keep the app on
 * the newest build, and show which build is running.
 *
 * Production builds only: under `vite dev` there is no sw.js, and a worker serving a
 * cached build would fight HMR.
 *
 * Updates (rules in update-policy.js):
 *  - A new build that is ready while the page is still starting up, before the user has
 *    clicked or typed, is switched to at once. So "refresh to get the latest" works: the
 *    refresh finds the new sw.js, it installs, and the page reloads once onto it.
 *  - Later than that it is offered, never forced: the status bar shows "New version ready
 *    · Reload", and only that click activates it, so an open edit form or a running Monte
 *    Carlo is never lost. When another window takes the update, this window is told
 *    rather than reloaded, since its own code is now a build the worker no longer caches.
 *  - `?update=force` (forceUpdateIfRequested) is the escape hatch: it drops the worker and
 *    the app's caches and reloads from the network.
 */

import { appCacheNames, forceUpdateTarget, formatBuildStamp, shouldApplyOnLoad,
         UPDATE_CHECK_MS } from './update-policy.js';

/** The commit this bundle was built from; vite.config.js defines it, `vite dev` does not. */
const RELEASE = typeof __FINSIM_RELEASE__ !== 'undefined' ? __FINSIM_RELEASE__ : null;

/** Show the running build in the status bar (`el` is #appBuildStamp). */
export function showBuildStamp(el) {
  if (!el) return;
  const { text, title } = formatBuildStamp(RELEASE);
  el.textContent = text;
  el.title       = title;
  el.hidden      = false;
}

/**
 * The `?update=force` escape hatch, for a tester stuck on an old build: unregister every
 * worker, delete the app's caches, refetch the page past the HTTP cache, and reload to the
 * same url without the parameter. Saved scenarios are untouched (they live in IndexedDB /
 * localStorage, not Cache Storage).
 *
 * Call before the app boots; when it returns true a reload is under way and the caller
 * should not start the app.
 */
export async function forceUpdateIfRequested() {
  const target = forceUpdateTarget(window.location.href);
  if (!target) return false;

  try {
    const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(regs.map(r => r.unregister()));
  } catch (e) { console.warn('[pwa] force update: unregister failed:', e); }

  try {
    if ('caches' in window) {
      await Promise.all(appCacheNames(await caches.keys()).map(k => caches.delete(k)));
    }
  } catch (e) { console.warn('[pwa] force update: cache clear failed:', e); }

  // GitHub Pages serves index.html with max-age=600; refresh that entry so the reload
  // cannot be answered by a stale copy naming the old hashed bundles.
  try { await fetch(target, { cache: 'reload' }); } catch { /* offline: reload anyway */ }

  console.info('[pwa] force update: worker and caches cleared, reloading');
  window.location.replace(target);
  return true;
}

/** @param {{ statusEl?: HTMLElement|null }} [opts] where to show the update prompt */
export function registerServiceWorker({ statusEl = null } = {}) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  // Any click or keypress means the user may have work in flight: from then on a new
  // build is offered, not applied.
  let interacted = false;
  const touched = () => { interacted = true; };
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, touched, { capture: true, once: true, passive: true });
  }
  const hasInteracted = () => interacted;

  const start = () => register(statusEl, hasInteracted).catch((e) => {
    console.warn('[pwa] service worker registration failed:', e);
  });
  // Precaching downloads the whole app; let the page finish loading first.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

async function register(statusEl, hasInteracted) {
  const sw  = navigator.serviceWorker;
  const reg = await sw.register('/sw.js', { scope: '/' });

  // No controller ⇒ first install: the activation that follows is not an "update".
  const hadController = !!sw.controller;
  let   requested     = false;

  const activate = (worker) => {
    requested = true;
    worker.postMessage('SKIP_WAITING');
  };

  const ready = (worker) => {
    if (shouldApplyOnLoad({ hasController: !!sw.controller, interacted: hasInteracted(),
                            sinceLoadMs: performance.now() })) {
      console.info('[pwa] new build ready at startup; switching to it');
      activate(worker);
      return;
    }
    offer(statusEl, worker, () => activate(worker));
  };

  if (reg.waiting && sw.controller) ready(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && sw.controller) ready(worker);
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

/** "New version ready (b05abeb6 · 21 Nov 2026) · Reload", naming the waiting build. */
async function offer(statusEl, worker, onClick) {
  const next  = await releaseOf(worker);
  const label = next?.sha ? ` (${formatBuildStamp(next).text})` : '';
  show(statusEl, `New version ready${label}`, 'Reload',
    'Switch this window to the new version of FinSim', onClick);
}

/** Ask a worker which commit it was built from; null if it does not answer (older sw.js). */
function releaseOf(worker) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer   = setTimeout(() => resolve(null), 1000);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data ?? null); };
    worker.postMessage('GET_RELEASE', [channel.port2]);
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
