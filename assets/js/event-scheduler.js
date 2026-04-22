export class EventScheduler {

  constructor({ graph , builderCanvas}) {
    this.graph = graph;
    this.builderCanvas = builderCanvas;

    this.graph.registerNodeClickListener((event, node) => this._editNode(event, node));
    this.selectedNode = null;

    this.seriesTemplate = document.getElementById('eventSeriesTemplate');
    this.oneOffTemplate = document.getElementById('eventOneOffTemplate');

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

  /* ───────────────────────────── INIT ───────────────────────────── */

  initDemo() {
    const buyLambo = new Date();
    buyLambo.setMonth(buyLambo.getMonth() + 3);

    const recordSalaryReducerNode = {
      id: 'r1',
      name: 'Record Salary',
      kind: 'reducer',
      x: 470, y: 80,
      reducerType: 'MetricReducer',
      metric: 'amount'
    };

    const salaryPaymentHandler = {
      id: 'h1',
      name: 'Handler',
      kind: 'handler',
      x: 260, y: 80,
      reducers: [recordSalaryReducerNode]
    }

    this.graph.addNode({ id: 'e1', kind: 'event', x: 50, y: 80, name: 'Salary', eventType: 'Series', interval: 'month-end', enabled: true });
    this.graph.addNode({ id: 'e2', kind: 'event', x: 50, y: 180, name: 'Buy Lamborghini', eventType: 'OneOff', date: buyLambo, enabled: true });
    this.graph.addNode(salaryPaymentHandler);
    this.graph.addNode(recordSalaryReducerNode);

    this.graph.addEdge({ from: 'e1', to: 'h1' });
    this.graph.addEdge({ from: 'h1', to: 'r1' });
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

  addSeries() {

  }

  addOneOff() {

  }

  addHandler() {

  }

  addReducer() {

  }

  /* ─────────────────────────────  HANDLER EDITOR  ───────────────────────────── */

  _renderHandlerEditor(node) {
    const el = this._getTemplate('tpl-handler-editor');
    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      node.name = name.value;
    });

    //Build out the chips
    const handlerReducerCount = el.querySelector('#handler-reducer-count');
    handlerReducerCount.innerText = `${node.reducers.length} selected`;

    const handlerReducersGrid = el.querySelector('#handler-reducers');
    const allAvailableReducers = this.graph.getReducers();
    allAvailableReducers.forEach(available => {
      const reducer = document.createElement('div');
      reducer.classList.add('reducer-chip');
      reducer.dataset.reducerId = available.id;
      if(node.reducers.some(r => r.reducerType === available.reducerType)) {
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
      const index = node.reducers.findIndex(n => n.id == reducer.id);
      if(index < 0) {
        node.reducers.push(reducer);
        chip.classList.toggle('reducer-chip-on', true);
      }else {
        node.reducers.splice(index, 1);
        chip.classList.toggle('reducer-chip-on', false);
      }
      handlerReducerCount.innerText = `${node.reducers.length} selected`;
    });

    this.builderCanvas.appendChild(el);
  }

  /* ─────────────────────────────  EVENT EDITOR  ───────────────────────────── */

  _renderEventEditor(node) {
    const el = this._getTemplate('tpl-event-editor');
    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    name.addEventListener('input', () => {
      node.name = name.value;
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
