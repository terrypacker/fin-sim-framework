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
 * profit-loss.js
 * Main application controller and ES module entry point.
 * Run once on DOMContentLoaded.
 *
 * This is a basic example of how to use the framework.
 */
import { GraphView} from "./visualization/graph-view.js";
import {SimpleProfitLoss} from "./simulations/simiple-pl.js";
import {TimelineView} from "./visualization/timeline-view.js";


// ─── DOM helpers ─────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const fmt = n  => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Graph view (Action Graph tab) ─────────────────────────────────────────
const graphCanvas = $('graphCanvas');
const simpleProfitLoss = new SimpleProfitLoss();

const graphView = new GraphView({
  simulator: simpleProfitLoss.sim,
  canvas: graphCanvas,
  dateChanged: dateChanged,
  nodeClicked: showDetails,
  simStart: simpleProfitLoss.simStart,
  simEnd: new Date(2028, 0, 1)
});

graphView.startViz();

// Timeline view
const timelineView = new TimelineView({
  container: $('timelineContainer'),
  onDetail:  showDetailModal
});
timelineView.attach(simpleProfitLoss.sim.journal);


//Setup the slider controls
const slider = document.getElementById("timeSlider");
const label = document.getElementById("timeLabel");

let playing = false;
const playButton = document.getElementById("playPause");
playButton.onclick = () => {
  if(!playing) {
    startPlaying();
  }else {
    stopPlaying();
  }
};

function stopPlaying() {
  playing = false;
  playButton.innerText = '▶';
}

function startPlaying() {
  playing = true;
  playButton.innerText = '⏸';
  animate();
}

document.getElementById('stepForward').onclick = () => {
  const sliderValue = Number(slider.value);
  if(sliderValue === 100) return;
  slider.value = sliderValue + 1;
  const stepEvent = new Event('input');
  stepEvent.playType = 'forward';
  slider.dispatchEvent(stepEvent);
};

document.getElementById('stepBackward').onclick = () => {
  const sliderValue = Number(slider.value);
  if(sliderValue === 0) return;
  slider.value = sliderValue - 1;
  const rewindEvent = new Event('input');
  rewindEvent.playType = 'rewind';
  slider.dispatchEvent(rewindEvent);
};

document.getElementById('resetBtn').onclick = () => {
  const sliderValue = Number(slider.value);
  if(sliderValue === 0) return;
  slider.value = 0;
  const rewindEvent = new Event('input');
  rewindEvent.playType = 'rewind';
  slider.dispatchEvent(rewindEvent);
};


//TODO Support debouncing the rewind
let rewindTimeout;

slider.addEventListener('input', (evt) => {
  clearTimeout(rewindTimeout);
  rewindTimeout = setTimeout(() => {
    const sliderValue = Number(slider.value);
    const targetPercentage = sliderValue / 100.0;
    let targetTime;
    if(evt?.playType === 'forward') {
      targetTime = graphView.stepTo(targetPercentage);
      timelineView.update();
    }else if(evt?.playType === 'rewind') {
      // Rewind view
      targetTime = graphView.rewindTo(targetPercentage);
    }else {
      targetTime = graphView.rewindTo(targetPercentage);
    }
    label.textContent = targetTime.toDateString();
  }, 50);
});

function dateChanged(date, simStart, simEnd) {
  //Set slider value and min/max
  const stepPerValue = ((simEnd.getTime() - simStart.getTime())/100);
  const currentStep = (date.getTime() - simStart.getTime())/stepPerValue;
  slider.value = currentStep;
}

function formatNodeDetail(node) {
  const diff = graphView.diffState(node.stateBefore, node.stateAfter);
  const diffEntries = Object.entries(diff);

  const fmtVal = v => {
    if (typeof v === 'number') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return JSON.stringify(v);
  };

  const actionFields = Object.entries(node.action || {})
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `<tr>
      <td style="color:#64748b;padding:2px 4px">${k}</td>
      <td style="color:#e5e7eb;padding:2px 4px">${typeof v === 'number' ? fmtVal(v) : JSON.stringify(v)}</td>
    </tr>`)
    .join('');

  const diffRows = diffEntries.length === 0
    ? '<tr><td colspan="3" style="color:#64748b;padding:4px;text-align:center">No state changes</td></tr>'
    : diffEntries.map(([key, { before, after }]) => {
        const delta = typeof after === 'number' && typeof before === 'number' ? after - before : null;
        const deltaHtml = delta != null
          ? ` <span style="color:${delta >= 0 ? '#34d399' : '#f87171'}">${delta >= 0 ? '+' : ''}${fmtVal(delta)}</span>`
          : '';
        return `<tr>
          <td style="color:#94a3b8;padding:2px 4px">${key}</td>
          <td style="color:#64748b;padding:2px 4px">${fmtVal(before)}</td>
          <td style="color:#e5e7eb;padding:2px 4px">${fmtVal(after)}${deltaHtml}</td>
        </tr>`;
      }).join('');

  return `
    <div style="font-size:11px;line-height:1.5">
      <div style="color:#a5b4fc;font-size:13px;font-weight:bold;margin-bottom:4px">${node.type}</div>
      <div style="color:#64748b;margin-bottom:8px;font-size:10px">
        Date: <span style="color:#e5e7eb">${new Date(node.date).toDateString()}</span>
        &nbsp;|&nbsp; Reducer: <span style="color:#e5e7eb">${node.reducer || '—'}</span>
      </div>
      ${actionFields ? `
        <div style="font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #333;padding-bottom:3px;margin-bottom:5px">Action Payload</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:8px"><tbody>${actionFields}</tbody></table>
      ` : ''}
      <div style="font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #333;padding-bottom:3px;margin-bottom:5px">State Changes</div>
      <table style="width:100%;border-collapse:collapse;font-size:10px">
        <thead><tr>
          <th style="text-align:left;color:#64748b;padding:2px 4px;font-weight:normal">Field</th>
          <th style="text-align:left;color:#64748b;padding:2px 4px;font-weight:normal">Before</th>
          <th style="text-align:left;color:#64748b;padding:2px 4px;font-weight:normal">After</th>
        </tr></thead>
        <tbody>${diffRows}</tbody>
      </table>
    </div>`;
}

function showDetails(node) {
  document.getElementById('nodeDetailFormatted').innerHTML = formatNodeDetail(node);
  document.getElementById('nodeDetailJson').textContent = graphView.getNodeDetail(node);
}

// Node detail tab switching
document.querySelectorAll('[data-ndtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.ndtab;
    document.querySelectorAll('[data-ndtab]').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('nodeDetailFormatted').classList.toggle('hidden', target !== 'nodeDetailFormatted');
    document.getElementById('nodeDetailJson').classList.toggle('hidden', target !== 'nodeDetailJson');
  });
});

function animate() {
  if (!playing) return;

  const slider = document.getElementById('timeSlider');
  slider.value = Math.min(100, Number(slider.value) + 1);

  //This will reset sim:
  const percentComplete = slider.value / 100;
  graphView.stepTo(percentComplete);

  if(slider.value < 100) {
    requestAnimationFrame(animate);
  }else {
    stopPlaying();
  }
}

function showDetailModal(entry) {
  const existing = document.getElementById('detailModal');
  if (existing) existing.remove();

  const changes  = diffStates(entry.prevState, entry.nextState);
  const emitted  = entry.emittedActions?.length
      ? entry.emittedActions.map(a => a.type).join(', ')
      : '(none)';

  const actionPayload = JSON.stringify(
      Object.fromEntries(Object.entries(entry.action).filter(([k]) => !k.startsWith('_'))),
      null, 2
  );

  const diffRows = changes.length === 0
      ? '<tr><td colspan="3" style="text-align:center;color:#64748b;padding:8px">No scalar state changes</td></tr>'
      : changes.map(c => {
        const fmtVal = v => typeof v === 'number' ? fmt(v) : String(v);
        const deltaHtml = c.delta != null
            ? `<span class="${c.delta >= 0 ? 'diff-pos' : 'diff-neg'}">${c.delta >= 0 ? '+' : ''}${fmt(c.delta)}</span>`
            : '';
        return `<tr>
          <td class="diff-field">${c.field}</td>
          <td class="diff-before">${fmtVal(c.before)}</td>
          <td class="diff-after">${fmtVal(c.after)} ${deltaHtml}</td>
        </tr>`;
      }).join('');

  const overlay = document.createElement('div');
  overlay.id    = 'detailModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-hdr">
        <span>${entry.action.type}</span>
        <button class="modal-close" title="Close">✕</button>
      </div>
      <div class="modal-body">
        <table class="modal-meta">
          <tr><td>Date</td>         <td>${entry.date.toDateString()}</td></tr>
          <tr><td>Source event</td> <td>${entry.eventType}</td></tr>
          <tr><td>Reducer</td>      <td>${entry.reducer}</td></tr>
          <tr><td>Emitted</td>      <td>${emitted}</td></tr>
        </table>

        <div class="modal-section-title">Action Payload</div>
        <pre class="modal-code">${actionPayload}</pre>

        <div class="modal-section-title">State Changes</div>
        <table class="diff-table">
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>${diffRows}</tbody>
        </table>
      </div>
    </div>`;

  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// Canvas sizing
function resizeCanvases() {
  const contentEl = $('content');
  const w = contentEl.clientWidth;
  const h = contentEl.clientHeight;
  $('graphCanvas').width  = w;
  $('graphCanvas').height = h;
}

window.addEventListener('resize', resizeCanvases);
resizeCanvases();
