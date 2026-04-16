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
import { GraphView} from "./simulation-framework/graph-view.js";
import {SimpleProfitLoss} from "./simulations/simiple-pl.js";


const canvas = initCanvas();
const simpleProfitLoss = new SimpleProfitLoss();

const graphView = new GraphView({
  simulator: simpleProfitLoss.sim,
  canvas: canvas,
  dateChanged: dateChanged,
  nodeClicked: showDetails,
  simStart: simpleProfitLoss.simStart,
  simEnd: new Date(2028, 0, 1)
});

graphView.startViz();


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

document.getElementById('reset').onclick = () => {
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

function initCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth * 0.66;
  canvas.height = window.innerHeight;
  document.getElementById('graph').appendChild(canvas);
  return canvas;
}

function showDetails(node) {
  const panel = document.getElementById('details');
  panel.textContent = graphView.getNodeDetail(node);
}

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

