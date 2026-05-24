/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class TimelinePresenter {
  constructor({ controller, view, onDetail, onRewind, formatDate }) {
    this._controller = controller;
    this._view       = view;
    this._onDetail   = onDetail;
    this._onRewind   = onRewind ?? null;
    this._formatDate = formatDate ?? (d => d.toDateString());

    view.onFilterEvent  = val => { controller.filterEvent = val;  this._render(); };
    view.onFilterAction = val => { controller.filterAction = val; this._render(); };
    view.onClearFilters = ()  => {
      controller.filterEvent  = '';
      controller.filterAction = '';
      this._render();
    };
    view.onToggle  = key => { controller.toggleExpanded(key); this._render(); };
    view.onDetail  = idx => onDetail(controller.journal.journal[idx]);
    if (onRewind) {
      view.onRewind = ts => onRewind(new Date(ts));
    }
  }

  attach(journal) {
    this._controller.setJournal(journal);
    this._render();
  }

  reset() {
    this._controller.reset();
    this._render();
  }

  update() {
    const changed = this._controller.update(this._formatDate);
    if (changed) this._render();
  }

  _render() {
    if (!this._controller.journal) return;
    const ctrl = this._controller;
    this._view.render({
      groups:       ctrl.groups(this._formatDate),
      options:      ctrl.allOptions(),
      filterEvent:  ctrl.filterEvent,
      filterAction: ctrl.filterAction,
      expanded:     ctrl.expanded,
      hasRewind:    !!this._onRewind,
    });
  }
}
