// Stub for chart.js — used by jest so that BaseApp can be imported without
// a real canvas context.
const Chart = class {
  constructor() {}
  static register() {}
  static defaults = { plugins: {} };
  destroy() {}
  update() {}
};
const registerables = [];
module.exports = { Chart, registerables };
