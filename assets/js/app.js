/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * app.js
 * Main application controller and ES module entry point.
 * Run once on DOMContentLoaded.
 *
 * This is a basic example of how to use the framework.
 */
import { Account, AccountService } from './finance/account.js';
import { Asset } from './finance/asset.js';
import { Simulation } from './simulation-framework/simulation.js';
import { PRIORITY } from './simulation-framework/reducers.js';

//Visualization FDG
const nodes = new Map(); // id -> { x, y, vx, vy, data }
const edges = [];        // { from, to }

let running = true;

function step() {
  const nodeList = [...nodes.values()];

  // --- Repulsion ---
  for (let i = 0; i < nodeList.length; i++) {
    for (let j = i + 1; j < nodeList.length; j++) {
      const a = nodeList[i];
      const b = nodeList[j];

      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist = Math.sqrt(dx * dx + dy * dy) + 0.01;

      let force = 1000 / (dist * dist);

      dx /= dist;
      dy /= dist;

      a.vx += dx * force;
      a.vy += dy * force;

      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }

  // --- Attraction (edges) ---

  for (const e of edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);

    if (!a || !b) continue;

    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let dist = Math.sqrt(dx * dx + dy * dy) + 0.01;

    let force = (dist - 100) * 0.01;

    dx /= dist;
    dy /= dist;

    a.vx += dx * force;
    a.vy += dy * force;

    b.vx -= dx * force;
    b.vy -= dy * force;
  }

  // --- Integrate ---
  for (const n of nodeList) {
    n.vx *= 0.85; // damping
    n.vy *= 0.85;

    n.x += n.vx;
    n.y += n.vy;
  }
}

function showDetails(node) {
  const panel = document.getElementById("details");

  const diff = diffState(node.stateBefore, node.stateAfter);

  panel.textContent = JSON.stringify({
    id: node.id,
    type: node.type,
    reducer: node.reducer,
    parent: node.parent,
    children: node.children,
    action: node.action,
    stateDiff: diff
  }, null, 2);
}

function diffState(prev, next) {
  const diff = {};

  for (const key in next) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      diff[key] = {
        before: prev[key],
        after: next[key]
      };
    }
  }

  return diff;
}

export function attachGraphDebugger(bus) {
  bus.subscribe('DEBUG_ACTION', ({ payload }) => {
    const n = payload;

    if (!nodes.has(n.id)) {
      nodes.set(n.id, {
        ...n,
        x: Math.random() * 800,
        y: Math.random() * 600,
        vx: 0,
        vy: 0
      });
    }

    if (n.parent !== null) {
      edges.push({ from: n.parent, to: n.id });
    }
  });

  startSimulation();
}

let canvas, ctx;

function initCanvas() {
  canvas = document.createElement("canvas");
  canvas.width = window.innerWidth * 0.66;
  canvas.height = window.innerHeight;

  document.getElementById("graph").appendChild(canvas);
  ctx = canvas.getContext("2d");

  canvas.addEventListener("click", onClick);
}

function onClick(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  for (const n of nodes.values()) {
    const dx = n.x - x;
    const dy = n.y - y;

    if (dx * dx + dy * dy < 100) {
      showDetails(n);
      break;
    }
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // edges
  ctx.strokeStyle = "#475569";
  ctx.fillStyle = "#475569";

  for (const e of edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);

    if (!a || !b) continue;

    drawArrow(ctx, a.x, a.y, b.x, b.y);
  }

  // nodes
  for (const n of nodes.values()) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#60a5fa";
    ctx.fill();

    ctx.fillStyle = "#e5e7eb";
    ctx.font = "10px monospace";
    ctx.fillText(n.type, n.x + 10, n.y);
  }
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const headLength = 8; // size of arrow head

  const dx = x2 - x1;
  const dy = y2 - y1;
  const angle = Math.atan2(dy, dx);

  // Shorten line so it doesn't go into the node center
  const nodeRadius = 8;

  const tx = x2 - Math.cos(angle) * nodeRadius;
  const ty = y2 - Math.sin(angle) * nodeRadius;

  // Draw line
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  // Draw arrowhead
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(
      tx - headLength * Math.cos(angle - Math.PI / 6),
      ty - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
      tx - headLength * Math.cos(angle + Math.PI / 6),
      ty - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

function loop() {
  if (!running) return;

  step();
  draw();

  requestAnimationFrame(loop);
}

function startSimulation() {
  initCanvas();
  loop();
}

function createSim() {
  const accountService = new AccountService();

  //Create some assets
  const assets = [];
  assets.push(new Asset('item1', 1200, 200));
  assets.push(new Asset('item2', 10400, 400));
  assets.push(new Asset('item3', 20200, 200));
  assets.push(new Asset('item4', 9200, 1200));

  /*
   * The state cannot have any methods included in it
   * because of the structuredClone feature for replay
   *
   * @type {{metrics: {}, realizedGains: number, savingsAccount: Account, assets: *[]}}
   */
  const initialState = {
    metrics: { },
    realizedGains: 0,
    savingsAccount: new Account(0),
    assets: assets
  }

  const sim = new Simulation(new Date(2025, 0, 1), {
    initialState: initialState
  });

  //Sell Asset quarterly
  sim.scheduleQuarterly({
    startDate: new Date(2025, 0, 1),
    type: 'SELL_ASSET',
    data: { },
    meta: { metaFlag: true }
  });

  // Quarterly P/L
  sim.scheduleQuarterly({
    startDate: new Date(2025, 0, 1),
    type: 'QUARTERLY_PL',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  sim.scheduleAnnually({
    startDate: new Date(2026, 0, 1),
    type: 'ANNUAL_TAX',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  /** Reducers **/
  //Action chaining by emitting a next event
  sim.reducers.register(
      'REALIZE_GAIN',
      (state, action, date) => {
        return {
          state: {
            ...state,
            realizedGains: state.realizedGains + action.amount
          },
          next: [
            { type: 'CALCULATE_CAPITAL_GAINS_TAX', amount: action.amount }
          ]
        };
      },
      PRIORITY.COST_BASIS
  );

  //Handle adding cache to the account
  sim.reducers.register('CALCULATE_CAPITAL_GAINS_TAX', (state, action, date) => {
    const transactionTax = action.amount * 0.15;
    const capitalGainsTax = state.capitalGainsTax ?state.capitalGainsTax : [];
    capitalGainsTax.push(transactionTax);
    return {
      state: {
        ...state,
        capitalGainsTax: capitalGainsTax
      },
      next: [
        { type: 'RECORD_METRIC', name: 'capital_gains_tax', value: transactionTax },
      ]
    };
  });

  //Record metrics
  sim.reducers.register('RECORD_METRIC', (state, action, date) => {
    return {
      ...state,
      metrics: {
        ...state.metrics,
        [action.name]: [
          ...(state.metrics[action.name] || []),
          action.value
        ]
      }
    };
  });

  //Credit account
  sim.reducers.register('ADD_CASH', (state, action, date) => {
    accountService.transaction(state.savingsAccount, action.amount, date);
    return {
      ...state
    };
  });

  //Debit account
  sim.reducers.register('REMOVE_CASH', (state, action, date) => {
    accountService.transaction(state.savingsAccount, action.amount, date);
    return {
      ...state
    };
  });

  /**  HANDLERS **/
  //Annual tax Handler
  sim.register('SELL_ASSET', (ctx) => {
    //Pick an asset to sell
    const toSell = ctx.state.assets.pop();
    if(toSell) {
      //if no assets left then we don't need to realize gains
      const realizedGain = toSell.value - toSell.costBasis;
      return [
        { type: 'REALIZE_GAIN', amount: realizedGain },
        { type: 'ADD_CASH', amount: toSell.value },
        { type: 'RECORD_METRIC', name: 'assets_sold', value: toSell.name },
      ];
    }else {
      return [];
    }
  });

  //Quarterly PL Handler
  sim.register('QUARTERLY_PL', ({ sim }) => {
    const profit = sim.rng() * 10000;
    return [
      { type: 'ADD_CASH', amount: profit },
      { type: 'RECORD_METRIC', name: 'quarterly_profit', value: profit }
    ];
  });

  //Annual tax Handler
  sim.register('ANNUAL_TAX', (ctx) => {
    const taxRate = 0.3;
    const tax = -(ctx.state.savingsAccount.balance * taxRate);
    return [
      { type: 'REMOVE_CASH', amount: tax },
      { type: 'RECORD_METRIC', name: 'annual_tax', value: tax }
    ];
  });


  /* Listen to all messages '*' */
  sim.bus.subscribe('DEBUG_ACTION', (event) => {
    //console.log(event);
    /*console.log(
        `[${event.date.toDateString()}] ${event.type}`,
        event.payload
    );*/
  });

  return sim;
}
const sim = createSim();
attachGraphDebugger(sim.bus);

//Simulat to some time in the future
sim.stepTo(new Date(2028, 0, 1));

