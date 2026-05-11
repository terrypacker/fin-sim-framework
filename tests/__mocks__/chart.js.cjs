// Stub for chart.js — used by jest so that BaseApp can be imported without
// a real canvas context.
const Chart = class {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.data    = config?.data    ?? { datasets: [] };
    this.options = config?.options ?? {};
  }
  static register() {}
  static defaults = { plugins: {} };
  destroy()   {}
  update()    {}
  resetZoom() {}
};
const registerables = [];

// Needed by chartjs-adapter-date-fns
const _adapters = {
  _date: {
    override: jest.fn()
  }
};

module.exports = { Chart, registerables, _adapters };
