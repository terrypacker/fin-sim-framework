export class EventScheduler {

  constructor({ graph , builderCanvas}) {
    this.graph = graph;
    this.builderCanvas = builderCanvas;

    this.graph.registerNodeClickListener((event, node) => this._editNode(event, node));
    this.selectedNode = null;

    this.series = [];
    this.oneOff = [];

    this.seriesList = document.getElementById('eventSeriesList');
    this.oneOffList = document.getElementById('eventOneOffList');

    this.seriesTemplate = document.getElementById('eventSeriesTemplate');
    this.oneOffTemplate = document.getElementById('eventOneOffTemplate');

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
    const nodes = [
      { id: 'e1', kind: 'event', x: 50, y: 80, name: 'Salary' },
      { id: 'h1', kind: 'handler', x: 260, y: 80, name: 'Handler' },
      { id: 'r1', kind: 'reducer', x: 470, y: 80, name: 'Reducer', reducerType: 'MetricReducer' }
    ];
    this.graph.addNode({ id: 'e1', kind: 'event', x: 50, y: 80, name: 'Salary' });
    this.graph.addNode({ id: 'h1', kind: 'handler', x: 260, y: 80, name: 'Handler' });
    this.graph.addNode({ id: 'r1', kind: 'reducer', x: 470, y: 80, name: 'Reducer', reducerType: 'MetricReducer' });

    this.graph.addEdge({ from: 'e1', to: 'h1' });
    this.graph.addEdge({ from: 'h1', to: 'r1' });
  }

  _bind() {
    document.getElementById('addSeriesBtn')
        .onclick = () => this.addSeries();

    document.getElementById('addOneOffBtn')
        .onclick = () => this.addOneOff();

    //TODO Bind to add Hanzdler and Reducer Buttons

    setInterval(() => this._refreshHandlers(), 1000);
  }

  _handlers() {
    return Array.from(this.graph.nodes.values())
    .filter(n => n.type === 'handler');
  }

  _fill(select, val) {
    select.innerHTML = '';
    this._handlers().forEach(h => {
      const o = document.createElement('option');
      o.value = h.id;
      o.textContent = h.input.value;
      if (h.id === val) o.selected = true;
      select.appendChild(o);
    });
  }

  _refreshHandlers() {
    document.querySelectorAll('.es-handler,.eo-handler')
    .forEach(s => this._fill(s, s.value));
  }

  addSeries() {
    const item = { type:'', interval:'monthly', handlerId:null };
    this.series.push(item);

    const el = document.importNode(this.seriesTemplate.content, true);
    const root = el.querySelector('.event-card');

    const handler = root.querySelector('.es-handler');
    this._fill(handler);

    handler.onchange = () => item.handlerId = handler.value;

    this.seriesList.appendChild(root);
  }

  addOneOff() {
    const item = { type:'', date:'', handlerId:null };
    this.oneOff.push(item);

    const el = document.importNode(this.oneOffTemplate.content, true);
    const root = el.querySelector('.event-card');

    const handler = root.querySelector('.eo-handler');
    this._fill(handler);

    handler.onchange = () => item.handlerId = handler.value;

    this.oneOffList.appendChild(root);
  }

  build(graphConfig) {
    const handlerNames = graphConfig.handlers;

    return {
      eventSeries: this.series.map(s => ({
        type: s.type,
        interval: s.interval,
        handler: handlerNames[s.handlerId]
      })),
      customEvents: this.oneOff.map(e => ({
        type: e.type,
        date: e.date,
        handler: handlerNames[e.handlerId]
      }))
    };
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
    } else {
      this.builderCanvas.innerHTML = `<div class="tl-empty">${node.kind} editor coming next</div>`;
    }
  }

  addHandler() {

  }

  addReducer() {

  }

  /* ───────────────────────────── REDUCER EDITOR ───────────────────────────── */

  _renderReducerEditor(node) {
    const tpl = document.getElementById('tpl-reducer-editor');
    const el = tpl.content.cloneNode(true);

    const typeSelect = el.querySelector('[data-id="type"]');
    const configWrap = el.querySelector('[data-id="config"]');

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

    const wrap = document.createElement('div');

    switch (node.reducerType) {

      case 'MetricReducer':
        wrap.innerHTML = `
          <div class="node-field">
            <label>Metric Name</label>
            <input data-field="metric" value="${node.metric || ''}">
          </div>
        `;
        break;

      case 'NumericSumMetricReducer':
        wrap.innerHTML = `
          <div class="node-field">
            <label>Metric</label>
            <input data-field="metric" value="${node.metric || ''}">
          </div>
        `;
        break;

      case 'AccountTransactionReducer':
        wrap.innerHTML = `
          <div class="node-field">
            <label>Account Key</label>
            <input data-field="accountKey" value="${node.accountKey || ''}">
          </div>
        `;
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
