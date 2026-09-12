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
 * The ☆ a panel puts beside a value it shows, to watch that value's state path —
 * design 101 W5, the "producers" half of §3's diagram.
 *
 * ★ means the path is in the ACTIVE watchlist, the same meaning as the State panel's
 * checkbox (W-D4), and clicking toggles it: an add is charted, exactly as a check is.
 * The star is markup, not a node with its own listener, because both producing panels
 * re-render their tables with `innerHTML` on every sim step; one delegated listener on
 * the panel root survives that, and a per-star one would be re-attached (and leaked).
 *
 * A panel with no `runtime.watchlist` (no scenario loaded, or a test rig without one)
 * renders no star at all, so its columns are unchanged.
 */

export const WATCH_PATH_ATTR = 'data-watch-path';

/**
 * @param {string}  path     the state path the star watches
 * @param {object}  opts
 * @param {boolean} opts.watched  in the active list
 * @param {string}  opts.what     what the star watches, for its hover ("EMP price index")
 */
export function watchStarHtml(path, { watched, what }) {
  const title = watched
    ? `Watching ${what}: click to remove it from the active watchlist`
    : `Watch ${what}: add it to the active watchlist and chart it`;
  return `<button type="button" class="wl-star${watched ? ' is-watched' : ''}" ${WATCH_PATH_ATTR}="${_attr(path)}"`
    + ` aria-pressed="${watched}" title="${_attr(`${title}\n${path}`)}">${watched ? '★' : '☆'}</button>`;
}

/** True when the click landed on a star, so a row's own click handler can stand aside. */
export function isWatchStarClick(e) {
  return !!e.target?.closest?.(`[${WATCH_PATH_ATTR}]`);
}

/**
 * One delegated listener on `root` that toggles the clicked star's path. Idempotent per
 * root, since `onMount` runs again on every remount of a docked panel.
 *
 * @param {HTMLElement} root
 * @param {() => object|null} watchlist  returns `runtime.watchlist`, read at click time
 *                                       (the facade is replaced on every scenario load)
 */
export function bindWatchStars(root, watchlist) {
  if (!root || root._watchStarsBound) return;
  root._watchStarsBound = true;
  root.addEventListener('click', (e) => {
    const star = e.target?.closest?.(`[${WATCH_PATH_ATTR}]`);
    if (!star || !root.contains(star)) return;
    e.stopPropagation();
    const wl   = watchlist();
    const path = star.getAttribute(WATCH_PATH_ATTR);
    if (!wl || !path) return;
    if (wl.has(path)) wl.remove(path);
    else              wl.add(path, { charted: true });
  });
}

function _attr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
