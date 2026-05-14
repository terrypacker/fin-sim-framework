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
