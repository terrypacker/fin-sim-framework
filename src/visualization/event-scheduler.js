/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { ServiceRegistry } from '../services/service-registry.js';
import { PRIORITY } from '../simulation-framework/reducers.js';

export class EventScheduler {

  constructor({ graph, builderCanvas }) {
    this.graph = graph;
    this.builderCanvas = builderCanvas;
    this.graph.registerNodeClickListener((event, node) => this._editNode(event, node));

    // Creation listener arrays (still used — BaseScenario registers here)
    this.eventNodeCreatedListeners = [];
    this.handlerNodeCreatedListeners = [];
    this.actionNodeCreatedListeners = [];
    this.reducerNodeCreatedListeners = [];

    this.EVENT_TYPES = ['Series', 'OneOff'];

    this.EVENT_SERIES_TYPES = [
      'monthly', 'quarterly', 'annually', 'month-end', 'year-end'
    ];

    this.PRIORITY_OPTIONS = [
      { label: 'Pre-Process',      value: PRIORITY.PRE_PROCESS },
      { label: 'Cash Flow',        value: PRIORITY.CASH_FLOW },
      { label: 'Position Update',  value: PRIORITY.POSITION_UPDATE },
      { label: 'Cost Basis',       value: PRIORITY.COST_BASIS },
      { label: 'Tax Calc',         value: PRIORITY.TAX_CALC },
      { label: 'Tax Apply',        value: PRIORITY.TAX_APPLY },
      { label: 'Metrics',          value: PRIORITY.METRICS },
      { label: 'Logging',          value: PRIORITY.LOGGING },
    ];

    this.REDUCER_TYPES = [
      'ArrayReducer', 'NumericSumReducer',
      'MultiplicativeReducer', 'AccountTransactionReducer',
      'FieldReducer', 'ScriptedReducer', 'NoOpReducer', 'RepeatingReducer'
    ];

    // Ordered most-specific to least-specific for instanceof checks.
    this.ACTION_TYPES = [
      'AmountAction', 'RecordBalanceAction', 'ScriptedAction',
      'FieldValueAction', 'FieldAction', 'Action'
    ];

    // Subscribe to service bus.
    // CREATE — add the new node to the graph (mirrors what BaseScenario does
    //          for the simulation side of the same event).
    // Any mutation — re-render the graph so labels / edges stay in sync.
    ServiceRegistry.getInstance().bus.subscribe('SERVICE_ACTION', (msg) => {
      const { actionType, classType, item } = msg;
      if (actionType === 'CREATE') {
        if (classType === 'EventSeries' || classType === 'OneOffEvent') {
          this.addEvent(item);
        } else if (classType === 'HandlerEntry') {
          this.addHandler(item);
        } else if (this._isActionClass(classType)) {
          this.addAction(item);
        } else if (this._isReducerClass(classType)) {
          this.addReducer(item);
        }
      }
      this.graph.render();
    });

    this._bind();
  }

  _bind() {
    this._buildControls();
  }

  _buildControls() {
    const wrapper = this.graph.graphRoot.parentElement;
    if (!wrapper || this._controlsEl) return;
    wrapper.style.position = 'relative';
    this._controlsEl = document.createElement('div');
    this._controlsEl.style.cssText = 'position:absolute;top:8px;right:8px;z-index:10;display:flex;gap:6px;';
    [
      ['+ Series',  'event',   'Series'],
      ['+ One-Off', 'event',   'OneOff'],
      ['+ Handler', 'handler', null],
      ['+ Action',  'action',  null],
      ['+ Reducer', 'reducer', null],
    ].forEach(([label, kind, subtype]) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = label;
      btn.addEventListener('click', () => this._notifyNodeCreationRequested(kind, subtype));
      this._controlsEl.appendChild(btn);
    });
    wrapper.appendChild(this._controlsEl);
  }

  _notifyNodeCreationRequested(kind, subtype) {
    if (kind === 'event') {
      this.eventNodeCreatedListeners.forEach(l => l(subtype));
    } else if (kind === 'handler') {
      this.handlerNodeCreatedListeners.forEach(l => l());
    } else if (kind === 'action') {
      this.actionNodeCreatedListeners.forEach(l => l());
    } else if (kind === 'reducer') {
      this.reducerNodeCreatedListeners.forEach(l => l());
    }
  }

  editNode(node) { this._editNode(null, node); }

  _isActionClass(classType) {
    return ['AmountAction', 'RecordBalanceAction', 'ScriptedAction',
      'FieldValueAction', 'FieldAction', 'Action'].includes(classType);
  }

  _isReducerClass(classType) {
    return ['ArrayReducer', 'NumericSumReducer',
            'MultiplicativeReducer', 'NoOpReducer', 'FieldReducer', 'FieldValueReducer',
            'AccountTransactionReducer', 'ScriptedReducer', 'RepeatingReducer'].includes(classType);
  }

  registerEventCreatedListener(listener)   { this.eventNodeCreatedListeners.push(listener); }
  registerHandlerCreatedListener(listener) { this.handlerNodeCreatedListeners.push(listener); }
  registerActionCreatedListener(listener)  { this.actionNodeCreatedListeners.push(listener); }
  registerReducerCreatedListener(listener) { this.reducerNodeCreatedListeners.push(listener); }

  // ─── Deletion ─────────────────────────────────────────────────────────────

  _createDeleteButton(node) {
    const wrap = document.createElement('div');
    wrap.className = 'node-field';
    const btn = document.createElement('button');
    btn.className = 'btn btn-warn btn-sm';
    btn.textContent = '✕ Delete Node';
    btn.style.width = '100%';
    btn.addEventListener('click', () => this.deleteNode(node));
    wrap.appendChild(btn);
    return wrap;
  }

  deleteNode(node) {
    // Call the appropriate service: fires DELETE on bus → BaseScenario
    // subscriber cleans up the sim.  Graph removal follows synchronously.
    const { eventService, handlerService, actionService, reducerService } = ServiceRegistry.getInstance();
    if (node.kind === 'event')        eventService.deleteEvent(node.id);
    else if (node.kind === 'handler') handlerService.deleteHandler(node.id);
    else if (node.kind === 'action')  actionService.deleteAction(node.id);
    else if (node.kind === 'reducer') reducerService.deleteReducer(node.id);

    this.graph.removeNode(node.id);
    this._editNode(null, null);
  }

  // ─── Change notification (chip toggles use in-place mutation then this) ───

  /**
   * Called after a chip toggle mutates a canonical array (handledEvents,
   * generatedActions, reducedActions) in-place.  Triggers the service update
   * so the bus fires and BaseScenario re-wires the sim.
   *
   * NOTE: Because the mutation has already happened before this call the
   * originalItem in the ServiceActionEvent captures the post-mutation state.
   * Scalar property changes go through service.updateX(id, changes) directly
   * and do NOT have this limitation.
   * @private
   */
  _nodeChanged(node) {
    const { eventService, handlerService, actionService, reducerService } = ServiceRegistry.getInstance();
    if (node.kind === 'event')        eventService.updateEvent(node.id, {});
    else if (node.kind === 'handler') handlerService.updateHandler(node.id, {});
    else if (node.kind === 'action')  actionService.updateAction(node.id, {});
    else if (node.kind === 'reducer') reducerService.updateReducer(node.id, {});
    // graph.render() is triggered by the bus subscription in the constructor
  }

  // ─── Template helpers ─────────────────────────────────────────────────────

  _getTemplate(templateId) {
    const tmpl = document.getElementById(templateId);
    return tmpl.content.cloneNode(true);
  }

  _editNode(event, node) {
    this.builderCanvas.innerHTML = '';

    if (!node) {
      const tpl = document.getElementById('tpl-empty');
      this.builderCanvas.appendChild(tpl.content.cloneNode(true));
      return;
    }

    if (node.kind === 'reducer') {
      this._renderReducerEditor(node);
    } else if (node.kind === 'event') {
      this._renderEventEditor(node);
    } else if (node.kind === 'handler') {
      this._renderHandlerEditor(node);
    } else if (node.kind === 'action') {
      this._renderActionEditor(node);
    } else {
      this.builderCanvas.innerHTML = `<div class="tl-empty">${node.kind} editor coming next</div>`;
    }
  }

  // ─── Graph management ──────────────────────────────────────────────────────

  /**
   * Add an event node to the graph.  Also loads the event into the service map
   * if it was created outside the service.  Idempotent — silently skips if the
   * node is already present (the bus may fire before an explicit call).
   */
  addEvent(event) {
    const existing = this.graph.getNode(event.id);
    if (existing) return;

    // Ensure the item is in the service map for editor update calls
    const { eventService } = ServiceRegistry.getInstance();
    if (!eventService.get(event.id)) {
      eventService.load(event);
    }

    event.kind = 'event';
    if (event instanceof FinSimLib.Core.EventSeries) {
      event.eventType = 'Series';
    } else {
      event.eventType = 'OneOff';
    }
    this.graph.addNode(event);
  }

  addHandler(handler) {
    this.graph.addNode(handler);

    handler.handledEvents.forEach(e => {
      this.graph.addEdge({ from: e.id, to: handler.id });
    });
    handler.generatedActions.forEach(a => {
      this.addAction(a);
      this.graph.addEdge({ from: handler.id, to: a.id });
    });
  }

  addReducer(reducer) {
    this.graph.addNode(reducer);

    reducer.reducedActions.forEach(a => {
      this.addAction(a);
      this.graph.addEdge({ from: a.id, to: reducer.id });
    });
    reducer.generatedActions.forEach(a => {
      this.addAction(a);
      this.graph.addEdge({ from: reducer.id, to: a.id });
    });
  }

  addAction(action) {
    const existing = this.graph.getNode(action.id);
    if (existing === undefined) {
      // Ensure the item is in the service map
      const { actionService } = ServiceRegistry.getInstance();
      if (!actionService.get(action.id)) {
        actionService.load(action);
      }

      this.graph.addNode(action);
    }
  }

  /* ─────────────────────────────  EVENT EDITOR  ───────────────────────────── */
  _renderEventEditor(node) {
    const el = this._getTemplate('tpl-event-editor');
    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

    const label = el.querySelector('[data-id="name"]');
    label.value = node.name || '';
    label.addEventListener('input', () => {
      ServiceRegistry.getInstance().eventService.updateEvent(node.id, { name: label.value });
    });

    this.EVENT_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      typeSelect.appendChild(opt);
    });

    typeSelect.value = node.eventType || 'Series';
    typeSelect.onchange = () => {
      // eventType is UI decoration; update via service so bus fires and sim re-wires
      ServiceRegistry.getInstance().eventService.updateEvent(node.id, { eventType: typeSelect.value });
      this._renderEventConfig(node, configWrap);
    };

    const colorInput = el.querySelector('[data-field="color"]');
    colorInput.value = node.color || '#888888';
    colorInput.addEventListener('input', () => {
      ServiceRegistry.getInstance().eventService.updateEvent(node.id, { color: colorInput.value });
    });

    const seriesEnabled = el.querySelector('[data-field="enabled"]');
    seriesEnabled.checked = node.enabled || false;
    seriesEnabled.addEventListener('input', () => {
      ServiceRegistry.getInstance().eventService.updateEvent(node.id, { enabled: seriesEnabled.checked });
    });

    const eventHandlerCount = el.querySelector('#event-handler-count');
    const eventHandlersGrid = el.querySelector('#event-handlers');
    this._renderLinkableNodeChips(node, 'handler', eventHandlerCount, eventHandlersGrid, true);

    this._renderEventConfig(node, configWrap);
    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }

  /* ───────────────── EVENT CONFIG EDITOR ─────────────────── */
  _renderEventConfig(node, container) {
    container.innerHTML = '';

    let wrap;
    switch (node.eventType) {
      case 'Series':
        wrap = this._getTemplate('tpl-event-series-editor');
        const seriesTypeSelect = wrap.querySelector('[data-field="interval"]');
        this.EVENT_SERIES_TYPES.forEach(type => {
          const opt = document.createElement('option');
          opt.value = type;
          opt.textContent = type;
          seriesTypeSelect.appendChild(opt);
        });
        seriesTypeSelect.value = node.interval || '';
        const startOffsetInput = wrap.querySelector('[data-field="startOffset"]');
        startOffsetInput.value = node.startOffset ?? 0;
        break;
      case 'OneOff':
        wrap = this._getTemplate('tpl-event-one-off-editor');
        const dateInput = wrap.querySelector('[data-field="date"]');
        dateInput.valueAsDate = node.date || new Date();
        break;
      default:
        container.innerHTML = '<div class="tl-empty">No config</div>';
        return;
    }

    // Bind config inputs → service (fixes the mutation-before-snapshot bug for
    // event config fields that previously mutated node directly without notifying)
    wrap.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('input', () => {
        let value;
        if (input.type === 'checkbox') {
          value = input.checked;
        } else if (input.type === 'date') {
          value = input.valueAsDate;
        } else if (input.type === 'number') {
          value = parseInt(input.value, 10);
        } else {
          value = input.value;
        }
        ServiceRegistry.getInstance().eventService.updateEvent(node.id, { [input.dataset.field]: value });
      });
    });

    container.appendChild(wrap);
  }

  /* ─────────────────────────────  HANDLER EDITOR  ───────────────────────────── */
  _renderHandlerEditor(node) {
    const el = this._getTemplate('tpl-handler-editor');

    const description = el.querySelector('[data-id="description"]');
    description.innerText = node.getDescription();

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      // Previously mutated node.name without notifying — now goes via service
      ServiceRegistry.getInstance().handlerService.updateHandler(node.id, { name: name.value });
    });

    const handlerEventCount = el.querySelector('#handler-event-count');
    const handlerEventGrid = el.querySelector('#handler-events');
    this._renderLinkableNodeChips(node, 'event', handlerEventCount, handlerEventGrid, false);

    const handlerActionCount = el.querySelector('#handler-action-count');
    const handlerActionGrid = el.querySelector('#handler-actions');
    this._renderLinkableNodeChips(node, 'action', handlerActionCount, handlerActionGrid, true);

    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }

  /* ─────────────────────────────  ACTION EDITOR  ───────────────────────────── */
  _renderActionEditor(node) {
    const el = this._getTemplate('tpl-action-editor');

    const description = el.querySelector('[data-id="description"]');
    description.innerText = node.getDescription();

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      ServiceRegistry.getInstance().actionService.updateAction(node.id,
          {name: name.value});
    });

    const actionClassSelect = el.querySelector('[data-id="actionClass"]');
    const configWrap = el.querySelector('[data-id="config"]');

    this.ACTION_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      actionClassSelect.appendChild(opt);
    });

    actionClassSelect.value = node.actionClass || 'AmountAction';
    actionClassSelect.onchange = () => {
      // Replace the instance so constructor, getDescription(), and any
      // class-specific behaviour reflect the new class immediately.
      const updated = ServiceRegistry.getInstance().actionService
          .replaceAction(node.id, actionClassSelect.value);
      this._editNode(null, updated);
    };

    const type = el.querySelector('[data-id="type"]');
    type.value = node.type || '';
    type.addEventListener('input', () => {
      ServiceRegistry.getInstance().actionService.updateAction(node.id,
          {type: type.value});
    });

    this._renderActionConfig(node, configWrap);

    const actionHandlerCount = el.querySelector('#action-handler-count');
    const actionHandlerGrid = el.querySelector('#action-handlers');
    this._renderLinkableNodeChips(node, 'handler', actionHandlerCount,
        actionHandlerGrid, false);

    const actionReducerCount = el.querySelector('#action-reducer-count');
    const actionReducerGrid = el.querySelector('#action-reducers');
    this._renderLinkableNodeChips(node, 'reducer', actionReducerCount,
        actionReducerGrid, true);

    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }

  /* ───────────────────── ACTION CONFIG EDITOR ─────────────────────── */
  _renderActionConfig(node, container) {
    container.innerHTML = '';

    const displayField = (fn) => fn?.startsWith('metrics.') ? fn.slice(8) : (fn ?? '');

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
        wrap.querySelector('[data-field="fieldName"]').value = displayField(node.fieldName);
        break;
      case 'FieldValueAction':
        wrap = this._getTemplate('tpl-field-value-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = displayField(node.fieldName);
        wrap.querySelector('[data-field="value"]').value     = node.value ?? 0;
        break;
      case 'RecordBalanceAction':
      default:
        break;
      case 'ScriptedAction':
        wrap = this._getTemplate('tpl-scripted-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="script"]').value    = node.script || '';
        break;
    }

    if (wrap) {
      const isScripted = node.actionClass === 'ScriptedAction';
      wrap.querySelectorAll('input, select, textarea').forEach(input => {
        input.addEventListener('input', () => {
          const field = input.dataset.field;
          let value;
          if (input.type === 'number') {
            value = parseFloat(input.value) || 0;
          } else if (field === 'fieldName' && !isScripted) {
            // Metric actions store fieldName with 'metrics.' prefix
            const stripped = input.value.startsWith('metrics.') ? input.value.slice(8) : input.value;
            value = 'metrics.' + stripped;
          } else {
            value = input.value;
          }
          ServiceRegistry.getInstance().actionService.updateAction(node.id, { [field]: value });
        });
      });
      container.appendChild(wrap);
    }
  }

  /* ───────────────────────────── REDUCER EDITOR ───────────────────────────── */
  _renderReducerEditor(node) {
    const el = this._getTemplate('tpl-reducer-editor');

    const description = el.querySelector('[data-id="description"]');
    description.innerText = node.getDescription();

    const typeSelect     = el.querySelector('[data-id="type"]');
    const prioritySelect = el.querySelector('[data-id="priority"]');
    const configWrap     = el.querySelector('[data-id="config"]');

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      // Previously mutated node.name without notifying — now goes via service
      ServiceRegistry.getInstance().reducerService.updateReducer(node.id, { name: name.value });
    });

    this.REDUCER_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      typeSelect.appendChild(opt);
    });

    typeSelect.value = node.reducerType || 'MetricReducer';
    typeSelect.onchange = () => {
      // Replace the instance so constructor, reduce(), and getDescription() all
      // reflect the new type — mutating reducerType alone would leave them stale.
      const updated = ServiceRegistry.getInstance().reducerService
          .replaceReducer(node.id, typeSelect.value);
      // Re-render the full editor panel pointing at the new instance
      this._editNode(null, updated);
    };

    this.PRIORITY_OPTIONS.forEach(({ label, value }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = `${label} (${value})`;
      prioritySelect.appendChild(opt);
    });
    prioritySelect.value = node.priority ?? PRIORITY.METRICS;
    prioritySelect.onchange = () => {
      ServiceRegistry.getInstance().reducerService
          .updateReducer(node.id, { priority: parseInt(prioritySelect.value, 10) });
    };

    this._renderReducerConfig(node, configWrap);

    const reducerReducedActionCount = el.querySelector('#reducer-reduced-actions-count');
    const reducerReducedActions = el.querySelector('#reducer-reduced-actions');
    this._renderLinkableNodeChips(node, 'action', reducerReducedActionCount, reducerReducedActions, false);

    const reducerGeneratedActionsCount = el.querySelector('#reducer-generated-actions-count');
    const reducerGeneratedActions = el.querySelector('#reducer-generated-actions');
    this._renderLinkableNodeChips(node, 'action', reducerGeneratedActionsCount, reducerGeneratedActions, true);

    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }

  /* ───────────────────── REDUCER CONFIG EDITOR ─────────────────────── */
  _renderReducerConfig(node, container) {
    container.innerHTML = '';

    let wrap;
    switch (node.reducerType) {
      case 'NumericSumReducer':
      case 'ArrayReducer':
      case 'MultiplicativeReducer':
        wrap = this._getTemplate('tpl-field-value-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="value"]').value     = node.value ?? '';
        break;
      case 'AccountTransactionReducer':
        wrap = this._getTemplate('tpl-account-transaction-reducer-editor');
        wrap.querySelector('[data-field="accountKey"]').value = node.accountKey || '';
        break;
      case 'StateFieldReducer':
      case 'FieldReducer':
        wrap = this._getTemplate('tpl-state-field-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        break;
      case 'ScriptedReducer':
        wrap = this._getTemplate('tpl-scripted-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="script"]').value    = node.script || '';
        break;
      default:
        container.innerHTML = '<div class="tl-empty">No config</div>';
        return;
    }

    // Wire inputs and textareas — both fire on 'input' events
    wrap.querySelectorAll('input, textarea').forEach(el => {
      el.addEventListener('input', () => {
        let value;
        if (el.dataset.field === 'value') {
          // Empty string → null so the reducer ignores the field and reads from state
          value = el.value === '' ? null : parseFloat(el.value);
        } else {
          value = el.value;
        }
        ServiceRegistry.getInstance().reducerService.updateReducer(node.id, { [el.dataset.field]: value });
      });
    });

    container.appendChild(wrap);
  }

  /* ───────────────────────────── CHIPS HELPER ───────────────────────────── */
  _renderLinkableNodeChips(node, kind, countSpan, chipGrid, linkTo) {
    let myChildren;
    if (linkTo) {
      myChildren = this.graph.getNodesToKindFromMe(node, kind);
    } else {
      myChildren = this.graph.getNodesFromKindToMe(node, kind);
    }

    countSpan.innerText = `${myChildren.length} selected`;

    const allAvailable = this.graph.getKind(kind);
    allAvailable.forEach(available => {
      const nodeDiv = document.createElement('div');
      nodeDiv.classList.add('reducer-chip');
      nodeDiv.dataset.nodeId = available.id;
      if (myChildren.some(r => r.id === available.id)) {
        nodeDiv.classList.add('reducer-chip-on');
      }
      const nameSpan = document.createElement('span');
      nameSpan.classList.add('reducer-chip-name');
      nameSpan.innerText = available.name;
      nameSpan.title = available.name;
      nodeDiv.appendChild(nameSpan);
      const checkSpan = document.createElement('span');
      checkSpan.classList.add('reducer-chip-check');
      checkSpan.innerHTML = '&#x2713';
      chipGrid.appendChild(nodeDiv);
    });

    chipGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.reducer-chip[data-node-id]');
      if (!chip) return;
      const chipNode = this.graph.getNode(chip.dataset.nodeId);
      const index = myChildren.findIndex(n => n.id === chipNode.id);
      if (index < 0) {
        myChildren.push(chipNode);
        if (linkTo) {
          this.graph.addEdge({ from: node.id, to: chipNode.id });
        } else {
          this.graph.addEdge({ from: chipNode.id, to: node.id });
        }
        chip.classList.toggle('reducer-chip-on', true);
        this._syncCanonicalArrays(node, chipNode, kind, linkTo, 'add');
      } else {
        myChildren.splice(index, 1);
        if (linkTo) {
          this.graph.removeEdge({ from: node.id, to: chipNode.id });
        } else {
          this.graph.removeEdge({ from: chipNode.id, to: node.id });
        }
        chip.classList.toggle('reducer-chip-on', false);
        this._syncCanonicalArrays(node, chipNode, kind, linkTo, 'remove');
      }
      countSpan.innerText = `${myChildren.length} selected`;
    });
  }

  /**
   * After a chip toggle, update the canonical array on the domain object and
   * notify via _nodeChanged (which calls service.updateX(id, {})) so the bus
   * fires and BaseScenario re-wires the sim.
   *
   * NOTE: The arrays are mutated in-place before the service call, so
   * originalItem in the ServiceActionEvent captures the post-mutation state
   * for relationship changes.  Scalar property changes go through
   * service.updateX(id, changes) directly and do not have this limitation.
   */
  _syncCanonicalArrays(node, chipNode, kind, linkTo, op) {
    const add = op === 'add';

    const syncArr = (arr, item) => {
      if (add) {
        if (!arr.some(n => n.id === item.id)) arr.push(item);
      } else {
        const i = arr.findIndex(n => n.id === item.id);
        if (i !== -1) arr.splice(i, 1);
      }
    };

    if (node.kind === 'handler' && kind === 'event' && !linkTo) {
      syncArr(node.handledEvents, chipNode);
      this._nodeChanged(node);
      return;
    }
    if (node.kind === 'handler' && kind === 'action' && linkTo) {
      syncArr(node.generatedActions, chipNode);
      this._nodeChanged(node);
      return;
    }
    if (node.kind === 'reducer' && kind === 'action' && !linkTo) {
      syncArr(node.reducedActions, chipNode);
      this._nodeChanged(node);
      return;
    }
    if (node.kind === 'reducer' && kind === 'action' && linkTo) {
      syncArr(node.generatedActions, chipNode);
      this._nodeChanged(node);
      return;
    }

    if (node.kind === 'event' && kind === 'handler' && linkTo) {
      syncArr(chipNode.handledEvents, node);
      this._nodeChanged(chipNode);
      return;
    }
    if (node.kind === 'action' && kind === 'handler' && !linkTo) {
      syncArr(chipNode.generatedActions, node);
      this._nodeChanged(chipNode);
      return;
    }
    if (node.kind === 'action' && kind === 'reducer' && linkTo) {
      syncArr(chipNode.reducedActions, node);
      this._nodeChanged(chipNode);
      return;
    }
  }
}
