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
 * Calls doInit() once the container element has non-zero rendered dimensions.
 *
 * If the container already has dimensions the call is synchronous and returns null.
 * Otherwise a ResizeObserver is created that fires doInit() on the first entry
 * with a non-zero width or height, then disconnects itself.  The observer is
 * returned so the caller can disconnect it early (e.g. on component destroy).
 *
 * @param {Element}  container
 * @param {Function} doInit
 * @returns {ResizeObserver|null}
 */
export function initEChartWhenReady(container, doInit) {
  if (container.clientWidth > 0 || container.clientHeight > 0) {
    doInit();
    return null;
  }
  let done = false;
  const ro = new ResizeObserver((entries) => {
    if (done) return;
    const r = entries[0]?.contentRect;
    if (r?.width > 0 || r?.height > 0) {
      done = true;
      ro.disconnect();
      doInit();
    }
  });
  ro.observe(container);
  return ro;
}
