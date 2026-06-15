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

export const APP_EVENTS = {
  DISPLAY_SETTINGS_CHANGED: 'app.display.settings.changed',
};

/**
 * AppDisplaySettings — single source of truth for timezone, display currency, and theme.
 *
 * Publishes APP_EVENTS.DISPLAY_SETTINGS_CHANGED to the appBus whenever any value
 * changes. Theme is applied by setting document.documentElement.dataset.theme so
 * the CSS cascade handles all plain DOM components without any JS re-render.
 * Settings persist to localStorage and are rehydrated on construction.
 *
 * @param {import('../simulation-framework/event-bus.js').EventBus} appBus
 */
export class AppDisplaySettings {
  #state = { timezone: 'utc', currency: 'USD', theme: 'dark' };

  constructor(appBus) {
    this._appBus = appBus;
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

  _set(key, value) {
    if (this.#state[key] === value) return false;
    this.#state[key] = value;
    this._persist();
    this._notify();
    return true;
  }

  _applyThemeToDom() {
    const theme = this.#state.theme;
    document.documentElement.dataset.theme = theme;

    // Scanlines class only on amber theme
    document.body.classList.toggle('scanlines', theme === 'amber');

    // Lazy-load Barlow fonts only when amber theme is first selected
    if (theme === 'amber' && !this._barlowLoaded) {
      this._barlowLoaded = true;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700;800;900&display=swap';
      document.head.appendChild(link);
    }
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
    this._appBus.publish({
      type:       APP_EVENTS.DISPLAY_SETTINGS_CHANGED,
      timezone:   this.#state.timezone,
      currency:   this.#state.currency,
      theme:      this.#state.theme,
      formatDate: this.formatDate,
    });
  }
}
