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
    this._initAccountsPanel();
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

  // ── Accounts panel ──────────────────────────────────────────────────────────

  _initAccountsPanel() {
    document.getElementById('addAccountBtn')?.addEventListener('click', () => this._showAccountForm(null));
    document.getElementById('saveAccountBtn')?.addEventListener('click', () => this._saveAccountForm());
    document.getElementById('cancelAccountBtn')?.addEventListener('click', () => this._hideAccountForm());
    document.getElementById('accountFormType')?.addEventListener('change', () => this._onAccountTypeChange());
  }

  _isInvestmentType(type) {
    return ['brokerage', '401k', 'roth', 'ira', 'super'].includes(type);
  }

  _isFixedCountryType(type) {
    return ['401k', 'roth', 'ira', 'super'].includes(type);
  }

  _onAccountTypeChange() {
    const type = document.getElementById('accountFormType')?.value;
    document.getElementById('accountFormInvestmentFields').style.display =
      this._isInvestmentType(type) ? '' : 'none';
    document.getElementById('accountFormCountryRow').style.display =
      this._isFixedCountryType(type) ? 'none' : '';
  }

  _renderAccountsList() {
    const list = document.getElementById('accountsList');
    if (!list) return;
    list.innerHTML = '';

    const accountService = FinSimLib.Services.ServiceRegistry.getInstance().accountService;
    for (const account of accountService.getAll()) {
      const typeLabel = account.type ?? '?';
      const sym = account.currency?.symbol ?? '';
      const balStr = sym
        ? `${sym}${account.balance.toLocaleString()}`
        : account.balance.toLocaleString();

      const row = document.createElement('div');
      row.className = 'person-row';
      row.innerHTML = `
        <div class="person-row-info">
          <div class="person-row-name">${account.name || '(unnamed)'}</div>
          <div class="person-row-meta">${typeLabel} · ${balStr}</div>
        </div>
        <button class="person-row-edit" data-id="${account.id}">✎</button>
        <button class="person-row-del"  data-id="${account.id}">✕</button>
      `;
      row.querySelector('.person-row-edit').addEventListener('click', () => this._showAccountForm(account.id));
      row.querySelector('.person-row-del').addEventListener('click', () => this._deleteAccount(account.id));
      list.appendChild(row);
    }
  }

  _showAccountForm(id) {
    const form = document.getElementById('accountForm');
    if (!form) return;

    document.getElementById('accountFormId').value = id ?? '';
    document.getElementById('accountFormTitle').textContent = id ? 'Edit Account' : 'New Account';

    const typeSelect  = document.getElementById('accountFormType');
    if (id) {
      const accountService = FinSimLib.Services.ServiceRegistry.getInstance().accountService;
      const account = accountService.get(id);
      if (account) {
        document.getElementById('accountFormName').value      = account.name ?? '';
        document.getElementById('accountFormBalance').value   = account.balance ?? 0;
        document.getElementById('accountFormMinBalance').value = account.minimumBalance ?? 0;
        document.getElementById('accountFormDrawdown').value  = account.drawdownPriority ?? '';
        document.getElementById('accountFormOwnership').value = account.ownershipType ?? 'sole';
        document.getElementById('accountFormCountry').value   = account.country ?? 'US';
        // Show type as read-only text for edits
        typeSelect.disabled = true;
        // Investment fields
        const isInv = this._isInvestmentType(account.type);
        document.getElementById('accountFormInvestmentFields').style.display = isInv ? '' : 'none';
        if (isInv) {
          document.getElementById('accountFormContribBasis').value = account.contributionBasis ?? 0;
          document.getElementById('accountFormEarnBasis').value    = account.earningsBasis ?? 0;
        }
        document.getElementById('accountFormCountryRow').style.display =
          this._isFixedCountryType(account.type) ? 'none' : '';
      }
    } else {
      document.getElementById('accountFormName').value      = '';
      document.getElementById('accountFormBalance').value   = '0';
      document.getElementById('accountFormMinBalance').value = '0';
      document.getElementById('accountFormDrawdown').value  = '';
      document.getElementById('accountFormOwnership').value = 'sole';
      document.getElementById('accountFormCountry').value   = 'US';
      document.getElementById('accountFormContribBasis').value = '0';
      document.getElementById('accountFormEarnBasis').value    = '0';
      typeSelect.value = 'checking';
      typeSelect.disabled = false;
      document.getElementById('accountFormInvestmentFields').style.display = 'none';
      document.getElementById('accountFormCountryRow').style.display = '';
    }

    this._populateOwnerSelect(id
      ? FinSimLib.Services.ServiceRegistry.getInstance().accountService.get(id)?.ownerId
      : null);
    form.style.display = '';
  }

  _populateOwnerSelect(currentOwnerId) {
    const sel = document.getElementById('accountFormOwnerId');
    if (!sel) return;
    sel.innerHTML = '<option value="">— none —</option>';
    const personService = FinSimLib.Services.ServiceRegistry.getInstance().personService;
    for (const person of personService.getAll()) {
      const opt = document.createElement('option');
      opt.value = person.id;
      opt.textContent = person.name || person.id;
      if (person.id === currentOwnerId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  _hideAccountForm() {
    const form = document.getElementById('accountForm');
    if (form) form.style.display = 'none';
  }

  _saveAccountForm() {
    const accountService = FinSimLib.Services.ServiceRegistry.getInstance().accountService;
    const id             = document.getElementById('accountFormId').value || null;
    const name           = document.getElementById('accountFormName').value.trim();
    const balance        = parseFloat(document.getElementById('accountFormBalance').value) || 0;
    const minBalance     = parseFloat(document.getElementById('accountFormMinBalance').value) || 0;
    const drawdownRaw    = document.getElementById('accountFormDrawdown').value.trim();
    const drawdownPriority = drawdownRaw === '' ? null : parseInt(drawdownRaw, 10);
    const ownershipType  = document.getElementById('accountFormOwnership').value;
    const ownerId        = document.getElementById('accountFormOwnerId').value || null;
    const country        = document.getElementById('accountFormCountry').value || 'US';
    const currency       = country === 'AU' ? FinSimLib.Finance.AUD : FinSimLib.Finance.USD;
    const contribBasis   = parseFloat(document.getElementById('accountFormContribBasis').value) || 0;
    const earnBasis      = parseFloat(document.getElementById('accountFormEarnBasis').value) || 0;

    if (id) {
      const account  = accountService.get(id);
      const changes  = { name, balance, minimumBalance: minBalance, drawdownPriority, ownershipType, ownerId };
      if (!this._isFixedCountryType(account?.type)) {
        changes.country  = country;
        changes.currency = currency;
      }
      if (this._isInvestmentType(account?.type)) {
        changes.contributionBasis = contribBasis;
        changes.earningsBasis     = earnBasis;
      }
      accountService.updateAccount(id, changes);
    } else {
      const type = document.getElementById('accountFormType').value;
      const AB   = FinSimLib.Finance.AccountBuilder;
      let builder;
      switch (type) {
        case 'checking':  builder = AB.checking();       break;
        case 'savings':   builder = AB.savings();        break;
        case 'brokerage': builder = AB.brokerage();      break;
        case '401k':      builder = AB.fourOhOneK();     break;
        case 'roth':      builder = AB.roth();           break;
        case 'ira':       builder = AB.traditionalIRA(); break;
        case 'super':     builder = AB.super();          break;
        default:          builder = AB.checking();       break;
      }
      builder
        .name(name)
        .initialValue(balance)
        .minimumBalance(minBalance)
        .drawdownPriority(drawdownPriority)
        .ownershipType(ownershipType)
        .ownerId(ownerId);
      if (!this._isFixedCountryType(type)) {
        builder.country(country).currency(currency);
      }
      if (this._isInvestmentType(type)) {
        builder.contributionBasis(contribBasis).earningsBasis(earnBasis);
      }
      accountService.createAccount(builder.build());
    }

    this._hideAccountForm();
    this._renderAccountsList();
  }

  _deleteAccount(id) {
    const accountService = FinSimLib.Services.ServiceRegistry.getInstance().accountService;
    accountService.deleteAccount(id);
    this._renderAccountsList();
  }

  // Override buildScenario to re-render people and accounts after scenario loads
  buildScenario() {
    super.buildScenario();
    this._renderPeopleList();
    this._renderAccountsList();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new CustomApp();
  app.initView();
  app.buildScenario();
});
