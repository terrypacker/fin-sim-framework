/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { PRIORITY, REDUCER_CLASSES, ScriptedReducer } from '../../simulation-framework/reducers.js';
import { ACTION_CLASSES, FieldValueAction, ScriptedAction } from '../../simulation-framework/actions.js';
import { HANDLER_CLASSES } from '../../simulation-framework/handlers.js';
import { OneOffEvent } from "../../simulation-framework/events/one-off-event.js";
import { ACTION_TEMPLATES } from '../../simulation-framework/action-templates.js';
import {GraphNodeFilterMultiSelect} from "../components/graph-node-filter-multi-select.js";
import {BaseComponent} from "../components/base-component.js";
import {EDGE_TYPES} from "../../graph/edge.js";

/**
 * GraphBuilderView — pure DOM / template layer for the event-graph editor panel.
 *
 * Renders all node editors (Event, Handler, Action, Reducer) and the toolbar
 * "+" buttons.  Contains no ServiceRegistry calls.
 *
 * Communicates mutations outward via callback properties set by
 * GraphBuilderPresenter:
 *
 *   onFieldChange(node, field, value)       — any input changed
 *   onDelete(node)                          — Delete Node button
 *   onCreationRequested(kind, subtype)      — toolbar "+" button
 *   onLinkToggle(node, selectedItem, kind, linkTo, isAdd) — node link toggled
 *   onActionClassChange(nodeId, newClass)   — action class dropdown changed
 *   onReducerTypeChange(nodeId, newType)    — reducer type dropdown changed
 *   onHandlerClassChange(nodeId, newClass)  — handler class dropdown changed
 *
 * `editNode(node)` is the primary entry point called by the Presenter to
 * (re-)render the editor panel for a node.
 */
export class GraphBuilderView extends BaseComponent {

  /**
   * @param {{
   *   builderCanvas: HTMLElement,
   *   graph: import('../config-graph.js').ConfigGraph
   * }}
   */
  constructor({ builderCanvas, graph }) {
    super(); //I am the root component here
    this._canvas = builderCanvas;
    this._graph  = graph;

    // ── Type/option constants ─────────────────────────────────────────────

    this.EVENT_TYPES        = ['EventSeries', 'OneOffEvent'];
    this.EVENT_SERIES_TYPES = ['monthly', 'quarterly', 'annually', 'month-end', 'year-end'];

    this.PRIORITY_OPTIONS = [
      { label: 'Pre-Process',     value: PRIORITY.PRE_PROCESS },
      { label: 'Cash Flow',       value: PRIORITY.CASH_FLOW },
      { label: 'Position Update', value: PRIORITY.POSITION_UPDATE },
      { label: 'Cost Basis',      value: PRIORITY.COST_BASIS },
      { label: 'Tax Calc',        value: PRIORITY.TAX_CALC },
      { label: 'Tax Apply',       value: PRIORITY.TAX_APPLY },
      { label: 'Metrics',         value: PRIORITY.METRICS },
      { label: 'Logging',         value: PRIORITY.LOGGING },
    ];

    // Derived dynamically from class registries so the UI never drifts from
    // what the services actually support.  HANDLER_CLASSES is augmented by
    // HandlerService at module load time, so it is complete before any render.
    // (See handler-service.js Object.assign block.)
    this.REDUCER_TYPES  = Object.keys(REDUCER_CLASSES);
    this.ACTION_TYPES   = Object.keys(ACTION_CLASSES);
    this.HANDLER_TYPES  = Object.keys(HANDLER_CLASSES);

    // ── Mutation callbacks (set by Presenter) ─────────────────────────────

    /** @type {function(node, field: string, value)|null} */
    this.onFieldChange = null;
    /** @type {function(node)|null} */
    this.onDelete = null;
    /** @type {function(kind: string, subtype: string|null)|null} */
    this.onCreationRequested = null;
    /** @type {function(node, chipNode, kind, linkTo: boolean, isAdd: boolean)|null} */
    this.onLinkToggle = null;
    /** @type {function(nodeId: string, newClass: string)|null} */
    this.onActionClassChange = null;
    /** @type {function(nodeId: string, newType: string)|null} */
    this.onReducerTypeChange = null;
    /** @type {function(nodeId: string, newClass: string)|null} */
    this.onHandlerClassChange = null;
    /** @type {function(node, defData: {type, config})|null} */
    this.onActionDefinitionAdd = null;
    /** @type {function(node, defId: string)|null} */
    this.onActionDefinitionRemove = null;
    /** @type {function(node, defId: string, field: string, value)|null} */
    this.onActionDefinitionUpdate = null;

    this._buildControls();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * (Re-)render the editor panel for the given node, or show the empty state
   * when node is null.  Called by the Presenter.
   */
  editNode(node) {
    this.destroy();   // Destroy and children that have been created
    this._canvas.innerHTML = '';

    if (!node) {
      const tpl = document.getElementById('tpl-empty');
      this._canvas.appendChild(tpl.content.cloneNode(true));
      return;
    }

    if      (node.kind === 'reducer') this._renderReducerEditor(node);
    else if (node.kind === 'event')   this._renderEventEditor(node);
    else if (node.kind === 'handler') this._renderHandlerEditor(node);
    else if (node.kind === 'action')  this._renderActionEditor(node);
    else this._canvas.innerHTML = `<div class="tl-empty">${node.kind} editor coming next</div>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Populate a <select> with the known registered types and wire its onchange.
   *
   * If `currentValue` is not in `knownTypes` (a domain subclass not in the
   * registry), the select is replaced with a read-only <span> that shows the
   * class name and a "domain type" badge — changing that type via the UI is
   * not meaningful because the instance was constructed with specific
   * dependencies and business logic.
   *
   * @param {HTMLSelectElement} selectEl  - The <select> to populate or replace
   * @param {string[]}          knownTypes
   * @param {string}            currentValue
   * @param {function(string):void} onChange  - Called with the new value when changed
   */
  _renderTypeSelect(selectEl, knownTypes, currentValue, onChange) {
    if (!knownTypes.includes(currentValue)) {
      // Domain type not in the registry — show read-only badge instead of select
      const span = document.createElement('span');
      span.className = 'type-badge type-badge--domain';
      span.title = 'Domain type — not editable via the graph builder';
      span.textContent = currentValue || '(unknown)';
      selectEl.replaceWith(span);
      return;
    }

    knownTypes.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = type;
      selectEl.appendChild(opt);
    });
    selectEl.value    = currentValue;
    selectEl.onchange = () => onChange(selectEl.value);
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────

  _buildControls() {
    const wrapper = this._graph.graphRoot.parentElement;
    if (!wrapper || this._controlsEl) return;
    wrapper.style.position = 'relative';
    this._controlsEl = document.createElement('div');
    this._controlsEl.style.cssText = 'position:absolute;top:8px;right:8px;z-index:10;display:flex;gap:6px;';
    [
      ['+ Series',  'event',   'Series'],
      ['+ One-Off', 'event',   'OneOff'],
      ['+ Handler', 'handler', null],
      ['+ Reducer', 'reducer', null],
    ].forEach(([label, kind, subtype]) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (this.onCreationRequested) this.onCreationRequested(kind, subtype);
      });
      this._controlsEl.appendChild(btn);
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Fit';
    btn.addEventListener('click', () => {
      this._graph.fitToView();
    });
    this._controlsEl.appendChild(btn);

    wrapper.appendChild(this._controlsEl);
  }

  // ── Template helpers ──────────────────────────────────────────────────────

  _getTemplate(templateId) {
    const tmpl = document.getElementById(templateId);
    return tmpl.content.firstElementChild.cloneNode(true);
  }

  _createDeleteButton(node) {
    const wrap = document.createElement('div');
    wrap.className = 'node-field';
    const btn = document.createElement('button');
    btn.className = 'btn btn-warn btn-sm';
    btn.textContent = '✕ Delete Node';
    btn.style.width = '100%';
    btn.addEventListener('click', () => {
      if (this.onDelete) this.onDelete(node);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // ── EVENT EDITOR ─────────────────────────────────────────────────────────

  _renderEventEditor(node) {
    const el         = this._getTemplate('tpl-event-editor');
    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

    const label = el.querySelector('[data-id="name"]');
    label.value = node.name || '';
    label.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'name', label.value);
    });

    this.EVENT_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = type;
      typeSelect.appendChild(opt);
    });
    typeSelect.value = node.eventType || 'Series';
    typeSelect.onchange = () => {
      if (this.onFieldChange) this.onFieldChange(node, 'eventType', typeSelect.value);
      // node.eventType is mutated synchronously by the service; re-render the
      // config sub-panel without touching the rest of the editor.
      this._renderEventConfig(node, configWrap);
    };

    const colorInput = el.querySelector('[data-field="color"]');
    colorInput.value = node.color || '#888888';
    colorInput.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'color', colorInput.value);
    });

    const enabledCb = el.querySelector('[data-field="enabled"]');
    enabledCb.checked = node.enabled || false;
    enabledCb.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'enabled', enabledCb.checked);
    });

    this._renderLinkableMultiSelect(node, 'handler',
        el.querySelector('#event-handler-count'),
        el.querySelector('#event-handlers'), false, EDGE_TYPES.HANDLED_BY);

    this._renderEventConfig(node, configWrap);
    this._canvas.appendChild(el);
    this._canvas.appendChild(this._createDeleteButton(node));
  }

  _renderEventConfig(node, container) {
    container.innerHTML = '';

    let wrap;
    switch (node.eventType) {
      case 'EventSeries': {
        wrap = this._getTemplate('tpl-event-series-editor');
        const seriesTypeSelect = wrap.querySelector('[data-field="interval"]');
        this.EVENT_SERIES_TYPES.forEach(type => {
          const opt = document.createElement('option');
          opt.value = type; opt.textContent = type;
          seriesTypeSelect.appendChild(opt);
        });
        seriesTypeSelect.value = node.interval || '';
        wrap.querySelector('[data-field="startOffset"]').value = node.startOffset ?? 0;
        break;
      }
      case 'OneOffEvent': {
        wrap = this._getTemplate('tpl-event-one-off-editor');
        wrap.querySelector('[data-field="date"]').valueAsDate = node.date || new Date();
        break;
      }
      default:
        container.innerHTML = '<div class="tl-empty">No config</div>';
        return;
    }

    wrap.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('input', () => {
        let value;
        if      (input.type === 'checkbox') value = input.checked;
        else if (input.type === 'date')     value = input.valueAsDate;
        else if (input.type === 'number')   value = parseInt(input.value, 10);
        else                                value = input.value;
        if (this.onFieldChange) this.onFieldChange(node, input.dataset.field, value);
      });
    });

    container.appendChild(wrap);
  }

  // ── HANDLER EDITOR ────────────────────────────────────────────────────────

  _renderHandlerEditor(node) {
    const el = this._getTemplate('tpl-handler-editor');

    el.querySelector('[data-id="description"]').innerText = node.getDescription();

    this._renderTypeSelect(
      el.querySelector('[data-id="handlerClass"]'),
      this.HANDLER_TYPES,
      node.handlerClass || 'HandlerEntry',
      newClass => { if (this.onHandlerClassChange) this.onHandlerClassChange(node.id, newClass); },
    );

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'name', name.value);
    });

    this._renderLinkableMultiSelect(node, 'event',
        el.querySelector('#handler-event-count'),
        el.querySelector('#handler-events'), true, EDGE_TYPES.HANDLED_BY);

    // Action Definitions — inline list with template picker
    const defContainer = el.querySelector('#handler-actions');
    if (defContainer) {
      defContainer.innerHTML = '';
      this._renderActionDefinitionList(node, defContainer);
      const countSpan = el.querySelector('#handler-action-count');
      if (countSpan) {
        const defCount  = (node.generatedActionDefinitions ?? []).length;
        const typeCount = this._undefinedActionTypeCount(node);
        countSpan.innerText = defCount + typeCount > 0
          ? `${defCount} defined, ${typeCount} declared`
          : '0 defined';
      }
    }

    this._canvas.appendChild(el);
    this._canvas.appendChild(this._createDeleteButton(node));
  }

  // ── ACTION EDITOR ─────────────────────────────────────────────────────────

  _renderActionEditor(node) {
    const el         = this._getTemplate('tpl-action-editor');
    const configWrap = el.querySelector('[data-id="config"]');

    el.querySelector('[data-id="description"]').innerText = node.getDescription();

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'name', name.value);
    });

    const actionClassSelect = el.querySelector('[data-id="actionClass"]');
    this.ACTION_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = type;
      actionClassSelect.appendChild(opt);
    });
    actionClassSelect.value = node.actionClass || 'AmountAction';
    actionClassSelect.onchange = () => {
      if (this.onActionClassChange) this.onActionClassChange(node.id, actionClassSelect.value);
    };

    const type = el.querySelector('[data-id="type"]');
    type.value = node.type || '';
    type.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'type', type.value);
    });

    this._renderActionConfig(node, configWrap, el);

    this._renderLinkableMultiSelect(node, 'handler',
        el.querySelector('#action-handler-count'),
        el.querySelector('#action-handlers'), true, EDGE_TYPES.GENERATES_ACTION);

    //TODO Reduced BY
    this._renderLinkableMultiSelect(node, 'reducer',
        el.querySelector('#action-reducer-count'),
        el.querySelector('#action-reducers'), false, EDGE_TYPES.REDUCES_ACTION);

    this._canvas.appendChild(el);
    this._canvas.appendChild(this._createDeleteButton(node));
  }

  _renderActionConfig(node, container, parent) {
    container.innerHTML = '';
    let wrap = null;

    switch (node.actionClass) {
      case 'AmountAction':
        wrap = this._getTemplate('tpl-amount-action-editor');
        wrap.querySelector('[data-field="value"]').value = node.value ?? 0;
        break;
      case 'Action':
        break;
      case 'FieldAction':
        wrap = this._getTemplate('tpl-field-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName;
        break;
      case 'FieldValueAction':
        wrap = this._getTemplate('tpl-field-value-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName;
        wrap.querySelector('[data-field="value"]').value     = node.value;
        break;
      case 'RecordBalanceAction':
        break;
      case 'ScriptedAction':
        wrap = this._getTemplate('tpl-scripted-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="script"]').value    = node.script    || '';
        wrap.querySelector('.script-validate-button').addEventListener('click', () => {
          const resultDiv = wrap.querySelector('.code-test-result');
          try {
            const scriptAction = new ScriptedAction(
              parent.querySelector('[data-id="type"]').value,
              parent.querySelector('[data-id="name"]').value,
              wrap.querySelector('[data-field="fieldName"]').value,
              wrap.querySelector('[data-field="script"]').value,
            );
            const state = {};
            const now = new Date();
            const sourceEvent = new OneOffEvent({
              id: 'id',
              name: 'event name',
              type: 'ONE_OFF_TYPE',
              enabled: true,
              date: now
            });
            const handlerContext = {
              event: sourceEvent,
              handlerIdx: 'h1',
              stateBefore: {}
            };
            const result = scriptAction.transform(state, { date: now, sourceEvent, handlerContext});
            resultDiv.innerText = JSON.stringify({ actionsReturned: result, action: scriptAction, handlerContext: handlerContext }, null, 2);
          } catch (e) {
            resultDiv.innerText = `Error: ${e.message}`;
          }
          resultDiv.style = '';
        });
        break;
      default:
        break;
    }

    if (wrap) {
      wrap.querySelectorAll('input, select, textarea').forEach(el => {
        el.addEventListener('input', () => {
          const field = el.dataset.field;
          const value = field === 'value'
            ? (el.value === '' ? null : parseFloat(el.value))
            : el.value;
          if (this.onFieldChange) this.onFieldChange(node, field, value);
        });
      });
      container.appendChild(wrap);
    }
  }

  // ── REDUCER EDITOR ────────────────────────────────────────────────────────

  _renderReducerEditor(node) {
    const el            = this._getTemplate('tpl-reducer-editor');
    const typeSelect    = el.querySelector('[data-id="type"]');
    const prioritySelect= el.querySelector('[data-id="priority"]');
    const configWrap    = el.querySelector('[data-id="config"]');

    el.querySelector('[data-id="description"]').innerText = node.getDescription();

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      if (this.onFieldChange) this.onFieldChange(node, 'name', name.value);
    });

    this._renderTypeSelect(
      typeSelect,
      this.REDUCER_TYPES,
      node.reducerType || 'NoOpReducer',
      newType => { if (this.onReducerTypeChange) this.onReducerTypeChange(node.id, newType); },
    );

    this.PRIORITY_OPTIONS.forEach(({ label, value }) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = `${label} (${value})`;
      prioritySelect.appendChild(opt);
    });
    prioritySelect.value = node.priority ?? PRIORITY.METRICS;
    prioritySelect.onchange = () => {
      if (this.onFieldChange) this.onFieldChange(node, 'priority', parseInt(prioritySelect.value, 10));
    };

    this._renderReducerConfig(node, configWrap, el);

    // Which action types trigger this reducer
    this._renderLinkableMultiSelect(node, 'action',
        el.querySelector('#reducer-reduced-actions-count'),
        el.querySelector('#reducer-reduced-actions'), true, EDGE_TYPES.REDUCES_ACTION);

    // Generated Action Definitions — inline list with template picker
    const genContainer = el.querySelector('#reducer-generated-actions');
    if (genContainer) {
      genContainer.innerHTML = '';
      this._renderActionDefinitionList(node, genContainer);
      const countSpan = el.querySelector('#reducer-generated-actions-count');
      if (countSpan) {
        const defCount  = (node.generatedActionDefinitions ?? []).length;
        const typeCount = this._undefinedActionTypeCount(node);
        countSpan.innerText = defCount + typeCount > 0
          ? `${defCount} defined, ${typeCount} declared`
          : '0 defined';
      }
    }

    this._canvas.appendChild(el);
    this._canvas.appendChild(this._createDeleteButton(node));
  }

  _renderReducerConfig(node, container, parent) {
    container.innerHTML = '';
    let wrap;

    switch (node.reducerType) {
      case 'NumericSumReducer':
      case 'ArrayReducer':
      case 'MultiplicativeReducer':
      case 'FieldValueReducer':
      case 'MetricReducer':
        wrap = this._getTemplate('tpl-field-value-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="value"]').value     = node.value ?? '';
        break;
      case 'AccountTransactionReducer':
        wrap = this._getTemplate('tpl-account-transaction-reducer-editor');
        wrap.querySelector('[data-field="accountKey"]').value = node.accountKey || '';
        break;
      case 'FieldReducer':
        wrap = this._getTemplate('tpl-field-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        break;
      case 'ScriptedReducer':
        wrap = this._getTemplate('tpl-scripted-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="script"]').value    = node.script    || '';
        wrap.querySelector('.script-validate-button').addEventListener('click', () => {
          const resultDiv = wrap.querySelector('.code-test-result');
          try {
            const scriptReducer = new ScriptedReducer(
              parent.querySelector('[data-id="name"]').value,
              parent.querySelector('[data-id="priority"]').value,
              wrap.querySelector('[data-field="fieldName"]').value,
              wrap.querySelector('[data-field="script"]').value,
            );
            const state = {};
            const action = new FieldValueAction('TEST', 'test action', 'testField', 10);
            const result = scriptReducer.reduce(state, action, new Date());
            resultDiv.innerText = JSON.stringify({ state, action, result }, null, 2);
          } catch (e) {
            resultDiv.innerText = `Error: ${e.message}`;
          }
          resultDiv.style = '';
        });
        break;
      case 'RepeatingReducer':
        // TODO Need UI
      default:
        container.innerHTML = '<div class="tl-empty">No config</div>';
        return;
    }

    wrap.querySelectorAll('input, textarea').forEach(el => {
      el.addEventListener('input', () => {
        const field = el.dataset.field;
        const value = field === 'value'
          ? (el.value === '' ? null : parseFloat(el.value))
          : el.value;
        if (this.onFieldChange) this.onFieldChange(node, field, value);
      });
    });

    container.appendChild(wrap);
  }

  // ── ACTION DEFINITION LIST ────────────────────────────────────────────────

  /**
   * Returns the set of action types in generatedActionTypes that have no
   * corresponding entry in generatedActionDefinitions (i.e. declared in code
   * but not configurable via the UI).
   */
  _declaredOnlyActionTypes(node) {
    const defs = node.generatedActionDefinitions ?? [];
    const defTypes = new Set(defs.map(d => d.type));
    return (node.generatedActionTypes ?? []).filter(t => !defTypes.has(t));
  }

  _undefinedActionTypeCount(node) {
    return this._declaredOnlyActionTypes(node).length;
  }

  /**
   * Render the full ActionDefinition list (existing rows + add form) into container.
   * Also renders read-only badges for generatedActionTypes that have no backing definition
   * (these come from imperative handlers/reducers with hard-coded logic).
   */
  _renderActionDefinitionList(node, container) {
    (node.generatedActionDefinitions ?? []).forEach(def => {
      container.appendChild(this._renderActionDefinitionItem(node, def));
    });

    const declaredOnly = this._declaredOnlyActionTypes(node);
    if (declaredOnly.length > 0) {
      container.appendChild(this._renderDeclaredTypeBadges(declaredOnly));
    }

    container.appendChild(this._renderAddActionDefinitionForm(node));
  }

  /**
   * Render a row of read-only type badges for action types that are declared in
   * handler/reducer code but have no ActionDefinition (not configurable via UI).
   */
  _renderDeclaredTypeBadges(types) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px;padding:6px;border:1px dashed var(--border,#ccc);border-radius:4px;';

    const label = document.createElement('span');
    label.textContent = 'Declared in code:';
    label.title = 'These action types are generated by handler/reducer logic and are not configurable here.';
    label.style.cssText = 'font-size:10px;color:var(--muted,#888);flex:0 0 auto;';
    wrap.appendChild(label);

    types.forEach(type => {
      const badge = document.createElement('span');
      badge.textContent = type;
      badge.title = 'Declared in handler/reducer code — not configurable via ActionDefinition';
      badge.style.cssText = 'font-size:11px;padding:2px 7px;border-radius:10px;background:var(--chip-bg,#e9ecef);color:var(--chip-text,#495057);';
      wrap.appendChild(badge);
    });

    return wrap;
  }

  /**
   * Render one ActionDefinition row: [class label] [type input] [config fields] [remove btn].
   */
  _renderActionDefinitionItem(node, def) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start;margin-bottom:6px;padding:6px;border:1px solid var(--border,#ccc);border-radius:4px;';

    // Class label (human-readable, from ACTION_TEMPLATES)
    const cls = def.config?.actionClass;
    const clsLabel = document.createElement('span');
    clsLabel.textContent = this._actionClassLabel(cls);
    clsLabel.style.cssText = 'font-size:10px;color:var(--muted,#888);align-self:center;flex:0 0 auto;min-width:90px;';
    row.appendChild(clsLabel);

    // Type discriminator input
    const typeInput = document.createElement('input');
    typeInput.type        = 'text';
    typeInput.className   = 'form-control form-control-sm';
    typeInput.placeholder = 'action type';
    typeInput.title       = 'Action type discriminator (e.g. SALARY_CREDIT)';
    typeInput.value       = def.type || '';
    typeInput.style.cssText = 'width:130px;flex:0 0 auto;';
    typeInput.addEventListener('input', () => {
      if (this.onActionDefinitionUpdate) this.onActionDefinitionUpdate(node, def.id, 'type', typeInput.value);
    });
    row.appendChild(typeInput);

    // Config fields (class-specific)
    this._actionDefinitionConfigFields(cls).forEach(({ field, placeholder, isTextarea }) => {
      const inp = isTextarea ? document.createElement('textarea') : document.createElement('input');
      if (!isTextarea) inp.type = 'text';
      inp.className   = 'form-control form-control-sm';
      inp.placeholder = placeholder;
      inp.value       = def.config[field] ?? '';
      inp.style.cssText = isTextarea
        ? 'width:100%;flex:1 1 100%;font-family:monospace;font-size:11px;'
        : 'flex:1 1 80px;min-width:60px;';
      if (isTextarea) inp.rows = 3;
      inp.addEventListener('input', () => {
        if (this.onActionDefinitionUpdate) this.onActionDefinitionUpdate(node, def.id, field, inp.value);
      });
      row.appendChild(inp);
    });

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className   = 'btn btn-warn btn-sm';
    removeBtn.textContent = '✕';
    removeBtn.title       = 'Remove this action definition';
    removeBtn.style.cssText = 'flex:0 0 auto;';
    removeBtn.addEventListener('click', () => {
      if (this.onActionDefinitionRemove) this.onActionDefinitionRemove(node, def.id);
    });
    row.appendChild(removeBtn);

    return row;
  }

  /** Resolve a human-readable label for an actionClass string. */
  _actionClassLabel(cls) {
    const tpl = ACTION_TEMPLATES.find(t => t.actionClass === cls);
    return tpl ? tpl.label : (cls || 'Action');
  }

  /**
   * Return editable field descriptors for an actionClass.
   * Each entry: { field, placeholder, isTextarea? }
   */
  _actionDefinitionConfigFields(cls) {
    switch (cls) {
      case 'RecordMetricAction':
        return [{ field: 'key',       placeholder: 'metric key'    },
                { field: 'value',     placeholder: 'value / $expr' }];
      case 'AmountAction':
        return [{ field: 'name',      placeholder: 'name (opt)'    },
                { field: 'value',     placeholder: 'amount / $expr' }];
      case 'FieldValueAction':
      case 'FieldAction':
        return [{ field: 'fieldName', placeholder: 'field name'    },
                { field: 'value',     placeholder: 'value / $expr' }];
      case 'ScriptedAction':
        return [{ field: 'fieldName', placeholder: 'field name'    },
                { field: 'script',    placeholder: '// script', isTextarea: true }];
      case 'RecordBalanceAction':
      case 'Action':
      default:
        return [];
    }
  }

  /**
   * Render the "add new ActionDefinition" form:
   * [template select] [type input] [+ Add button]
   */
  _renderAddActionDefinitionForm(node) {
    const form = document.createElement('div');
    form.style.cssText = 'display:flex;gap:4px;align-items:center;margin-top:4px;';

    const select = document.createElement('select');
    select.className    = 'form-select form-select-sm';
    select.style.cssText = 'flex:1 1 auto;';
    ACTION_TEMPLATES.forEach(tpl => {
      const opt = document.createElement('option');
      opt.value       = tpl.id;
      opt.textContent = tpl.label;
      select.appendChild(opt);
    });

    const typeInput = document.createElement('input');
    typeInput.type        = 'text';
    typeInput.className   = 'form-control form-control-sm';
    typeInput.placeholder = 'action type';
    typeInput.style.cssText = 'flex:1 1 110px;';

    const addBtn = document.createElement('button');
    addBtn.className   = 'btn btn-sm';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      const tpl = ACTION_TEMPLATES.find(t => t.id === select.value);
      if (!tpl || !typeInput.value.trim()) return;
      const defData = {
        type:   typeInput.value.trim().toUpperCase().replace(/\s+/g, '_'),
        config: { actionClass: tpl.actionClass, ...tpl.defaultConfig },
      };
      if (this.onActionDefinitionAdd) this.onActionDefinitionAdd(node, defData);
      typeInput.value = '';
    });

    form.appendChild(select);
    form.appendChild(typeInput);
    form.appendChild(addBtn);
    return form;
  }

  //── MULTI SELECT HELPER ───────────────────────────────────────────────────────────
  _renderLinkableMultiSelect(node, kind, countSpan, container, linkTo, edgeType) {
    const myChildren = linkTo
        ? this._graph._graphQueryApi.getRelated(node.id, {
          edgeType: edgeType,
          direction: 'in',
          where: (n) => n.kind === kind
        })
        : this._graph._graphQueryApi.getRelated(node.id, node.id, {
          edgeType: edgeType,
          direction: 'out',
          where: (n) => n.kind === kind
        });

    new GraphNodeFilterMultiSelect({
      parent: this,
      container,
      countEl: countSpan,
      selectedItems: myChildren,
      onToggle: (selectedItem, toggleOn) => {
        if (this.onLinkToggle) {
          this.onLinkToggle(node, selectedItem, kind, linkTo, toggleOn);
        }
      },
      graphQueryApi: this._graph._graphQueryApi,
      defaultCondition: `kind=${kind}`
    });
  }
}
