/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { fmtUTC, fmtLocal } from './ui-utils.js';

const STORAGE_KEY = 'finsim.displaySettings.v1';

/**
 * AppDisplaySettings — single source of truth for timezone, display currency, and theme.
 *
 * Components subscribe via subscribe(fn) to receive a snapshot whenever any value
 * changes. The returned function unsubscribes. Theme is applied by setting
 * document.documentElement.dataset.theme so the CSS cascade handles all plain
 * DOM components without any JS re-render. Settings persist to localStorage and
 * are rehydrated on construction.
 */
export class AppDisplaySettings {
  #state = { timezone: 'utc', currency: 'USD', theme: 'dark' };
  #subscribers = new Set();

  constructor() {
    this._loadFromStorage();
    this._applyThemeToDom();
  }

  get timezone()        { return this.#state.timezone; }
  get displayCurrency() { return this.#state.currency; }
  get theme()           { return this.#state.theme; }

  get formatDate() {
    return this.#state.timezone === 'utc' ? fmtUTC : fmtLocal;
  }

  setTimezone(tz)   { this._set('timezone', tz); }
  setCurrency(code) { this._set('currency', code); }
  setTheme(theme)   { if (this._set('theme', theme)) this._applyThemeToDom(); }

  /** Returns an unsubscribe function. */
  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  _set(key, value) {
    if (this.#state[key] === value) return false;
    this.#state[key] = value;
    this._persist();
    this._notify();
    return true;
  }

  _applyThemeToDom() {
    document.documentElement.dataset.theme = this.#state.theme;
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const { timezone, currency, theme } = JSON.parse(raw);
      if (timezone) this.#state.timezone = timezone;
      if (currency) this.#state.currency = currency;
      if (theme)    this.#state.theme    = theme;
    } catch { /* ignore — fall back to defaults */ }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        timezone: this.#state.timezone,
        currency: this.#state.currency,
        theme:    this.#state.theme,
      }));
    } catch { /* ignore quota / privacy-mode errors */ }
  }

  _notify() {
    const snapshot = {
      timezone:   this.#state.timezone,
      currency:   this.#state.currency,
      theme:      this.#state.theme,
      formatDate: this.formatDate,
    };
    for (const fn of this.#subscribers) fn(snapshot);
  }
}
