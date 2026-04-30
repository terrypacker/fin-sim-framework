/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { CustomScenario } from './scenarios/custom-scenario.js';

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'monthCounter', color: '#60a5fa', label: 'Month Count' },
  { key: 'yearCounter',  color: '#34d399', label: 'Year Count'  },
];

class CustomApp extends FinSimLib.Misc.BaseApp {
  constructor() {
    super({
      newScenario: (params, initialState, eventSchedulerUI) => {
        const cfg = this._activeScenario();
        if (cfg) {
          return new FinSimLib.Scenarios.BaseScenario({
            eventSchedulerUI,
            simStart: cfg.simStart ? new Date(cfg.simStart) : new Date(Date.UTC(2026, 0, 1)),
            simEnd:   cfg.simEnd   ? new Date(cfg.simEnd)   : new Date(Date.UTC(2041, 0, 1)),
          });
        }
        return new CustomScenario({ eventSchedulerUI });
      },
      chartSeries: CHART_SERIES,
    });
  }

  getInitialState() {
    const activeScenario = super._activeScenario();
    if(activeScenario) {
      return activeScenario.initialState;
    }else {
      return {
        metrics: {
          amount: 0,
          salary: 0
        }
      };
    }
  }

  initView() {
    super.initView();
    this._initGroupSelector();
    this._initPeoplePanel();
  }

  // ── Left-panel group selector ─────────────────────────────────────────────

  _initGroupSelector() {
    document.querySelectorAll('.left-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        document.querySelectorAll('.left-group-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.left-group').forEach(g => {
          g.style.display = g.dataset.group === group ? '' : 'none';
        });
      });
    });
  }

  // ── People panel ─────────────────────────────────────────────────────────

  _initPeoplePanel() {
    document.getElementById('addPersonBtn')?.addEventListener('click', () => this._showPersonForm(null));
    document.getElementById('savePersonBtn')?.addEventListener('click', () => this._savePersonForm());
    document.getElementById('cancelPersonBtn')?.addEventListener('click', () => this._hidePersonForm());
  }

  /** Re-render the people list from PersonService. */
  _renderPeopleList() {
    const list = document.getElementById('peopleList');
    if (!list) return;
    list.innerHTML = '';

    const personService = FinSimLib.Services.ServiceRegistry.getInstance().personService;
    for (const person of personService.getAll()) {
      const birthYear = person.birthDate instanceof Date
        ? person.birthDate.getFullYear()
        : new Date(person.birthDate).getFullYear();
      const citizenStr = (person.citizen ?? []).join(', ');

      const row = document.createElement('div');
      row.className = 'person-row';
      row.innerHTML = `
        <div class="person-row-info">
          <div class="person-row-name">${person.name || '(unnamed)'}</div>
          <div class="person-row-meta">b.${birthYear} · ${citizenStr}</div>
        </div>
        <button class="person-row-edit" data-id="${person.id}">✎</button>
        <button class="person-row-del"  data-id="${person.id}">✕</button>
      `;
      row.querySelector('.person-row-edit').addEventListener('click', () => this._showPersonForm(person.id));
      row.querySelector('.person-row-del').addEventListener('click', () => this._deletePerson(person.id));
      list.appendChild(row);
    }
  }

  _showPersonForm(id) {
    const form = document.getElementById('personForm');
    if (!form) return;

    document.getElementById('personFormId').value = id ?? '';
    document.getElementById('personFormTitle').textContent = id ? 'Edit Person' : 'New Person';

    if (id) {
      const personService = FinSimLib.Services.ServiceRegistry.getInstance().personService;
      const person = personService.get(id);
      if (person) {
        document.getElementById('personFormName').value = person.name ?? '';
        const bd = person.birthDate instanceof Date ? person.birthDate : new Date(person.birthDate);
        document.getElementById('personFormBirthDate').value = bd.toISOString().slice(0, 10);
        const select = document.getElementById('personFormCitizen');
        Array.from(select.options).forEach(opt => {
          opt.selected = (person.citizen ?? []).includes(opt.value);
        });
        document.getElementById('personFormLifeExp').value = person.lifeExpectancy ?? 90;
        document.getElementById('personFormSS').value = person.socialSecurityMonthly ?? 2800;
      }
    } else {
      document.getElementById('personFormName').value = '';
      document.getElementById('personFormBirthDate').value = '1980-01-01';
      const select = document.getElementById('personFormCitizen');
      Array.from(select.options).forEach(opt => { opt.selected = opt.value === 'US'; });
      document.getElementById('personFormLifeExp').value = '90';
      document.getElementById('personFormSS').value = '2800';
    }

    form.style.display = '';
  }

  _hidePersonForm() {
    const form = document.getElementById('personForm');
    if (form) form.style.display = 'none';
  }

  _savePersonForm() {
    const personService = FinSimLib.Services.ServiceRegistry.getInstance().personService;
    const id        = document.getElementById('personFormId').value || null;
    const name      = document.getElementById('personFormName').value.trim();
    const bdStr     = document.getElementById('personFormBirthDate').value;
    const birthDate = bdStr ? new Date(bdStr) : new Date(Date.UTC(1980, 0, 1));
    const select    = document.getElementById('personFormCitizen');
    const citizen   = Array.from(select.options).filter(o => o.selected).map(o => o.value);
    const lifeExpectancy        = parseInt(document.getElementById('personFormLifeExp').value, 10) || 90;
    const socialSecurityMonthly = parseInt(document.getElementById('personFormSS').value,     10) || 2800;

    if (id) {
      personService.updatePerson(id, { name, birthDate, citizen, lifeExpectancy, socialSecurityMonthly });
    } else {
      personService.createPerson(birthDate, { name, citizen, lifeExpectancy, socialSecurityMonthly });
    }

    this._hidePersonForm();
    this._renderPeopleList();
  }

  _deletePerson(id) {
    const personService = FinSimLib.Services.ServiceRegistry.getInstance().personService;
    personService.deletePerson(id);
    this._renderPeopleList();
  }

  // Override buildScenario to re-render people after scenario loads
  buildScenario() {
    super.buildScenario();
    this._renderPeopleList();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new CustomApp();
  app.initView();
  app.buildScenario();
});
