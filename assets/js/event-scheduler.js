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
    document.getElementById('addSeriesBtn')
        .onclick = () => this.addSeries();

    document.getElementById('addOneOffBtn')
        .onclick = () => this.addOneOff();
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
    }else {
      this.builderCanvas.innerHTML = `<div class="tl-empty">${node.kind} editor coming next</div>`;
    }
  }

  /**
   * Add an event to the graph
   * @param event
   */
  addEvent(event) {
    //Decorate the event
    event.kind = 'event';
    event.name = event.label; //TODO Fix upper framework to be consistent
    if(event instanceof FinSimLib.Scenarios.EventSeries) {
      event.eventType = 'Series';
    }else {
      event.eventType = 'OneOff';
    }

    this.graph.addNode(event);
    //TODO add child edges
  }

  /**
   * Add a handler to an event
   * @param event
   * @param handler
   */
  addHandler(event, handler) {
    //Decorate the handler
    handler.kind = 'handler';
    this.graph.addNode(handler);

    //Add an edge from event --> handler
    this.graph.addEdge({from: event.id, to: handler.id});
  }

  addReducer(handler, reducer) {
    //Decorate the reducer
    reducer.kind = 'reducer';
    if(reducer instanceof FinSimLib.Core.MetricReducer) {
      reducer.reducerType = 'MetricReducer';
    }
    this.graph.addNode(reducer);

    //Add edges from handler --> reducer
    this.graph.addEdge({from: handler.id, to: reducer.id});
  }

  /* ─────────────────────────────  HANDLER EDITOR  ───────────────────────────── */

  _renderHandlerEditor(node) {
    const el = this._getTemplate('tpl-handler-editor');
    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      node.name = name.value;
    });

    const myReducers = this.graph.getNodesToKindFromMe(node, 'reducer');

    //Build out the chips
    const handlerReducerCount = el.querySelector('#handler-reducer-count');
    handlerReducerCount.innerText = `${myReducers.length} selected`;

    const handlerReducersGrid = el.querySelector('#handler-reducers');
    const allAvailableReducers = this.graph.getKind('reducer');
    allAvailableReducers.forEach(available => {
      const reducer = document.createElement('div');
      reducer.classList.add('reducer-chip');
      reducer.dataset.reducerId = available.id;
      if(myReducers.some(r => r.reducerType === available.reducerType)) {
        reducer.classList.add('reducer-chip-on');
      }
      const nameSpan = document.createElement('span');
      nameSpan.classList.add('reducer-chip-name');
      nameSpan.innerText = available.name;
      nameSpan.title = available.name;
      reducer.appendChild(nameSpan);
      const checkSpan = document.createElement('span');
      checkSpan.classList.add('reducer-chip-check');
      checkSpan.innerHTML = '&#x2713';
      handlerReducersGrid.appendChild(reducer);
    });

    handlerReducersGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.reducer-chip[data-reducer-id]');
      if (!chip) return;
      const reducer = this.graph.getNode(chip.dataset.reducerId);
      //Toggle behavior, if we have it remove it, if we don't add it.
      const index = myReducers.findIndex(n => n.id == reducer.id);
      if(index < 0) {
        myReducers.push(reducer);
        //Add edge
        this.graph.addEdge({from: node.id, to: reducer.id})
        chip.classList.toggle('reducer-chip-on', true);
      }else {
        myReducers.splice(index, 1);
        //Remove Edge
        this.graph.removeEdge({from: node.id, to: reducer.id});
        chip.classList.toggle('reducer-chip-on', false);
      }
      handlerReducerCount.innerText = `${myReducers.length} selected`;
    });

    this.builderCanvas.appendChild(el);
  }

  /* ─────────────────────────────  EVENT EDITOR  ───────────────────────────── */

  _renderEventEditor(node) {
    const el = this._getTemplate('tpl-event-editor');
    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

    const label = el.querySelector('[data-id="label"]');
    label.value = node.label || '';
    label.addEventListener('input', () => {
      node.label = label.value;
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
    };

    const seriesEnabled = el.querySelector('[data-field="enabled"]');
    seriesEnabled.checked = node.enabled || false;
    seriesEnabled.addEventListener('input', () => {
      node[seriesEnabled.dataset.field] = seriesEnabled.checked;
    });

    //Build out the chips
    const myHandlers = this.graph.getNodesToKindFromMe(node, 'handler');
    const eventHandlerCount = el.querySelector('#event-handler-count');
    eventHandlerCount.innerText = `${myHandlers.length} selected`;

    const eventHandlersGrid = el.querySelector('#event-handlers');
    const allAvailableHandlers = this.graph.getKind('handler');
    allAvailableHandlers.forEach(available => {
      const handler = document.createElement('div');
      handler.classList.add('reducer-chip');
      handler.dataset.handlerId = available.id;
      if(myHandlers.some(r => r.name === available.name)) {
        handler.classList.add('reducer-chip-on');
      }
      const nameSpan = document.createElement('span');
      nameSpan.classList.add('reducer-chip-name');
      nameSpan.innerText = available.name;
      nameSpan.title = available.name;
      handler.appendChild(nameSpan);
      const checkSpan = document.createElement('span');
      checkSpan.classList.add('reducer-chip-check');
      checkSpan.innerHTML = '&#x2713';
      eventHandlersGrid.appendChild(handler);
    });

    eventHandlersGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.reducer-chip[data-handler-id]');
      if (!chip) return;
      const handler = this.graph.getNode(chip.dataset.handlerId);
      //Toggle behavior, if we have it remove it, if we don't add it.
      const index = myHandlers.findIndex(n => n.id == handler.id);
      if(index < 0) {
        myHandlers.push(handler);
        //Add edge
        this.graph.addEdge({from: node.id, to: handler.id})
        chip.classList.toggle('reducer-chip-on', true);
      }else {
        myHandlers.splice(index, 1);
        //Remove Edge
        this.graph.removeEdge({from: node.id, to: handler.id});
        chip.classList.toggle('reducer-chip-on', false);
      }
      eventHandlerCount.innerText = `${myHandlers.length} selected`;
    });

    this._renderEventConfig(node, configWrap);
    this.builderCanvas.appendChild(el);
  }

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
        if(input.type === 'checkbox') {
          node[input.dataset.field] = input.checked;
        }else if(input.type === 'date') {
          //TODO HANDLE TIMEZONE of APP
          node[input.dataset.field] = input.valueAsDate;
        }else {
          node[input.dataset.field] = input.value;
        }
      });
    });

    container.appendChild(wrap);
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
  }

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

}
