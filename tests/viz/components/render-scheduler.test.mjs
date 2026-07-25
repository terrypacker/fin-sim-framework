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
 * render-scheduler.test.mjs — the coalescing/throttling unit extracted from
 * BaseComponent so TimelinePresenter could share it (design 78 §6).
 *
 * The two `immediate` modes and `flushOnRelease` exist because the two callers
 * genuinely differ; these pin both, so a future simplification that collapses
 * them fails here rather than silently changing when the timeline paints.
 */

import assert from 'node:assert/strict';
import { RenderScheduler } from '../../../src/visualization/components/render-scheduler.js';

const tick = ms => new Promise(r => setTimeout(r, ms));

// ─── immediate mode ───────────────────────────────────────────────────────────

test('RS-1: immediate:"sync" runs the callback inline when unthrottled', () => {
  const s = new RenderScheduler({ immediate: 'sync' });
  let n = 0;
  s.schedule(() => n++);
  assert.equal(n, 1, 'sync mode must have rendered before schedule() returned');
});

test('RS-2: immediate:"raf" defers when unthrottled', async () => {
  const s = new RenderScheduler({ immediate: 'raf' });
  let n = 0;
  s.schedule(() => n++);
  assert.equal(n, 0, 'raf mode must not render synchronously');
  await new Promise(r => requestAnimationFrame(r));
  assert.equal(n, 1, 'raf mode renders on the next frame');
});

test('RS-3: raf mode coalesces a burst into one render', async () => {
  const s = new RenderScheduler({ immediate: 'raf' });
  let n = 0;
  for (let i = 0; i < 5; i++) s.schedule(() => n++);
  await new Promise(r => requestAnimationFrame(r));
  assert.equal(n, 1, 'five requests in one frame must paint once');
});

// ─── throttling ───────────────────────────────────────────────────────────────

test('RS-4: a throttle defers and coalesces, in both immediate modes', async () => {
  for (const immediate of ['sync', 'raf']) {
    const s = new RenderScheduler({ immediate });
    let n = 0;
    s.setThrottle(50);
    for (let i = 0; i < 5; i++) s.schedule(() => n++);
    assert.equal(n, 0, `${immediate}: throttled renders must not run immediately`);
    await tick(80);
    assert.equal(n, 1, `${immediate}: the burst must coalesce into one render`);
  }
});

test('RS-5: the first queued callback wins, not the last', async () => {
  const s = new RenderScheduler({ immediate: 'raf' });
  const ran = [];
  s.setThrottle(30);
  s.schedule(() => ran.push('first'));
  s.schedule(() => ran.push('second'));
  await tick(60);
  assert.deepEqual(ran, ['first'],
    'a queued render is never replaced — BaseComponent has always behaved this way');
});

// ─── flushOnRelease ───────────────────────────────────────────────────────────

test('RS-6: flushOnRelease runs a queued render when the throttle returns to 0', async () => {
  const s = new RenderScheduler({ immediate: 'sync', flushOnRelease: true });
  let n = 0;
  s.setThrottle(10_000);          // long enough that the timer cannot fire on its own
  s.schedule(() => n++);
  assert.equal(n, 0);
  s.setThrottle(0);
  assert.equal(n, 1, 'releasing the throttle must flush — this is what stops playback leaving a stale frame');
});

test('RS-7: without flushOnRelease, releasing the throttle does not force a render', async () => {
  const s = new RenderScheduler({ immediate: 'raf' });
  let n = 0;
  s.setThrottle(10_000);
  s.schedule(() => n++);
  s.setThrottle(0);
  assert.equal(n, 0, 'components that repaint on the next tick must keep their existing behaviour');
});

test('RS-8: flush is a no-op when nothing is queued', () => {
  const s = new RenderScheduler({ immediate: 'sync', flushOnRelease: true });
  let n = 0;
  s.setThrottle(500);
  s.setThrottle(0);               // release with an empty queue
  s.flush();
  assert.equal(n, 0);
});

// ─── cancel ───────────────────────────────────────────────────────────────────

test('RS-9: cancel drops a queued render without running it', async () => {
  const s = new RenderScheduler({ immediate: 'sync', flushOnRelease: true });
  let n = 0;
  s.setThrottle(30);
  s.schedule(() => n++);
  s.cancel();
  await tick(60);
  assert.equal(n, 0, 'a cancelled render must never fire — it would paint into a destroyed view');
  s.setThrottle(0);
  assert.equal(n, 0, 'and releasing the throttle afterwards must not resurrect it');
});

test('RS-10: scheduling still works after a cancel', async () => {
  const s = new RenderScheduler({ immediate: 'sync', flushOnRelease: true });
  let n = 0;
  s.setThrottle(20);
  s.schedule(() => n++);
  s.cancel();
  s.schedule(() => n++);
  await tick(50);
  assert.equal(n, 1, 'the scheduler must not be left wedged by a cancel');
});
