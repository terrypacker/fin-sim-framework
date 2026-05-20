/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  EChartsGraphRenderer
} from "../../src/visualization/components/echarts-graph-renderer.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function loadHtml(htmlFile) {

  const htmlPath = fileURLToPath(
      new URL(htmlFile, import.meta.url)
  );
  document.body.innerHTML = fs.readFileSync(htmlPath, 'utf8');
}

export function makeMockGraphRenderer() {
  return {
    relayoutAll: jest.fn(),
    _graphQueryApi: {
      getRelated: jest.fn(() => []),
    },
  };
}

/**
 * Mount a div in the body and return it
 * @return {HTMLDivElement}
 */
export function makeMockContainer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

export function makeBodyMockElement(tagName) {
  return makeMockElement(tagName, document.body);
}
/**
 * Create an element and mount it into the parent
 * @param tagName
 * @param parent
 * @return {HTMLAnchorElement | HTMLElement | HTMLAreaElement | HTMLAudioElement | HTMLBaseElement | HTMLQuoteElement | HTMLBodyElement | HTMLBRElement | HTMLButtonElement | HTMLCanvasElement | HTMLTableCaptionElement | HTMLTableColElement | HTMLDataElement | HTMLDataListElement | HTMLModElement | HTMLDetailsElement | HTMLDialogElement | HTMLDivElement | HTMLDListElement | HTMLEmbedElement | HTMLFieldSetElement | HTMLFormElement | HTMLHeadingElement | HTMLHeadElement | HTMLHRElement | HTMLHtmlElement | HTMLIFrameElement | HTMLImageElement | HTMLInputElement | HTMLLabelElement | HTMLLegendElement | HTMLLIElement | HTMLLinkElement | HTMLMapElement | HTMLMenuElement | HTMLMetaElement | HTMLMeterElement | HTMLObjectElement | HTMLOListElement | HTMLOptGroupElement | HTMLOptionElement | HTMLOutputElement | HTMLParagraphElement | HTMLPictureElement | HTMLPreElement | HTMLProgressElement | HTMLScriptElement | HTMLSelectElement | HTMLSlotElement | HTMLSourceElement | HTMLSpanElement | HTMLStyleElement | HTMLTableElement | HTMLTableSectionElement | HTMLTableCellElement | HTMLTemplateElement | HTMLTextAreaElement | HTMLTimeElement | HTMLTitleElement | HTMLTableRowElement | HTMLTrackElement | HTMLUListElement | HTMLVideoElement}
 */
export function makeMockElement(tagName, parent) {
  const el = document.createElement(tagName);
  parent.appendChild(el);
  return el;
}

/**
 * Mock a very dumb canvas, useful for Echarts tests
 */
export function mockCanvas() {
  // At the top of your test or in setupTests.js
  window.HTMLCanvasElement.prototype.getContext = () => {
    return {
      // Return a basic mock of the context object if ECharts calls specific methods
      fillRect: () => {},
      clearRect: () => {},
      getImageData: (x, y, w, h) => ({ data: new Array(w * h * 4).fill(0) }),
      putImageData: () => {},
      createImageData: () => [],
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      arc: () => {},
      fill: () => {},
      measureText: () => ({ width: 0 }),
      transform: () => {},
      rect: () => {},
      clip: () => {},
    };
  };
}

/**
 * Mock the div and canvas so echarts can function properly
 */
export function mockGraphRoot() {
  mockCanvas();
  const graphRoot = document.createElement('div');
  // Give it pixel dimensions so _pixelToData and _resetView work.
  Object.defineProperty(graphRoot, 'getBoundingClientRect', {
    value: () => ({ width: 800, height: 600, left: 0, top: 0 }),
  });

  // Mock clientWidth and clientHeight
  Object.defineProperty(graphRoot, 'clientWidth', { value: 800 });
  Object.defineProperty(graphRoot, 'clientHeight', { value: 600 });
  return graphRoot;
}
