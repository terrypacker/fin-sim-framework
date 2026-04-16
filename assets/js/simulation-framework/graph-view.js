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

export class GraphView {
  constructor({ simulator, canvas, dateChanged, nodeClicked, simStart, simEnd}) {
    this.sim = simulator;
    this.dateChanged = dateChanged;
    this.nodeClicked = nodeClicked;
    this.canvas = canvas;
    this.ctx = this.canvas.getContext("2d");
    this.nodes = new Map(); // id -> { x, y, vx, vy, data }
    this.edges = [];// { from, to }
    this.simStart = simStart;
    this.simEnd = simEnd;
    this.running = false;

    this.canvas.addEventListener("click", (evt) => this.onClick(evt));

    this.sim.bus.subscribe('DEBUG_ACTION', ({ payload }) => {
      this.messageHandler(payload);
    });
  }

  messageHandler(payload) {
    const date = new Date(payload.date);

    if (!this.simEnd || date > this.simEnd) {
      this.simEnd = date;
    }

    //Nofity date listeners
    this.dateChanged(date, this.simStart, this.simEnd);

    const n = payload;

    if (!this.nodes.has(n.id)) {
      this.nodes.set(n.id, {
        ...n,
        x: Math.random() * 800,
        y: Math.random() * 600,
        vx: 0,
        vy: 0
      });
    }

    if (n.parent !== null) {
      this.edges.push({ from: n.parent, to: n.id });
    }
  }

  stepTo(percentComplete) {
    const targetTime = new Date(
        this.simStart.getTime() +
        percentComplete * (this.simEnd.getTime() - this.simStart.getTime())
    );
    this.sim.stepTo(targetTime);
    return targetTime;
  }

  rewindTo(percentageComplete) {
    const targetTime = new Date(
        this.simStart.getTime() +
        percentageComplete * (this.simEnd.getTime() - this.simStart.getTime())
    );
    this.resetGraph();
    this.sim.rewindToStart();
    this.sim.stepTo(targetTime);
    return targetTime;
  }

  /**
   * Reset the graph to replay
   */
  resetGraph() {
    this.nodes.clear();
    this.edges.length = 0;
  }

  startViz() {
    this.running = true;
    this.loop();
  }

  stopViz() {
    this.running = false;
  }

  /**
   * Animation loop
   */
  loop() {
    if (!this.running) {
      return;
    }
    this.step();
    this.draw();
    requestAnimationFrame(() => this.loop());
  }

  /**
   * Viz step
   */
  step() {
    const nodeList = [...this.nodes.values()];

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

    for (const e of this.edges) {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);

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

  draw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // edges
    this.ctx.strokeStyle = "#475569";
    this.ctx.fillStyle = "#475569";

    for (const e of this.edges) {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);

      if (!a || !b) continue;

      this.drawArrow(this.ctx, a.x, a.y, b.x, b.y);
    }

    // nodes
    for (const n of this.nodes.values()) {
      this.ctx.beginPath();
      this.ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
      this.ctx.fillStyle = "#60a5fa";
      this.ctx.fill();

      this.ctx.fillStyle = "#e5e7eb";
      this.ctx.font = "10px monospace";
      this.ctx.fillText(n.type, n.x + 10, n.y);
    }
  }

  drawArrow(ctx, x1, y1, x2, y2) {
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

  onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    for (const n of this.nodes.values()) {
      const dx = n.x - x;
      const dy = n.y - y;

      if (dx * dx + dy * dy < 100) {
        this.nodeClicked(n);
        break;
      }
    }
  }

  /**
   * Get the details for a node
   * @param node
   * @returns {string}
   */
  getNodeDetail(node) {
    const diff = this.diffState(node.stateBefore, node.stateAfter);

    return JSON.stringify({
      ...node,
      stateDiff: diff
    }, null, 2);
  }

  /**
   * Compute the difference in state between 2 nodes
   * @param prev
   * @param next
   * @returns {{}}
   */
  diffState(prev, next) {
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

}
