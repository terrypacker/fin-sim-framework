/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Bind a domain-editor input to its backing scenario param (design/32).
 *
 * The field becomes param-owned: it displays the param's value (the source of
 * truth), writes back to the **param** on change (never the domain object — the
 * caller excludes it from the service payload), and gains a 🔗 badge that
 * click-throughs to the param in the Scenario panel. This removes the dual
 * ownership where the param→node cascade would otherwise overwrite a form edit
 * on Rebuild.
 *
 * @param {object}      o
 * @param {HTMLElement} o.input         value input / select element
 * @param {HTMLElement} [o.labelEl]     the field's <label> (badge is appended)
 * @param {object}      o.param         the backing param (its `value` is mutated)
 * @param {(raw:string|boolean)=>*} [o.coerce]  coerce the raw input value before
 *        storing (a checkbox passes its boolean `.checked`; other inputs pass `.value`)
 * @param {()=>void}    [o.onChange]    called after the param is written
 * @param {(param:object)=>void} [o.onOpen]  called when the 🔗 badge is clicked
 */
export function bindParamLinkedField({ input, labelEl, param, coerce, onChange, onOpen }) {
  if (!input || !param) return;

  const isCheckbox = input.type === 'checkbox';

  // Show the param value (source of truth), not the domain object's field.
  if (isCheckbox) input.checked = !!param.value;
  else            input.value   = _toInputValue(input, param.value);

  const evt = (isCheckbox || input.tagName === 'SELECT' || input.type === 'date') ? 'change' : 'input';
  input.addEventListener(evt, () => {
    const raw = isCheckbox ? input.checked : input.value;
    param.value = coerce ? coerce(raw) : raw;
    onChange?.();
  });

  if (labelEl) {
    const badge = document.createElement('button');
    badge.type        = 'button';
    badge.className   = 'param-link-badge';
    badge.textContent = '🔗';
    badge.title       = `Parameter: ${param.label ?? param.name} — edits update this scenario parameter`;
    badge.addEventListener('click', (e) => { e.preventDefault(); onOpen?.(param); });
    labelEl.appendChild(badge);
  }
}

function _toInputValue(input, value) {
  if (value == null) return '';
  if (input.type === 'date') {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }
  return value;
}
