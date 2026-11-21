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
 * update-policy.js — the pure decisions behind app updates (register-service-worker.js).
 *
 * Kept free of `navigator`, `window` and `import.meta.env` so the rules are unit-testable
 * under node (tests/unit/pwa-update-policy.test.mjs).
 *
 *  - apply on load   a new build that is ready before the user has touched the page is
 *                    switched to at once (one reload); after that it is only offered.
 *  - force update    `?update=force` drops the worker and its caches, then reloads clean.
 *  - build stamp     the commit a build came from, for the status bar and bug reports.
 */

/** A build that finishes installing later than this after load is offered, not applied. */
export const STARTUP_WINDOW_MS = 30 * 1000;

/** How often an open window asks the host for a new sw.js (only that small file is fetched). */
export const UPDATE_CHECK_MS = 10 * 60 * 1000;

/** The query parameter, and value, that triggers a forced clean reload. */
export const FORCE_PARAM = 'update';
export const FORCE_VALUE = 'force';

/** Cache-name prefix every cache the app's worker owns starts with. */
export const CACHE_PREFIX = 'finsim-';

/**
 * Switch to a ready build now, or offer it?
 *
 * Only when the page has a controller (no controller = first install, nothing to switch
 * from), the user has not yet interacted (no edit form or run in flight to lose), and the
 * page is still starting up (a reload long after load would be a surprise).
 *
 * @param {{ hasController: boolean, interacted: boolean, sinceLoadMs: number }} s
 */
export function shouldApplyOnLoad({ hasController, interacted, sinceLoadMs }) {
  return hasController && !interacted && sinceLoadMs <= STARTUP_WINDOW_MS;
}

/**
 * The url to reload to when `href` asks for a forced update, else null. The parameter is
 * removed so the reload does not force again; other query parameters and the hash stay.
 */
export function forceUpdateTarget(href) {
  const url = new URL(href);
  if (url.searchParams.get(FORCE_PARAM) !== FORCE_VALUE) return null;
  url.searchParams.delete(FORCE_PARAM);
  return url.toString();
}

/** The cache names a forced update deletes: every one the app's worker owns. */
export function appCacheNames(keys) {
  return keys.filter(k => k.startsWith(CACHE_PREFIX));
}

/**
 * The status-bar build stamp, e.g. `{ text: 'b05abeb6 · 21 Nov 2026', title: '…' }`.
 *
 * @param {{ sha?: string|null, date?: string|null, dirty?: boolean }|null} info
 *        from the build's `__FINSIM_RELEASE__` (vite.config.js); null under `vite dev`
 */
export function formatBuildStamp(info) {
  if (!info?.sha) return { text: 'dev build', title: 'Not a production build' };
  const short = info.sha.slice(0, 8) + (info.dirty ? '+' : '');
  const day   = formatDay(info.date);
  return {
    text:  day ? `${short} · ${day}` : short,
    title: `Build ${info.sha}${info.dirty ? ' (uncommitted changes)' : ''}`
         + (info.date ? `, committed ${info.date}` : ''),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-21T09:30:00+11:00' → '21 Nov 2026', read from the string, not the viewer's zone. */
function formatDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}
