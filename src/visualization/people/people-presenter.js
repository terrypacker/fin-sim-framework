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
 * PeoplePresenter — wires PeopleView callbacks to PeopleController and keeps
 * the list in sync with the service bus.
 *
 * Subscribes to SERVICE_ACTION events so that deserialization (ScenarioSerializer
 * calling personService.register()) automatically re-renders the list without
 * any additional wiring.
 *
 * Exposes `onPeopleChanged(people[])` for AccountsPresenter to update its
 * owner dropdown whenever the people list changes.
 */
export class PeoplePresenter {
  /**
   * @param {{
   *   controller: import('./people-controller.js').PeopleController,
   *   view:       import('./people-view.js').PeopleView,
   *   bus:        import('../../simulation-framework/event-bus.js').EventBus
   * }}
   */
  constructor({ controller, view, bus }) {
    this._controller = controller;
    this._view       = view;

    /**
     * Optional hook for AccountsPresenter — called after any people change.
     * @type {function(import('../../finance/person.js').Person[])|null}
     */
    this.onPeopleChanged = null;

    // ── Wire view callbacks → controller ───────────────────────────────────

    this._view.onSave = (data) => {
      if (data.id) {
        const { id, ...changes } = data;
        this._controller.update(id, changes);
      } else {
        this._controller.create(data);
      }
      this._view.hideForm();
    };

    this._view.onEdit = (person) => {
      this._view.showForm(person);
    };

    this._view.onDelete = (id) => {
      this._controller.delete(id);
      this._view.hideForm();
    };

    this._view.onCancel = () => {
      this._view.hideForm();
    };

    // ── React to service bus (deserialization, programmatic changes) ────────
    bus.subscribe('SERVICE_ACTION', (msg) => {
      if (msg.classType === 'Person') this._refresh();
    });

    // Initial render (handles the case where people were loaded before mount).
    this._refresh();
  }

  _refresh() {
    const people = this._controller.list();
    this._view.renderList(people);
    if (this.onPeopleChanged) this.onPeopleChanged(people);
  }
}
