/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { EventBus }                          from '../../src/simulation-framework/event-bus.js';
import { AppDisplaySettings, APP_EVENTS }    from '../../src/visualization/app-display-settings.js';

const STORAGE_KEY = 'finsim.displaySettings.v1';

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

function makeSettings(bus) {
  return new AppDisplaySettings(bus ?? new EventBus());
}

// ─── Default state ────────────────────────────────────────────────────────────

test('AppDisplaySettings: timezone defaults to utc', () => {
  assert.strictEqual(makeSettings().timezone, 'utc');
});

test('AppDisplaySettings: displayCurrency defaults to USD', () => {
  assert.strictEqual(makeSettings().displayCurrency, 'USD');
});

test('AppDisplaySettings: theme defaults to dark', () => {
  assert.strictEqual(makeSettings().theme, 'dark');
});

test('AppDisplaySettings: formatDate is a function', () => {
  assert.strictEqual(typeof makeSettings().formatDate, 'function');
});

// ─── No legacy subscribe() ────────────────────────────────────────────────────

test('AppDisplaySettings: has no subscribe() method', () => {
  assert.strictEqual(typeof makeSettings().subscribe, 'undefined');
});

// ─── setTimezone publishes to appBus ─────────────────────────────────────────

test('AppDisplaySettings.setTimezone: publishes APP_EVENTS.DISPLAY_SETTINGS_CHANGED', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let event      = null;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, e => { event = e; });

  settings.setTimezone('local');

  assert.ok(event !== null, 'event should have been published');
  assert.strictEqual(event.type, APP_EVENTS.DISPLAY_SETTINGS_CHANGED);
  assert.strictEqual(event.timezone, 'local');
});

test('AppDisplaySettings.setTimezone: snapshot includes currency and theme', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let event      = null;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, e => { event = e; });

  settings.setTimezone('local');

  assert.strictEqual(event.currency, 'USD');
  assert.strictEqual(event.theme, 'dark');
  assert.strictEqual(typeof event.formatDate, 'function');
});

test('AppDisplaySettings.setTimezone: does NOT publish when value is unchanged', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let count      = 0;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => { count++; });

  settings.setTimezone('utc');  // same as default

  assert.strictEqual(count, 0);
});

// ─── setCurrency publishes to appBus ─────────────────────────────────────────

test('AppDisplaySettings.setCurrency: publishes with new currency', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let event      = null;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, e => { event = e; });

  settings.setCurrency('AUD');

  assert.strictEqual(event.currency, 'AUD');
  assert.strictEqual(event.timezone, 'utc');
});

test('AppDisplaySettings.setCurrency: does NOT publish when value is unchanged', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let count      = 0;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => { count++; });

  settings.setCurrency('USD');  // same as default

  assert.strictEqual(count, 0);
});

// ─── setTheme publishes to appBus ─────────────────────────────────────────────

test('AppDisplaySettings.setTheme: publishes with new theme', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let event      = null;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, e => { event = e; });

  settings.setTheme('light');

  assert.strictEqual(event.theme, 'light');
});

test('AppDisplaySettings.setTheme: does NOT publish when value is unchanged', () => {
  const bus      = new EventBus();
  const settings = makeSettings(bus);
  let count      = 0;
  bus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => { count++; });

  settings.setTheme('dark');  // same as default

  assert.strictEqual(count, 0);
});

// ─── localStorage persistence ─────────────────────────────────────────────────

test('AppDisplaySettings: persists settings to localStorage on change', () => {
  const settings = makeSettings();
  settings.setTimezone('local');
  settings.setCurrency('AUD');

  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  assert.strictEqual(stored.timezone, 'local');
  assert.strictEqual(stored.currency, 'AUD');
});

test('AppDisplaySettings: rehydrates from localStorage on construction', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ timezone: 'local', currency: 'AUD', theme: 'light' }));

  const settings = makeSettings();

  assert.strictEqual(settings.timezone, 'local');
  assert.strictEqual(settings.displayCurrency, 'AUD');
  assert.strictEqual(settings.theme, 'light');
});

// ─── APP_EVENTS constant ──────────────────────────────────────────────────────

test('APP_EVENTS.DISPLAY_SETTINGS_CHANGED is a non-empty string', () => {
  assert.strictEqual(typeof APP_EVENTS.DISPLAY_SETTINGS_CHANGED, 'string');
  assert.ok(APP_EVENTS.DISPLAY_SETTINGS_CHANGED.length > 0);
});
