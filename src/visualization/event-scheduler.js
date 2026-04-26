/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
export class EventScheduler {

  constructor({ graph , builderCanvas}) {
    this.graph = graph;
    this.builderCanvas = builderCanvas;
    this.graph.registerNodeClickListener((event, node) => this._editNode(event, node));
    this.eventNodeChangeListeners = [];
    this.handlerNodeChangeListeners = [];
    this.actionNodeChangeListeners = [];
    this.reducerNodeChangeListeners = [];

    this.eventNodeCreatedListeners = [];
    this.handlerNodeCreatedListeners = [];
    this.actionNodeCreatedListeners = [];
    this.reducerNodeCreatedListeners = [];

    this.eventNodeDeletedListeners = [];
    this.handlerNodeDeletedListeners = [];
    this.actionNodeDeletedListeners = [];
    this.reducerNodeDeletedListeners = [];

    this.EVENT_TYPES = [
      'Series',
      'OneOff'
    ];

    this.EVENT_SERIES_TYPES = [
      'monthly',
      'quarterly',
      'annually',
      'month-end',
      'year-end'
    ];
    this.REDUCER_TYPES = [
      'MetricReducer',
      'ArrayMetricReducer',
      'NumericSumMetricReducer',
      'MultiplicativeMetricReducer',
      'AccountTransactionReducer',
      'StateFieldReducer',
      'NoOpReducer'
    ];

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

  registerEventCreatedListener(listener)   { this.eventNodeCreatedListeners.push(listener); }
  registerHandlerCreatedListener(listener) { this.handlerNodeCreatedListeners.push(listener); }
  registerActionCreatedListener(listener)  { this.actionNodeCreatedListeners.push(listener); }
  registerReducerCreatedListener(listener) { this.reducerNodeCreatedListeners.push(listener); }

  registerEventDeletedListener(listener)   { this.eventNodeDeletedListeners.push(listener); }
  registerHandlerDeletedListener(listener) { this.handlerNodeDeletedListeners.push(listener); }
  registerActionDeletedListener(listener)  { this.actionNodeDeletedListeners.push(listener); }
  registerReducerDeletedListener(listener) { this.reducerNodeDeletedListeners.push(listener); }

  _notifyNodeDeleted(node) {
    if (node.kind === 'event') {
      this.eventNodeDeletedListeners.forEach(l => l(node));
    } else if (node.kind === 'handler') {
      this.handlerNodeDeletedListeners.forEach(l => l(node));
    } else if (node.kind === 'action') {
      this.actionNodeDeletedListeners.forEach(l => l(node));
    } else if (node.kind === 'reducer') {
      this.reducerNodeDeletedListeners.forEach(l => l(node));
    }
  }

  deleteNode(node) {
    this._notifyNodeDeleted(node);
    this.graph.removeNode(node.id);
    this._editNode(null, null);
  }

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
    }else if (node.kind === 'handler') {
      this._renderHandlerEditor(node);
    }else if (node.kind === 'action') {
      this._renderActionEditor(node);
    }else {
      this.builderCanvas.innerHTML = `<div class="tl-empty">${node.kind} editor coming next</div>`;
    }
  }

  /**
   * Add an event to the graph
   * @param event
   */
  addEvent(event) {
    const existing = this.graph.getNode(event.id);
    if(existing) {
      throw new Error(`Event already exists in graph ${event.type}`);
    }
    event.kind = 'event';
    if(event instanceof FinSimLib.Core.EventSeries) {
      event.eventType = 'Series';
    }else {
      event.eventType = 'OneOff';
    }
    this.graph.addNode(event);
  }

  /**
   * Add a handler to an event
   * @param event
   * @param handler
   */
  addHandler(handler) {
    //Decorate the handler
    handler.kind = 'handler';
    this.graph.addNode(handler);

    handler.handledEvents.forEach(e => {
      //Add an edge from event --> handler
      this.graph.addEdge({from: e.id, to: handler.id});
    })
    //Add the actions
    handler.generatedActions.forEach(a => {
      this.addAction(a)
      this.graph.addEdge({from: handler.id, to: a.id});
    })
  }

  addReducer(reducer) {
    //Decorate the reducer
    reducer.kind = 'reducer';
    // Resolve the most-specific subclass first so that e.g. NumericSumMetricReducer
    // (which extends MetricReducer) is not incorrectly tagged as 'MetricReducer'.
    const C = FinSimLib.Core;
    if      (reducer instanceof C.NumericSumMetricReducer)      reducer.reducerType = 'NumericSumMetricReducer';
    else if (reducer instanceof C.ArrayMetricReducer)            reducer.reducerType = 'ArrayMetricReducer';
    else if (reducer instanceof C.MultiplicativeMetricReducer)   reducer.reducerType = 'MultiplicativeMetricReducer';
    else if (reducer instanceof C.MetricReducer)                 reducer.reducerType = 'MetricReducer';
    else if (reducer instanceof C.NoOpReducer)                   reducer.reducerType = 'NoOpReducer';
    else if (reducer instanceof C.AccountTransactionReducer)     reducer.reducerType = 'AccountTransactionReducer';
    else if (reducer instanceof C.StateFieldReducer)             reducer.reducerType = 'StateFieldReducer';
    this.graph.addNode(reducer);

    //Add the actions
    reducer.reducedActions.forEach(a => {
      this.addAction(a);
      this.graph.addEdge({from: a.id, to: reducer.id});
    })
    reducer.generatedActions.forEach(a => {
      this.addAction(a);
      this.graph.addEdge({from: reducer.id, to: a.id});
    })
  }

  addAction(action) {
    //Does this action exist
    action.id = action.type;
    const existing = this.graph.getNode(action.id);
    if(existing === undefined) {
      //Decorate the action
      action.kind = 'action';
      this.graph.addNode(action);
    }
  }

  registerEventChangeListener(listener) {
    this.eventNodeChangeListeners.push(listener);
  }

  registerHandlerChangeListener(listener) {
    this.handlerNodeChangeListeners.push(listener);
  }

  registerActionChangeListener(listener) {
    this.actionNodeChangeListeners.push(listener);
  }

  registerReducerChangeListener(listener) {
    this.reducerNodeChangeListeners.push(listener);
  }

  _nodeChanged(node) {
    if (node.kind === 'reducer') {
      this.reducerNodeChangeListeners.forEach(l => l(node));
    } else if (node.kind === 'event') {
      this.eventNodeChangeListeners.forEach(l => l(node));
    }else if (node.kind === 'handler') {
      this.handlerNodeChangeListeners.forEach(l => l(node));
    }else if (node.kind === 'action') {
      this.actionNodeChangeListeners.forEach(l => l(node));
    }else {
      throw new Error(`Unsupported node kind: ${node.kind}`)
    }

    this.graph.render();
  }

  /* ─────────────────────────────  EVENT EDITOR  ───────────────────────────── */
  _renderEventEditor(node) {
    const el = this._getTemplate('tpl-event-editor');
    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

    const label = el.querySelector('[data-id="name"]');
    label.value = node.name || '';
    label.addEventListener('input', () => {
      node.name = label.value;
      this._nodeChanged(node);
    });

    // populate dropdown
    this.EVENT_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      typeSelect.appendChild(opt);
    });

    typeSelect.value = node.eventType || 'Series';
    typeSelect.onchange = () => {
      node.eventType = typeSelect.value;
      this._renderEventConfig(node, configWrap);
      this._nodeChanged(node);
    };

    const colorInput = el.querySelector('[data-field="color"]');
    colorInput.value = node.color || '#888888';
    colorInput.addEventListener('input', () => {
      node.color = colorInput.value;
      this._nodeChanged(node);
    });

    const seriesEnabled = el.querySelector('[data-field="enabled"]');
    seriesEnabled.checked = node.enabled || false;
    seriesEnabled.addEventListener('input', () => {
      node[seriesEnabled.dataset.field] = seriesEnabled.checked;
      this._nodeChanged(node);
    });

    //Build out the chips for the handlers
    const eventHandlerCount = el.querySelector('#event-handler-count');
    const eventHandlersGrid = el.querySelector('#event-handlers');
    this._renderLinkableNodeChips(node, 'handler', eventHandlerCount,
        eventHandlersGrid, true);

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
        wrap.innerHTML = `<div class="tl-empty">No config</div>`;
    }

    // bind inputs → node
    wrap.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('input', () => {
        if (input.type === 'checkbox') {
          node[input.dataset.field] = input.checked;
        } else if (input.type === 'date') {
          //TODO HANDLE TIMEZONE of APP
          node[input.dataset.field] = input.valueAsDate;
        } else if (input.type === 'number') {
          node[input.dataset.field] = parseInt(input.value, 10);
        } else {
          node[input.dataset.field] = input.value;
        }
      });
    });

    container.appendChild(wrap);
  }

  /* ─────────────────────────────  HANDLER EDITOR  ───────────────────────────── */
  _renderHandlerEditor(node) {
    const el = this._getTemplate('tpl-handler-editor');
    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      node.name = name.value;
    });

    //Build out the event chips
    const handlerEventCount = el.querySelector('#handler-event-count');
    const handlerEventGrid = el.querySelector('#handler-events');
    this._renderLinkableNodeChips(node, 'event', handlerEventCount,
        handlerEventGrid, false);

    //Build out the action chips
    const handlerActionCount = el.querySelector('#handler-action-count');
    const handlerActionGrid = el.querySelector('#handler-actions');
    this._renderLinkableNodeChips(node, 'action', handlerActionCount,
        handlerActionGrid, true);

    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }

  /* ─────────────────────────────  HANDLER EDITOR  ───────────────────────────── */
  _renderActionEditor(node) {
    const el = this._getTemplate('tpl-action-editor');
    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      node.name = name.value;
    });

    //Build out the handler chips
    const actionHandlerCount = el.querySelector('#action-handler-count');
    const actionHandlerGrid = el.querySelector('#action-handlers');
    this._renderLinkableNodeChips(node, 'handler', actionHandlerCount,
        actionHandlerGrid, false);

    //Build out the reducer chips
    const actionReducerCount = el.querySelector('#action-reducer-count');
    const actionReducerGrid = el.querySelector('#action-reducers');
    this._renderLinkableNodeChips(node, 'reducer', actionReducerCount,
        actionReducerGrid, true);

    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }


  /* ───────────────────────────── REDUCER EDITOR ───────────────────────────── */
  _renderReducerEditor(node) {
    const el = this._getTemplate('tpl-reducer-editor');

    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      node.name = name.value;
    });

    // populate dropdown
    this.REDUCER_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      typeSelect.appendChild(opt);
    });

    typeSelect.value = node.reducerType || 'MetricReducer';

    typeSelect.onchange = () => {
      node.reducerType = typeSelect.value;
      this._renderReducerConfig(node, configWrap);
    };

    this._renderReducerConfig(node, configWrap);

    this.builderCanvas.appendChild(el);
    this.builderCanvas.appendChild(this._createDeleteButton(node));
  }

  /* ───────────────────── REDUCER CONFIG EDITOR ─────────────────────── */
  _renderReducerConfig(node, container) {
    container.innerHTML = '';

    let wrap;
    switch (node.reducerType) {
      case 'NumericSumMetricReducer':
      case 'MetricReducer':
        wrap = this._getTemplate('tpl-metric-reducer-editor');
        const metricInput = wrap.querySelector('[data-field="metric"]');
        metricInput.value = node.metric || '';
        break;
      case 'AccountTransactionReducer':
        wrap = this._getTemplate('tpl-account-transaction-reducer-editor');
        const accountKeyInput = wrap.querySelector('[data-field="accountKey"]');
        accountKeyInput.value = node.accountKey || '';
        break;

      default:
        wrap.innerHTML = `<div class="tl-empty">No config</div>`;
    }

    // bind inputs → node
    wrap.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', () => {
        node[input.dataset.field] = input.value;
      });
    });

    container.appendChild(wrap);
  }

  /* ───────────────────────────── CHIPS HELPER ───────────────────────────── */
  _renderLinkableNodeChips(node, kind, countSpan, chipGrid, linkTo) {
    //Get nodes that I link to
    let myChildren;
    if(linkTo) {
      myChildren = this.graph.getNodesToKindFromMe(node, kind);
    }else {
      myChildren = this.graph.getNodesFromKindToMe(node, kind);
    }

    //Set count
    countSpan.innerText = `${myChildren.length} selected`;

    //Build out the chips
    const allAvailable = this.graph.getKind(kind);
    allAvailable.forEach(available => {
      const nodeDiv = document.createElement('div');
      nodeDiv.classList.add('reducer-chip');
      nodeDiv.dataset.nodeId = available.id;
      if(myChildren.some(r => r.id === available.id)) {
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
      //Toggle behavior, if we have it remove it, if we don't add it.
      const index = myChildren.findIndex(n => n.id == chipNode.id);
      if(index < 0) {
        myChildren.push(chipNode);
        if(linkTo) {
          this.graph.addEdge({from: node.id, to: chipNode.id});
        }else {
          this.graph.addEdge({from: chipNode.id, to: node.id});
        }
        chip.classList.toggle('reducer-chip-on', true);
        this._syncCanonicalArrays(node, chipNode, kind, linkTo, 'add');
      }else {
        myChildren.splice(index, 1);
        if(linkTo) {
          this.graph.removeEdge({from: node.id, to: chipNode.id});
        }else {
          this.graph.removeEdge({from: chipNode.id, to: node.id});
        }
        chip.classList.toggle('reducer-chip-on', false);
        this._syncCanonicalArrays(node, chipNode, kind, linkTo, 'remove');
      }
      countSpan.innerText = `${myChildren.length} selected`;
    });
  }

  /**
   * After a chip toggle, update the canonical array on the correct object and
   * fire _nodeChanged on the node that owns the sim registration.
   *
   * The graph edges are the UI representation; the arrays on the domain objects
   * (handledEvents, generatedActions, reducedActions) are the sim representation.
   * These must be kept in sync, but the direction of ownership varies:
   *
   *   Handler editor → event chips   : node = handler,  owns handledEvents
   *   Handler editor → action chips  : node = handler,  owns generatedActions
   *   Reducer editor → action chips  : node = reducer,  owns reducedActions / generatedActions
   *   Event editor   → handler chips : chipNode = handler, owns handledEvents
   *   Action editor  → handler chips : chipNode = handler, owns generatedActions
   *   Action editor  → reducer chips : chipNode = reducer, owns reducedActions
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

    // Cases where node owns the canonical array → notify node
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

    // Cases where chipNode owns the canonical array → notify chipNode
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
