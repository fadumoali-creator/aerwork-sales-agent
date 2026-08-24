// AerWork Certified Partner CRM — frontend-logiikka.
// Ei build-vaihetta (sama periaate kuin pääsivun index.html:ssä) — Supabase-
// clientti ladataan suoraan ESM-CDN:stä. Kaikki data haetaan Supabasen
// PostgREST-rajapinnasta clientin omalla istunnolla, jolloin Row Level
// Security -policyt (ks. supabase/migrations/0001_crm_schema.sql) päättävät
// mitä rivejä käyttäjä näkee — TÄMÄ TIEDOSTO EI ITSE PÄÄTÄ NÄKYVYYDESTÄ,
// se vain näyttää sen minkä kanta palauttaa.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase;
let session = null;
let profile = null; // { id, organization_id, role, name, email }
let leadStatuses = [];
let companiesCache = [];
let isOwner = false; // vahvistettu palvelimelta (is_owner_super_admin() RPC), ei koskaan pelkkä UI-oletus

const AERWORK_ORG_ID = '00000000-0000-0000-0000-000000000001';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fi-FI');
}
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fi-FI');
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function money(n, currency) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('fi-FI', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------

async function init() {
  let cfg;
  try {
    const resp = await fetch('/.netlify/functions/crm-config');
    cfg = await resp.json();
    if (!resp.ok) throw new Error(cfg.error || 'Konfiguraation haku epäonnistui.');
  } catch (err) {
    showFatal(`CRM:n asetuksia ei saatu ladattua: ${err.message}. Tarkista Netlifyn ympäristömuuttujat (ks. supabase/README.md).`);
    return;
  }

  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  const { data: { session: s } } = await supabase.auth.getSession();
  session = s;
  supabase.auth.onAuthStateChange((_event, s2) => {
    session = s2;
  });

  wireLoginForm();
  wireModals();
  wireSidebarChrome();

  if (session) {
    await afterLogin();
  }
}

function showFatal(msg) {
  document.body.innerHTML = `<div style="padding:40px;max-width:520px;margin:0 auto;font-family:sans-serif;color:#1E2430;">
    <h2 style="color:#1F2D50;">Virhe</h2><p>${msg}</p></div>`;
}

function wireLoginForm() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginError').textContent = '';
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      $('#loginError').textContent = `Kirjautuminen epäonnistui: ${error.message}`;
      return;
    }
    session = data.session;
    await afterLogin();
  });
}

async function afterLogin() {
  const { data: prof, error } = await supabase
    .from('profiles')
    .select('id, organization_id, role, name, email, organizations(name, type)')
    .eq('id', session.user.id)
    .single();

  if (error || !prof) {
    $('#loginError').textContent = 'Kirjautuminen onnistui, mutta käyttäjäprofiilia ei löytynyt. Ota yhteyttä ylläpitoon.';
    await supabase.auth.signOut();
    return;
  }
  profile = prof;

  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoName').textContent = profile.name;
  $('#whoRole').textContent = roleLabel(profile.role);

  const isAdmin = ['super_admin', 'partner_admin'].includes(profile.role);

  // Owner Super Admin -kolmoisportin VIIMEINEN vahvistus tulee aina palvelimelta
  // (RPC kutsuu is_owner_super_admin(), joka tarkistaa roolin JA owner_allowlistin).
  // Pelkkä profile.role==='owner_super_admin' EI koskaan riitä UI:ssakaan -
  // jos allowlist puuttuu, palvelin palauttaa false eikä owner-näkymiä näytetä.
  if (profile.role === 'owner_super_admin') {
    const { data: ownerConfirmed } = await supabase.rpc('is_owner_super_admin');
    isOwner = ownerConfirmed === true;
  }
  if (isOwner) {
    $('#whoRole').classList.add('owner-badge');
  }

  // Sivupalkki rakennetaan VASTA nyt, isAdmin/isOwner-tiedon selvittyä -
  // owner-kohdat eivät koskaan päädy DOM:iin muille käyttäjille (ei pelkkä
  // CSS-piilotus, ks. index.html:n kommentti).
  buildSidebarNav(isAdmin);

  const { data: statuses } = await supabase.from('lead_statuses').select('*').order('sort_order');
  leadStatuses = statuses || [];
  fillStatusFilter();

  $('#logoutBtn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  await loadDashboard();
}

function roleLabel(role) {
  return {
    super_admin: 'AerWork Super Admin',
    partner_admin: 'Partner Admin',
    partner_user: 'Partner User',
    read_only: 'Read Only'
  }[role] || role;
}

// ---------------------------------------------------------------
// Navigation — sivupalkki ryhmiteltynä (CRM / Owner Intelligence /
// Partner Management / Administration). Rakennetaan täysin JS:ssä käyttäjän
// vahvistetun roolin mukaan - "access" määrää pääseekö kohta koskaan DOM:iin:
//   'always' = kaikki kirjautuneet
//   'admin'  = super_admin / partner_admin (ja owner, ks. RLS-periytyminen)
//   'owner'  = VAIN palvelimen vahvistama Owner Super Admin
// ---------------------------------------------------------------

const NAV_CONFIG = [
  { group: null, items: [
    { view: 'dashboard', label: 'Dashboard', icon: '◧', access: 'always' },
    { view: 'companies', label: 'Yritykset', icon: '▤', access: 'always' },
    { view: 'pipeline', label: 'Myyntiputki', icon: '⇄', access: 'always' },
    { view: 'followups', label: 'Follow-upit', icon: '◔', access: 'always' }
  ] },
  { group: 'Owner Intelligence', items: [
    { view: 'owner-overview', label: 'Owner Overview', icon: '★', access: 'owner' },
    { view: 'owner-search', label: 'Company Search', icon: '🔍', access: 'owner' },
    { view: 'owner-decision-makers', label: 'Decision Makers', icon: '☺', access: 'owner' },
    { view: 'owner-jobs', label: 'Open Jobs', icon: '▣', access: 'owner' },
    { view: 'owner-signals', label: 'Opportunity Signals', icon: '⚡', access: 'owner' },
    { view: 'owner-saved-searches', label: 'Saved Searches', icon: '☆', access: 'owner' }
  ] },
  { group: 'Partner Management', items: [
    { view: 'owner-partners', label: 'Partner Performance', icon: '◫', access: 'owner' }
  ] },
  { group: 'Administration', items: [
    { view: 'owner-data-sources', label: 'Data Sources', icon: '⛁', access: 'owner' },
    { view: 'owner-audit', label: 'Audit Log', icon: '≡', access: 'owner' },
    { view: 'users', label: 'Users and Roles', icon: '◎', access: 'admin' },
    { view: 'owner-settings', label: 'Owner Settings', icon: '⚙', access: 'owner' }
  ] }
];

function buildSidebarNav(isAdmin) {
  const container = $('#sidebarGroups');
  container.innerHTML = '';

  NAV_CONFIG.forEach((section) => {
    const visibleItems = section.items.filter((it) => {
      if (it.access === 'always') return true;
      if (it.access === 'admin') return isAdmin || isOwner;
      if (it.access === 'owner') return isOwner;
      return false;
    });
    if (!visibleItems.length) return; // koko ryhmä jää pois DOM:sta jos ei yhtään näkyvää kohtaa

    const groupEl = document.createElement('div');
    groupEl.className = 'sidebar-nav-group';
    if (section.group) {
      const title = document.createElement('div');
      title.className = 'sidebar-group-title';
      title.textContent = section.group;
      groupEl.appendChild(title);
    }
    visibleItems.forEach((it) => {
      const btn = document.createElement('button');
      btn.className = 'sidebar-item';
      btn.dataset.view = it.view;
      btn.innerHTML = `<span class="sidebar-item-icon" aria-hidden="true">${it.icon}</span><span class="sidebar-item-label">${escapeHtml(it.label)}</span>`;
      btn.addEventListener('click', () => {
        switchView(it.view);
        closeMobileNav();
      });
      groupEl.appendChild(btn);
    });
    container.appendChild(groupEl);
  });

  switchView(NAV_CONFIG[0].items[0].view);
}

function wireSidebarChrome() {
  $('#sidebarCollapseBtn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
  });
  $('#mobileNavToggle').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('mobile-open');
    $('#mobileNavScrim').classList.toggle('visible', open);
    $('#mobileNavToggle').setAttribute('aria-expanded', String(open));
  });
  $('#mobileNavScrim').addEventListener('click', closeMobileNav);
}

function closeMobileNav() {
  $('#sidebar').classList.remove('mobile-open');
  $('#mobileNavScrim').classList.remove('visible');
  $('#mobileNavToggle').setAttribute('aria-expanded', 'false');
}

async function switchView(view) {
  $$('.sidebar-item').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));

  if (view === 'dashboard') await loadDashboard();
  if (view === 'companies') await loadCompanies();
  if (view === 'pipeline') await loadPipeline();
  if (view === 'followups') await loadFollowups();
  if (view === 'users') await loadUsers();
  if (view === 'owner-overview') await loadOwnerOverview();
  if (view === 'owner-search') {
    // Hakutila (haku, suodattimet, tulokset) säilyy - haku EI käynnisty automaattisesti
    // uudestaan, koska lastOwnerSearchResults on jo muistissa aiemmasta hausta.
    $$('.view-toggle-btn', $('#ownerSearchViewToggle')).forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === ownerSearchViewMode);
      b.setAttribute('aria-pressed', String(b.dataset.mode === ownerSearchViewMode));
    });
    if (lastOwnerSearchResults.length) {
      $('#ownerSearchMetaRow').classList.remove('hidden');
      renderOwnerSearchResults();
    }
  }
  if (view === 'owner-decision-makers') await loadOwnerDecisionMakers();
  if (view === 'owner-jobs') await loadOwnerJobs();
  if (view === 'owner-signals') await loadOwnerSignals();
  if (view === 'owner-saved-searches') await loadOwnerSavedSearches();
  if (view === 'owner-partners') await loadOwnerPartnerPerformance();
  if (view === 'owner-data-sources') await loadOwnerDataSources();
  if (view === 'owner-audit') await loadOwnerAuditLog();
  if (view === 'owner-settings') await loadOwnerAllowlistView();
}

function wireModals() {
  $$('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.target.closest('.modal-overlay').classList.add('hidden');
    });
  });
  $('#newCompanyBtn').addEventListener('click', openNewCompanyModal);
  $('#companySearch').addEventListener('input', renderCompanyList);
  $('#statusFilter').addEventListener('change', renderCompanyList);
  $('#exportCsvBtn').addEventListener('click', exportCompaniesCsv);
  $('#inviteUserBtn').addEventListener('click', openInviteUserModal);
  $('#ownerSearchBtn').addEventListener('click', runOwnerCompanySearch);
  $('#ownerSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runOwnerCompanySearch(); });
  $('#ownerAuditRefreshBtn').addEventListener('click', loadOwnerAuditLog);
  $('#ownerAuditTableFilter').addEventListener('change', loadOwnerAuditLog);
  $('#ownerDmRefreshBtn').addEventListener('click', loadOwnerDecisionMakers);
  $('#ownerDmStatusFilter').addEventListener('change', loadOwnerDecisionMakers);
  $('#ownerJobRefreshBtn').addEventListener('click', loadOwnerJobs);
  $('#ownerJobStatusFilter').addEventListener('change', loadOwnerJobs);
  $('#ownerNewSavedSearchBtn').addEventListener('click', openSaveSearchModal);
  $('#ownerSavedSearchesBtn').addEventListener('click', () => switchView('owner-saved-searches'));
  wireOwnerSearchChrome();
}

// ---------------------------------------------------------------
// Company Search — hakupalkin/suodattimien/näkymän vaihdon "kromi"
// ---------------------------------------------------------------

let ownerSearchViewMode = localStorage.getItem('aerwork_search_view_mode') || 'cards';
let ownerSearchFilters = { city: '', industry: '', crm: '', dm: '', sort: 'default' };

function wireOwnerSearchChrome() {
  $('#ownerAdvancedFiltersBtn').addEventListener('click', openFiltersDrawer);
  $('#ownerFiltersDrawerClose').addEventListener('click', closeFiltersDrawer);
  $('#ownerFiltersDrawerOverlay').addEventListener('click', closeFiltersDrawer);
  $('#ownerFiltersDrawerApply').addEventListener('click', () => {
    ownerSearchFilters = {
      city: $('#fCity').value.trim(), industry: $('#fIndustry').value.trim(),
      crm: $('#fCrm').value, dm: $('#fDm').value, sort: $('#fSort').value
    };
    closeFiltersDrawer();
    renderOwnerSearchResults();
  });
  $('#ownerClearFiltersBtn').addEventListener('click', () => {
    ownerSearchFilters = { city: '', industry: '', crm: '', dm: '', sort: 'default' };
    $('#fCity').value = ''; $('#fIndustry').value = ''; $('#fCrm').value = ''; $('#fDm').value = ''; $('#fSort').value = 'default';
    renderOwnerSearchResults();
  });
  $$('.view-toggle-btn', $('#ownerSearchViewToggle')).forEach((btn) => {
    btn.addEventListener('click', () => {
      ownerSearchViewMode = btn.dataset.mode;
      localStorage.setItem('aerwork_search_view_mode', ownerSearchViewMode);
      $$('.view-toggle-btn', $('#ownerSearchViewToggle')).forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      renderOwnerSearchResults();
    });
  });
}

function openFiltersDrawer() {
  $('#ownerFiltersDrawer').classList.remove('hidden');
  $('#ownerFiltersDrawerOverlay').classList.remove('hidden');
}
function closeFiltersDrawer() {
  $('#ownerFiltersDrawer').classList.add('hidden');
  $('#ownerFiltersDrawerOverlay').classList.add('hidden');
}

function activeFilterChips() {
  const chips = [];
  if (ownerSearchFilters.city) chips.push({ key: 'city', label: `Kaupunki: ${ownerSearchFilters.city}` });
  if (ownerSearchFilters.industry) chips.push({ key: 'industry', label: `Toimiala: ${ownerSearchFilters.industry}` });
  if (ownerSearchFilters.crm) chips.push({ key: 'crm', label: ownerSearchFilters.crm === 'in_crm' ? 'Jo CRM:ssä' : 'Ei CRM:ssä' });
  if (ownerSearchFilters.dm) chips.push({ key: 'dm', label: ownerSearchFilters.dm === 'found' ? 'Päättäjä löydetty' : 'Päättäjää ei löydetty' });
  return chips;
}

function fillStatusFilter() {
  const sel = $('#statusFilter');
  sel.innerHTML = '<option value="">Kaikki tilat</option>' +
    leadStatuses.map((s) => `<option value="${s.id}">${s.label_fi}</option>`).join('');
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------

async function loadDashboard() {
  const grid = $('#kpiGrid');
  grid.innerHTML = '<p class="muted">Ladataan…</p>';

  const [{ count: totalCompanies }, { data: openFollowups }, { data: deals }] = await Promise.all([
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('followup_tasks').select('due_date').eq('status', 'open'),
    supabase.from('deals').select('mrr, arr, commission_amount').is('archived_at', null)
  ]);

  const today = todayISO();
  const overdueCount = (openFollowups || []).filter((f) => f.due_date < today).length;
  const totalMrr = (deals || []).reduce((s, d) => s + (Number(d.mrr) || 0), 0);
  const totalArr = (deals || []).reduce((s, d) => s + (Number(d.arr) || 0), 0);
  const totalCommission = (deals || []).reduce((s, d) => s + (Number(d.commission_amount) || 0), 0);

  const cards = [
    { label: 'Yrityksiä yhteensä', value: totalCompanies ?? 0 },
    { label: 'Myöhässä olevat follow-upit', value: overdueCount, alert: overdueCount > 0 },
    { label: 'MRR yhteensä', value: money(totalMrr) },
    { label: 'ARR yhteensä', value: money(totalArr) },
    { label: 'Partnerikomissiot', value: money(totalCommission) }
  ];

  grid.innerHTML = cards.map((c) => `
    <div class="kpi-card ${c.alert ? 'alert' : ''}">
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-label">${c.label}</div>
    </div>
  `).join('');

  if (profile.role === 'super_admin') {
    $('#partnerBreakdownWrap').classList.remove('hidden');
    const { data: partners } = await supabase.from('organizations').select('id, name').eq('type', 'certified_partner');
    const { data: allCompanies } = await supabase.from('companies').select('owning_partner_id').is('archived_at', null);
    const rows = (partners || []).map((p) => {
      const count = (allCompanies || []).filter((c) => c.owning_partner_id === p.id).length;
      return `<tr><td>${p.name}</td><td>${count}</td></tr>`;
    }).join('');
    $('#partnerBreakdown').innerHTML = `
      <table class="data"><thead><tr><th>Certified Partner</th><th>Yrityksiä</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="2">Ei partnereita vielä.</td></tr>'}</tbody></table>`;
  }
}

// ---------------------------------------------------------------
// Yritykset
// ---------------------------------------------------------------

async function loadCompanies() {
  const { data, error } = await supabase
    .from('companies')
    .select('*, lead_statuses(key, label_fi, is_won, is_lost)')
    .is('archived_at', null)
    .order('updated_at', { ascending: false });

  if (error) {
    $('#companyList').innerHTML = `<p class="error-text">Yritysten haku epäonnistui: ${error.message}</p>`;
    return;
  }
  companiesCache = data || [];
  renderCompanyList();
}

function renderCompanyList() {
  const q = $('#companySearch').value.trim().toLowerCase();
  const statusFilter = $('#statusFilter').value;
  const today = todayISO();

  const filtered = companiesCache.filter((c) => {
    if (statusFilter && c.status_id !== statusFilter) return false;
    if (!q) return true;
    return [c.name, c.city, c.contact_name, c.industry].filter(Boolean).some((v) => v.toLowerCase().includes(q));
  });

  const list = $('#companyList');
  if (!filtered.length) {
    list.innerHTML = '<p class="muted">Ei yrityksiä hakuehdoilla.</p>';
    return;
  }

  list.innerHTML = filtered.map((c) => {
    const status = c.lead_statuses;
    const pillClass = status ? (status.is_won ? 'won' : status.is_lost ? 'lost' : '') : '';
    return `
      <div class="company-card" data-id="${c.id}">
        <div class="cc-main">
          <div class="cc-name">${escapeHtml(c.name)}</div>
          <div class="cc-sub">${escapeHtml(c.city || '')}${c.city && c.country ? ', ' : ''}${escapeHtml(c.country || '')} · ${escapeHtml(c.contact_name || 'ei kontaktia')}</div>
        </div>
        <div class="cc-meta">
          <div><span class="lbl">Tila</span><span class="status-pill ${pillClass}">${status ? status.label_fi : '—'}</span></div>
          <div><span class="lbl">Viim. yhteydenotto</span>${fmtDate(c.last_contacted_at)}</div>
          <div><span class="lbl">Arvo</span>${money(c.estimated_value, c.currency)}</div>
        </div>
      </div>`;
  }).join('');

  $$('.company-card', list).forEach((card) => {
    card.addEventListener('click', () => openCompanyModal(card.dataset.id));
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function exportCsvRows(rows, headers) {
  const csv = [headers.join(',')].concat(
    rows.map((r) => headers.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aerwork-crm-vienti-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCompaniesCsv() {
  const rows = companiesCache.map((c) => ({
    Yritys: c.name,
    Maa: c.country || '',
    Kaupunki: c.city || '',
    Kontakti: c.contact_name || '',
    Tila: c.lead_statuses ? c.lead_statuses.label_fi : '',
    ViimeisinYhteydenotto: c.last_contacted_at ? fmtDate(c.last_contacted_at) : '',
    ArvioituArvo: c.estimated_value ?? '',
    Valuutta: c.currency || ''
  }));
  exportCsvRows(rows, ['Yritys', 'Maa', 'Kaupunki', 'Kontakti', 'Tila', 'ViimeisinYhteydenotto', 'ArvioituArvo', 'Valuutta']);
}

function openNewCompanyModal() {
  const body = $('#genericModalBody');
  body.innerHTML = `
    <h3>Uusi yritys</h3>
    <div id="dupWarning"></div>
    <form id="newCompanyForm" class="form-grid">
      <label class="full">Yrityksen nimi *<input required name="name" /></label>
      <label>Y-tunnus / rekisterinumero<input name="business_id" /></label>
      <label>Verkkosivu<input name="website" /></label>
      <label>Maa<input name="country" /></label>
      <label>Kaupunki<input name="city" /></label>
      <label>Toimiala<input name="industry" /></label>
      <label>Työntekijämäärä<input type="number" name="employee_count" /></label>
      <label>Yhteyshenkilön nimi<input name="contact_name" /></label>
      <label>Yhteyshenkilön titteli<input name="contact_title" /></label>
      <label>Sähköposti<input type="email" name="contact_email" /></label>
      <label>Puhelin<input name="contact_phone" /></label>
      <label>Liidin lähde<input name="lead_source" /></label>
      <label>Arvioitu arvo<input type="number" name="estimated_value" /></label>
      <label class="full">Muistiinpanot<textarea name="notes" rows="2"></textarea></label>
      <div class="form-actions full">
        <button type="button" class="btn-ghost" data-close-modal>Peruuta</button>
        <button type="submit" class="btn-primary">Tallenna</button>
      </div>
    </form>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

  const form = $('#newCompanyForm', body);
  const dupWarning = $('#dupWarning', body);

  ['name', 'business_id', 'website', 'contact_email', 'contact_phone'].forEach((field) => {
    form[field]?.addEventListener('blur', async () => {
      if (!form.name.value.trim()) return;
      const { data } = await supabase.rpc('fn_check_company_duplicate', {
        p_name: form.name.value,
        p_business_id: form.business_id.value || null,
        p_website: form.website.value || null,
        p_email: form.contact_email.value || null,
        p_phone: form.contact_phone.value || null
      });
      if (data && data.duplicate) {
        dupWarning.innerHTML = `<div class="dup-warning">${escapeHtml(data.message)}</div>`;
      } else {
        dupWarning.innerHTML = '';
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    payload.employee_count = payload.employee_count ? Number(payload.employee_count) : null;
    payload.estimated_value = payload.estimated_value ? Number(payload.estimated_value) : null;
    payload.owning_partner_id = profile.organization_id;
    payload.created_by = profile.id;
    payload.status_id = leadStatuses.find((s) => s.key === 'new_lead')?.id || null;

    const { error } = await supabase.from('companies').insert(payload);
    if (error) {
      alert(`Tallennus epäonnistui: ${error.message}`);
      return;
    }
    $('#genericModal').classList.add('hidden');
    await loadCompanies();
  });

  $('#genericModal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Yrityksen detail + aikajana
// ---------------------------------------------------------------

async function openCompanyModal(id) {
  const body = $('#companyModalBody');
  body.innerHTML = '<p class="muted">Ladataan…</p>';
  $('#companyModal').classList.remove('hidden');

  const [{ data: company, error: companyErr }, { data: activities }, { data: followups }] = await Promise.all([
    supabase.from('companies').select('*, lead_statuses(label_fi)').eq('id', id).single(),
    supabase.from('activities').select('*').eq('company_id', id).order('occurred_at', { ascending: false }),
    supabase.from('followup_tasks').select('*').eq('company_id', id).eq('status', 'open').order('due_date')
  ]);

  if (companyErr || !company) {
    body.innerHTML = `<p class="error-text">Yritystä ei löytynyt tai sinulla ei ole oikeutta nähdä sitä.</p>`;
    return;
  }

  const nextFollowup = (followups || [])[0];

  let ownerSection = { decisionMakers: [], jobPostings: [], opportunityScore: null, partners: [] };
  if (isOwner) {
    const [{ data: dms }, { data: jobs }, { data: score }, { data: partners }] = await Promise.all([
      supabase.from('decision_makers').select('*').eq('company_id', id).order('found_at', { ascending: false }),
      supabase.from('job_postings').select('*').eq('company_id', id).order('first_seen_at', { ascending: false }),
      supabase.from('opportunity_scores').select('*').eq('company_id', id).maybeSingle(),
      supabase.from('organizations').select('id, name').eq('type', 'certified_partner')
    ]);
    ownerSection = { decisionMakers: dms || [], jobPostings: jobs || [], opportunityScore: score || null, partners: partners || [] };
  }

  body.innerHTML = `
    <h3>${escapeHtml(company.name)}</h3>
    <p class="muted small">${escapeHtml(company.city || '')} ${escapeHtml(company.country || '')} · ${escapeHtml(company.industry || 'toimiala tuntematon')}</p>
    <p><span class="status-pill">${company.lead_statuses ? company.lead_statuses.label_fi : '—'}</span></p>
    <div class="form-grid" style="margin-top:6px;">
      <div><span class="lbl">Kontakti</span><br/>${escapeHtml(company.contact_name || '—')} ${company.contact_title ? `(${escapeHtml(company.contact_title)})` : ''}</div>
      <div><span class="lbl">Sähköposti / puhelin</span><br/>${escapeHtml(company.contact_email || '—')} / ${escapeHtml(company.contact_phone || '—')}</div>
      <div><span class="lbl">Arvioitu arvo</span><br/>${money(company.estimated_value, company.currency)}</div>
      <div><span class="lbl">Seuraava follow-up</span><br/>${nextFollowup ? `${fmtDate(nextFollowup.due_date)} — ${escapeHtml(nextFollowup.description || '')}` : 'Ei sovittu'}</div>
    </div>

    <h3 style="margin-top:20px;">Kirjaa yhteydenotto</h3>
    <form id="newActivityForm" class="form-grid">
      <label>Kanava
        <select name="channel">
          <option value="email">Sähköposti</option>
          <option value="call">Puhelu</option>
          <option value="linkedin">LinkedIn</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="meeting">Tapaaminen</option>
          <option value="video">Videopalaveri</option>
          <option value="event">Tapahtuma</option>
          <option value="other">Muu</option>
        </select>
      </label>
      <label>Kiinnostuksen taso
        <select name="interest_level"><option value="">—</option><option value="low">Matala</option><option value="medium">Keskitaso</option><option value="high">Korkea</option></select>
      </label>
      <label class="full">Yhteenveto<textarea name="summary" rows="2" placeholder="Mitä keskusteltiin?"></textarea></label>
      <label class="full">Seuraavat toimenpiteet<input name="next_steps" /></label>
      <label>Seuraava follow-up<input type="date" name="next_followup_date" /></label>
      <div class="form-actions full">
        <button type="submit" class="btn-primary">Tallenna aktiviteetti</button>
      </div>
    </form>

    <h3 style="margin-top:20px;">Aikajana</h3>
    <div class="timeline">
      ${(activities || []).length ? activities.map((a) => `
        <div class="timeline-item">
          <div class="ti-head"><span class="ti-channel">${a.channel}</span><span>${fmtDateTime(a.occurred_at)}</span></div>
          <p class="ti-summary">${escapeHtml(a.summary || a.purpose || '(ei yhteenvetoa)')}</p>
          ${a.next_followup_date ? `<p class="muted small">Seuraava follow-up: ${fmtDate(a.next_followup_date)}</p>` : ''}
        </div>
      `).join('') : '<p class="muted">Ei vielä aktiviteetteja.</p>'}
    </div>

    ${isOwner ? ownerCompanySectionHtml(company, ownerSection) : ''}
  `;

  if (isOwner) wireOwnerCompanySection(id, company, ownerSection);

  $('#newActivityForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (!payload.next_followup_date) delete payload.next_followup_date;

    const { error } = await supabase.from('activities').insert({
      company_id: id,
      partner_id: company.owning_partner_id,
      performed_by: profile.id,
      created_by: profile.id,
      channel: payload.channel,
      interest_level: payload.interest_level || null,
      summary: payload.summary || null,
      next_steps: payload.next_steps || null,
      next_followup_date: payload.next_followup_date || null,
      followup_owner_id: payload.next_followup_date ? profile.id : null
    });
    if (error) {
      alert(`Aktiviteetin tallennus epäonnistui: ${error.message}`);
      return;
    }

    if (payload.next_followup_date) {
      await supabase.from('followup_tasks').insert({
        company_id: id,
        partner_id: company.owning_partner_id,
        owner_id: profile.id,
        due_date: payload.next_followup_date,
        description: payload.next_steps || 'Seuraava yhteydenotto',
        created_by: profile.id
      });
    }

    await openCompanyModal(id);
    await loadCompanies();
  });
}

// ---------------------------------------------------------------
// Myyntiputki (Kanban)
// ---------------------------------------------------------------

async function loadPipeline() {
  const board = $('#kanbanBoard');
  board.innerHTML = '<p class="muted">Ladataan…</p>';

  const { data: companiesData, error } = await supabase
    .from('companies')
    .select('id, name, estimated_value, currency, status_id')
    .is('archived_at', null);

  if (error) {
    board.innerHTML = `<p class="error-text">${error.message}</p>`;
    return;
  }

  board.innerHTML = leadStatuses.map((status) => {
    const cardsInCol = (companiesData || []).filter((c) => c.status_id === status.id);
    return `
      <div class="kanban-col" data-status-id="${status.id}">
        <h4>${status.label_fi} (${cardsInCol.length})</h4>
        ${cardsInCol.map((c) => `
          <div class="kanban-card" draggable="true" data-company-id="${c.id}">
            <div class="kc-name">${escapeHtml(c.name)}</div>
            <div class="kc-meta">${money(c.estimated_value, c.currency)}</div>
          </div>`).join('')}
      </div>`;
  }).join('');

  $$('.kanban-card', board).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.companyId);
    });
  });
  $$('.kanban-col', board).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const companyId = e.dataTransfer.getData('text/plain');
      const newStatusId = col.dataset.statusId;
      // Kirjoitus companies-tauluun laukaisee automaattisesti audit_log-triggerin
      // (trg_audit_companies) — statusmuutos kirjataan siis aina, ei vain UI:ssa.
      const { error: updErr } = await supabase.from('companies').update({ status_id: newStatusId }).eq('id', companyId);
      if (updErr) {
        alert(`Tilan vaihto epäonnistui: ${updErr.message}`);
        return;
      }
      await loadPipeline();
    });
  });
}

// ---------------------------------------------------------------
// Follow-upit
// ---------------------------------------------------------------

async function loadFollowups() {
  const { data, error } = await supabase
    .from('followup_tasks')
    .select('*, companies(name)')
    .eq('status', 'open')
    .order('due_date');

  if (error) {
    $('#fuOverdue').innerHTML = `<p class="error-text">${error.message}</p>`;
    return;
  }

  const today = todayISO();
  const overdue = (data || []).filter((f) => f.due_date < today);
  const dueToday = (data || []).filter((f) => f.due_date === today);
  const upcoming = (data || []).filter((f) => f.due_date > today);

  renderFollowupList('#fuOverdue', overdue);
  renderFollowupList('#fuToday', dueToday);
  renderFollowupList('#fuUpcoming', upcoming);
}

function renderFollowupList(sel, items) {
  const el = $(sel);
  if (!items.length) {
    el.innerHTML = '<p class="muted small">Ei tehtäviä.</p>';
    return;
  }
  el.innerHTML = items.map((f) => `
    <div class="fu-item" data-id="${f.id}" data-company-id="${f.company_id}">
      <div class="fu-company">${escapeHtml(f.companies ? f.companies.name : '—')}</div>
      <div class="fu-due">${fmtDate(f.due_date)} — ${escapeHtml(f.description || '')}</div>
      <button class="btn-ghost small" data-action="done">Merkitse valmiiksi</button>
      <button class="btn-ghost small" data-action="open">Avaa yritys</button>
    </div>`).join('');

  $$('[data-action="open"]', el).forEach((btn) => {
    btn.addEventListener('click', () => openCompanyModal(btn.closest('.fu-item').dataset.companyId));
  });
  $$('[data-action="done"]', el).forEach((btn) => {
    btn.addEventListener('click', () => completeFollowup(btn.closest('.fu-item').dataset));
  });
}

async function completeFollowup(dataset) {
  const { error } = await supabase.from('followup_tasks').update({ status: 'done' }).eq('id', dataset.id);
  if (error) {
    // fn_enforce_followup_chain() kannassa hylkää sulkemisen jos myynti on yhä
    // kesken eikä uutta follow-upia ole sovittu — pyydetään se tässä.
    const wantsNew = confirm(
      `${error.message}\n\nHaluatko sopia uuden follow-up-päivän nyt ja sulkea tämän tehtävän?`
    );
    if (!wantsNew) return;
    const newDate = prompt('Uusi follow-up-päivämäärä (VVVV-KK-PP):', todayISO());
    if (!newDate) return;

    const { data: task } = await supabase.from('followup_tasks').select('*').eq('id', dataset.id).single();
    await supabase.from('followup_tasks').insert({
      company_id: dataset.companyId,
      partner_id: task.partner_id,
      owner_id: profile.id,
      due_date: newDate,
      description: 'Jatko-followup',
      created_by: profile.id
    });
    await supabase.from('followup_tasks').update({ status: 'done' }).eq('id', dataset.id);
  }
  await loadFollowups();
}

// ---------------------------------------------------------------
// Käyttäjät (admin)
// ---------------------------------------------------------------

async function loadUsers() {
  const { data, error } = await supabase.from('profiles').select('id, name, email, role, active').order('name');
  if (error) {
    $('#userList').innerHTML = `<p class="error-text">${error.message}</p>`;
    return;
  }
  $('#userList').innerHTML = `
    <table class="data"><thead><tr><th>Nimi</th><th>Sähköposti</th><th>Rooli</th><th>Tila</th></tr></thead>
    <tbody>${(data || []).map((u) => `
      <tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${roleLabel(u.role)}</td><td>${u.active ? 'Aktiivinen' : 'Ei aktiivinen'}</td></tr>
    `).join('')}</tbody></table>`;
}

function openInviteUserModal() {
  const body = $('#genericModalBody');
  const roleOptions = profile.role === 'super_admin'
    ? ['super_admin', 'partner_admin', 'partner_user', 'read_only']
    : ['partner_user', 'read_only'];

  body.innerHTML = `
    <h3>Kutsu käyttäjä</h3>
    <form id="inviteForm" class="form-grid">
      <label class="full">Sähköposti *<input type="email" required name="email" /></label>
      <label class="full">Nimi *<input required name="name" /></label>
      <label class="full">Rooli
        <select name="role">${roleOptions.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select>
      </label>
      <div class="form-actions full">
        <button type="button" class="btn-ghost" data-close-modal>Peruuta</button>
        <button type="submit" class="btn-primary">Lähetä kutsu</button>
      </div>
    </form>
    <p id="inviteResult" class="muted small"></p>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

  $('#inviteForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());

    const resp = await fetch('/.netlify/functions/crm-invite-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload)
    });
    const result = await resp.json();
    if (!resp.ok) {
      $('#inviteResult').textContent = `Virhe: ${result.error}`;
      $('#inviteResult').classList.add('error-text');
      return;
    }
    $('#inviteResult').textContent = 'Kutsu lähetetty onnistuneesti.';
    await loadUsers();
  });

  $('#genericModal').classList.remove('hidden');
}

// =================================================================
// OWNER SUPER ADMIN — kaikki tämän lohkon toiminnot vaativat isOwner===true
// JA RLS-eristys owner-only-tauluihin (ks. supabase/migrations/0002_owner_super_admin.sql).
// isOwner asetetaan afterLogin():ssä VAIN palvelimen RPC-vastauksen perusteella,
// ei koskaan pelkän profile.role-kentän mukaan.
// =================================================================

// ---------------------------------------------------------------
// Owner Overview
// ---------------------------------------------------------------

async function loadOwnerOverview() {
  const grid = $('#ownerKpiGrid');
  grid.innerHTML = '<p class="muted">Ladataan…</p>';

  const today = todayISO();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [
    { count: totalCompanies }, { count: newLeadCount }, { count: newThisWeek },
    { data: activitiesWeek }, { data: noContact }, { data: overdueFollowups },
    { data: deals }, { data: openJobsHigh }, { data: pendingDMs }, { data: partners }
  ] = await Promise.all([
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null)
      .eq('status_id', leadStatuses.find((s) => s.key === 'new_lead')?.id || '00000000-0000-0000-0000-000000000000'),
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null).gte('created_at', weekAgo),
    supabase.from('activities').select('id', { count: 'exact', head: true }).gte('occurred_at', weekAgo),
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null).is('last_contacted_at', null),
    supabase.from('followup_tasks').select('id', { count: 'exact', head: true }).eq('status', 'open').lt('due_date', today),
    supabase.from('deals').select('mrr, arr, commission_amount, partner_id').is('archived_at', null),
    supabase.from('job_postings').select('company_id').eq('status', 'open'),
    supabase.from('decision_makers').select('id', { count: 'exact', head: true }).eq('review_status', 'pending'),
    supabase.from('organizations').select('id, name').eq('type', 'certified_partner')
  ]);

  const totalMrr = (deals || []).reduce((s, d) => s + (Number(d.mrr) || 0), 0);
  const totalArr = (deals || []).reduce((s, d) => s + (Number(d.arr) || 0), 0);
  const totalCommission = (deals || []).reduce((s, d) => s + (Number(d.commission_amount) || 0), 0);
  const jobCountByCompany = {};
  (openJobsHigh || []).forEach((j) => { if (j.company_id) jobCountByCompany[j.company_id] = (jobCountByCompany[j.company_id] || 0) + 1; });
  const highJobCompanies = Object.values(jobCountByCompany).filter((n) => n >= 5).length;

  const cards = [
    { label: 'Yrityksiä CRM:ssä', value: totalCompanies ?? 0 },
    { label: 'Uudet liidit', value: newLeadCount ?? 0 },
    { label: 'Uudet yritykset (7pv)', value: newThisWeek ?? 0 },
    { label: 'Yhteydenotot (7pv)', value: (activitiesWeek || []).length },
    { label: 'Ei koskaan kontaktoitu', value: noContact?.length ?? 0, alert: (noContact?.length ?? 0) > 0 },
    { label: 'Myöhässä olevat follow-upit', value: overdueFollowups?.length ?? 0, alert: (overdueFollowups?.length ?? 0) > 0 },
    { label: 'Yrityksiä ≥5 avoimella työpaikalla', value: highJobCompanies },
    { label: 'Vahvistamattomat päättäjät', value: pendingDMs?.length ?? 0 },
    { label: 'AerWork MRR', value: money(totalMrr) },
    { label: 'AerWork ARR', value: money(totalArr) },
    { label: 'Partnerikomissiot (avoin)', value: money(totalCommission) }
  ];

  grid.innerHTML = cards.map((c) => `
    <div class="kpi-card ${c.alert ? 'alert' : ''}">
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-label">${c.label}</div>
    </div>`).join('');

  const { data: allCompanies } = await supabase.from('companies').select('owning_partner_id').is('archived_at', null);
  const rows = (partners || []).map((p) => {
    const count = (allCompanies || []).filter((c) => c.owning_partner_id === p.id).length;
    const partnerDeals = (deals || []).filter((d) => d.partner_id === p.id);
    const mrr = partnerDeals.reduce((s, d) => s + (Number(d.mrr) || 0), 0);
    return `<tr><td>${escapeHtml(p.name)}</td><td>${count}</td><td>${money(mrr)}</td></tr>`;
  }).join('');
  $('#ownerPartnerActivity').innerHTML = `
    <table class="data"><thead><tr><th>Certified Partner</th><th>Yrityksiä</th><th>MRR</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">Ei partnereita vielä.</td></tr>'}</tbody></table>`;
}

// ---------------------------------------------------------------
// Company Search (PRH/YTJ) + Lisää CRM:ään
// ---------------------------------------------------------------

let lastOwnerSearchResults = [];
let lastOwnerSearchMeta = null;

const BUSINESS_ID_PATTERN = /^\d{6,7}-\d$/;

async function runOwnerCompanySearch() {
  const input = $('#ownerSearchInput').value.trim();
  const resultsEl = $('#ownerSearchResults');
  $('#ownerSearchMetaRow').classList.add('hidden');

  if (!input) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Anna hakusana</div>Hae yrityksen nimellä tai Y-tunnuksella (esim. 1234567-8).</div>';
    return;
  }
  const isBusinessId = BUSINESS_ID_PATTERN.test(input);

  // Skeleton-lataustila - ei tyhjä sivu haun ajan.
  resultsEl.innerHTML = Array.from({ length: 4 }, () => `
    <div class="search-card"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-card"></div></div>`).join('');

  let resp, result;
  try {
    resp = await fetch('/.netlify/functions/owner-prh-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(isBusinessId ? { business_id: input } : { name: input })
    });
    result = await resp.json();
  } catch (err) {
    resultsEl.innerHTML = `<div class="empty-state"><div class="es-title">Haku epäonnistui</div>${escapeHtml(err.message)}. Tarkista verkkoyhteys ja yritä uudestaan. Ei vaikuta muuhun CRM-dataan.</div>`;
    return;
  }
  if (!resp.ok) {
    resultsEl.innerHTML = `<div class="empty-state"><div class="es-title">Haku epäonnistui</div>${escapeHtml(result.error || 'Tuntematon virhe.')} Ei vaikuta muuhun CRM-dataan - kokeile hetken päästä uudestaan.</div>`;
    return;
  }
  if (!result.results.length) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Ei tuloksia</div>Tarkista kirjoitusasu tai kokeile Y-tunnuksella (muoto 1234567-8).</div>';
    return;
  }

  lastOwnerSearchResults = result.results;
  lastOwnerSearchMeta = result;
  $('#ownerSearchMetaRow').classList.remove('hidden');
  renderOwnerSearchResults();
}

function filteredSortedOwnerSearchResults() {
  const f = ownerSearchFilters;
  let rows = lastOwnerSearchResults.filter((r) => {
    const address = (r.addresses || [])[0] || {};
    const city = address.postOffices && address.postOffices[0] ? address.postOffices[0].city : '';
    if (f.city) {
      // Tukee useampaa kaupunkia pilkulla erotettuna, OR-logiikalla
      // (esim. "Helsinki, Espoo" täsmää kumpaankin).
      const wanted = f.city.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
      const cityLower = (city || '').toLowerCase();
      if (wanted.length && !wanted.some((w) => cityLower.includes(w))) return false;
    }
    if (f.industry && !(r.main_business_line || '').toLowerCase().includes(f.industry.toLowerCase())) return false;
    if (f.crm === 'in_crm' && !r.in_crm) return false;
    if (f.crm === 'not_in_crm' && r.in_crm) return false;
    if (f.dm === 'found' && !r.decision_maker) return false;
    if (f.dm === 'not_found' && r.decision_maker) return false;
    return true;
  });
  if (f.sort === 'dm_first') rows = [...rows].sort((a, b) => (b.decision_maker ? 1 : 0) - (a.decision_maker ? 1 : 0));
  else if (f.sort === 'newest_registration') rows = [...rows].sort((a, b) => new Date(b.registration_date || 0) - new Date(a.registration_date || 0));
  return rows;
}

function renderOwnerSearchResults() {
  const resultsEl = $('#ownerSearchResults');
  if (!lastOwnerSearchResults.length) return;

  const rows = filteredSortedOwnerSearchResults();

  $('#ownerSearchResultCount').textContent = `${rows.length} tulos${rows.length === 1 ? '' : 'ta'}`;
  const chips = activeFilterChips();
  $('#ownerSearchChips').innerHTML = chips.map((c) => `
    <span class="filter-chip">${escapeHtml(c.label)}<button type="button" data-chip-remove="${c.key}" aria-label="Poista suodatin">×</button></span>`).join('');
  $('#ownerClearFiltersBtn').classList.toggle('hidden', chips.length === 0);
  $$('[data-chip-remove]', $('#ownerSearchChips')).forEach((btn) => {
    btn.addEventListener('click', () => {
      ownerSearchFilters[btn.dataset.chipRemove] = '';
      renderOwnerSearchResults();
    });
  });

  if (!rows.length) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Ei tuloksia näillä suodattimilla</div>Kokeile tyhjentää suodattimet.</div>';
    return;
  }

  resultsEl.innerHTML = ownerSearchViewMode === 'table' ? searchTableHtml(rows) : rows.map((r) => searchCardHtml(r)).join('');
  wireSearchResultActions(resultsEl);
}

function growthIndicatorHtml() {
  // Ei koskaan keksitä lukua - kasvun suunta näytetään aina "Ei tietoa" kunnes
  // oikea taloustietolähde on liitetty (ks. data_sources: financial_data).
  return `<span class="growth-indicator growth-unknown"><span class="gi-icon">–</span>Ei tietoa</span>`;
}

function decisionMakerBlockHtml(dm) {
  if (!dm) return '<div class="muted">Päättäjää ei ole vielä löydetty</div>';
  const statusLabel = dm.review_status === 'approved' ? 'Hyväksytty' : dm.review_status === 'rejected' ? 'Hylätty' : 'Vahvistamaton';
  return `
    <div><strong>${escapeHtml(dm.name)}</strong>${dm.title ? `, ${escapeHtml(dm.title)}` : ''}</div>
    <div class="muted small">
      <span class="source-tag ${dm.confidence === 'ai_paattely' ? 'ai-analysis' : ''}">${dm.confidence === 'ai_paattely' ? 'AI-analyysi' : statusLabel}</span>
      ${dm.source_url ? ` · <a href="${escapeHtml(dm.source_url)}" target="_blank" rel="noopener">Lähde ↗</a>` : ''}
    </div>
    <div class="muted small">tarkistettu ${fmtDate(dm.found_at)}</div>`;
}

function searchCardHtml(r) {
  const idx = lastOwnerSearchResults.indexOf(r);
  const address = (r.addresses || [])[0] || {};
  const city = address.postOffices && address.postOffices[0] ? address.postOffices[0].city : null;

  return `
    <div class="search-card" data-idx="${idx}">
      <div class="cc-name">${escapeHtml(r.name || '(nimi tuntematon)')} ${r.in_crm ? '<span class="status-pill won">Jo CRM:ssä</span>' : '<span class="status-pill neutral">Ei CRM:ssä</span>'}</div>
      <div class="search-card-grid">
        <div class="search-card-section">
          <h5>Yritys</h5>
          <div>Y-tunnus: ${escapeHtml(r.business_id || '—')}</div>
          <div>${escapeHtml(r.company_form || '—')} · ${escapeHtml(city || 'Kaupunki tuntematon')}</div>
          <div>${escapeHtml(r.main_business_line || 'Toimiala tuntematon')}</div>
          <div class="source-tag official" style="margin-top:6px;">PRH/YTJ · tarkistettu ${fmtDate(lastOwnerSearchMeta.fetched_at)}</div>
        </div>
        <div class="search-card-section">
          <h5>Talous ja kasvu</h5>
          <div>Liikevaihto: <span class="muted">Ei saatavilla</span></div>
          <div>${growthIndicatorHtml()}</div>
          <div class="muted small" style="margin-top:6px;">🔒 Vaatii maksullisen taloustietolähteen</div>
        </div>
        <div class="search-card-section">
          <h5>Päättäjä</h5>
          ${decisionMakerBlockHtml(r.decision_maker)}
        </div>
      </div>
      <div class="search-card-actions">
        ${r.in_crm
          ? `<button class="btn-primary small" data-action="open-crm" data-idx="${idx}">Avaa CRM:ssä</button>`
          : `<button class="btn-primary small" data-action="add-to-crm" data-idx="${idx}">Lisää CRM:ään</button>`}
        <div class="dropdown">
          <button class="btn-ghost small" data-action="toggle-more" data-idx="${idx}">⋯ Lisää</button>
          <div class="dropdown-menu hidden" data-more-menu="${idx}">
            ${r.in_crm ? `<button data-action="open-company" data-idx="${idx}">Näytä yritys</button>` : ''}
            <button data-action="find-dm" data-idx="${idx}">${r.in_crm ? 'Etsi päättäjä' : 'Lisää CRM:ään ja etsi päättäjä'}</button>
            ${r.business_id ? `<button data-action="open-source" data-idx="${idx}">Avaa lähde (PRH-data)</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

function searchTableHtml(rows) {
  return `
    <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Yritys</th><th>Y-tunnus</th><th>Kaupunki</th><th>Toimiala</th><th>CRM</th><th>Päättäjä</th><th></th></tr></thead>
      <tbody>${rows.map((r) => {
        const idx = lastOwnerSearchResults.indexOf(r);
        const address = (r.addresses || [])[0] || {};
        const city = address.postOffices && address.postOffices[0] ? address.postOffices[0].city : '—';
        return `<tr>
          <td>${escapeHtml(r.name || '—')}</td>
          <td>${escapeHtml(r.business_id || '—')}</td>
          <td>${escapeHtml(city)}</td>
          <td>${escapeHtml(r.main_business_line || '—')}</td>
          <td>${r.in_crm ? '<span class="status-pill won">Jo CRM:ssä</span>' : '<span class="status-pill neutral">Ei CRM:ssä</span>'}</td>
          <td>${r.decision_maker ? escapeHtml(r.decision_maker.name) : '<span class="muted">Ei löydetty</span>'}</td>
          <td>${r.in_crm
            ? `<button class="btn-ghost small" data-action="open-crm" data-idx="${idx}">Avaa</button>`
            : `<button class="btn-primary small" data-action="add-to-crm" data-idx="${idx}">Lisää CRM:ään</button>`}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    </div>`;
}

function wireSearchResultActions(resultsEl) {
  $$('[data-action="add-to-crm"]', resultsEl).forEach((btn) => {
    btn.addEventListener('click', () => addExternalResultToCrm(lastOwnerSearchResults[Number(btn.dataset.idx)]));
  });
  $$('[data-action="open-crm"], [data-action="open-company"]', resultsEl).forEach((btn) => {
    btn.addEventListener('click', () => openCompanyModal(lastOwnerSearchResults[Number(btn.dataset.idx)].existing_company_id));
  });
  $$('[data-action="find-dm"]', resultsEl).forEach((btn) => {
    btn.addEventListener('click', () => findDecisionMakerForSearchResult(Number(btn.dataset.idx), btn));
  });
  $$('[data-action="open-source"]', resultsEl).forEach((btn) => {
    const r = lastOwnerSearchResults[Number(btn.dataset.idx)];
    btn.addEventListener('click', () => window.open(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=${encodeURIComponent(r.business_id)}`, '_blank', 'noopener'));
  });
  $$('[data-action="toggle-more"]', resultsEl).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = resultsEl.querySelector(`[data-more-menu="${btn.dataset.idx}"]`);
      const wasHidden = menu.classList.contains('hidden');
      $$('.dropdown-menu', resultsEl).forEach((m) => m.classList.add('hidden'));
      if (wasHidden) menu.classList.remove('hidden');
    });
  });
  document.addEventListener('click', () => $$('.dropdown-menu', resultsEl).forEach((m) => m.classList.add('hidden')), { once: true });
}

async function findDecisionMakerForSearchResult(idx, btn) {
  const record = lastOwnerSearchResults[idx];
  let companyId = record.existing_company_id;

  if (!companyId) {
    // "Lisää CRM:ään ja etsi päättäjä" - lisätään ensin (duplikaattitarkistuksella).
    companyId = await addExternalResultToCrm(record, { skipOpen: true });
    if (!companyId) return;
    record.existing_company_id = companyId;
    record.in_crm = true;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Etsitään…';
  try {
    const resp = await fetch('/.netlify/functions/owner-find-decision-maker', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ company_id: companyId, company_name: record.name })
    });
    const result = await resp.json();
    if (!resp.ok) { alert(`Haku epäonnistui: ${result.error}`); return; }
    if (!result.found) { alert(`Päättäjää ei löytynyt: ${result.reasoning || 'ei riittävän luotettavaa tietoa.'}`); return; }
    record.decision_maker = result.decision_maker;
    renderOwnerSearchResults();
  } catch (err) {
    alert(`Haku epäonnistui: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function addExternalResultToCrm(record, opts = {}) {
  const address = (record.addresses || [])[0] || {};

  // Duplikaattitarkistus AINA ennen lisäystä (kohta 10) - uudelleenkäyttää samaa
  // fn_check_company_duplicate-funktiota kuin tavallinen "Uusi yritys" -lomake.
  const { data: dup } = await supabase.rpc('fn_check_company_duplicate', {
    p_name: record.name, p_business_id: record.business_id, p_website: null, p_email: null, p_phone: null
  });

  if (dup && dup.duplicate) {
    const proceed = confirm(
      `${dup.message}${dup.owner_partner_name ? `\nOmistava partneri: ${dup.owner_partner_name}` : ''}\n\n` +
      `Yritystä ei lisätä uudelleen. Avataanko olemassa oleva yritys?`
    );
    if (proceed && dup.company_id) await openCompanyModal(dup.company_id);
    return null;
  }

  const { data: newCompany, error } = await supabase.from('companies').insert({
    owning_partner_id: AERWORK_ORG_ID, // "pitää liidin vain AerWorkin omassa hallinnassa" kunnes osoitetaan partnerille
    name: record.name,
    business_id: record.business_id,
    country: 'FI',
    city: address.postOffices && address.postOffices[0] ? address.postOffices[0].city : null,
    industry: record.main_business_line || null,
    status_id: leadStatuses.find((s) => s.key === 'new_lead')?.id || null,
    currency: 'EUR',
    lead_source: 'owner_company_search',
    created_by: profile.id
  }).select().single();

  if (error) {
    alert(`Lisäys epäonnistui: ${error.message}`);
    return null;
  }

  // Säilytetään alkuperäinen lähdetieto pysyvästi, ei koskaan ylikirjoiteta.
  await supabase.from('external_company_records').insert({
    company_id: newCompany.id,
    business_id: record.business_id,
    name: record.name,
    source: 'prh_ytj',
    raw_payload: record.raw || record,
    confidence: 'virallinen_rekisteri',
    fetched_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
    created_by: profile.id
  });

  if (!opts.skipOpen) {
    alert(`"${record.name}" lisätty CRM:ään.`);
    await openCompanyModal(newCompany.id);
  }
  return newCompany.id;
}

// ---------------------------------------------------------------
// Yrityksen 360°-näkymän Owner-osio: Päättäjät, Avoimet työpaikat,
// Opportunity Score, Liidin osoittaminen partnerille
// ---------------------------------------------------------------

// Peilaa crm/lib/opportunityScore.js:n (tests/opportunity-score.test.js testattu)
// painotuksia. PIDÄ SYNKASSA jos jompaakumpaa muutetaan - selaimessa ei voida
// suoraan require()-tuoda CommonJS-moduulia ilman build-vaihetta (sama rajoitus
// koskee crm/lib/calc.js:ää, jota app.js ei myöskään tuo suoraan).
function calcOpportunityScoreClient(company, jobPostings, decisionMakers) {
  if (company.has_active_contract) {
    return { score: 0, tier: 'matala', signals: [], missing_data: [], recommended_product: null,
      recommended_action: 'Ei uutta myyntitoimenpidettä - asiakas on jo aktiivinen.',
      rationale: 'Yrityksellä on voimassa oleva sopimus.' };
  }
  const signals = []; const missing = [];
  const openJobs = (jobPostings || []).filter((j) => j.status === 'open');
  if (openJobs.length >= 3) signals.push({ signal: 'multiple_open_jobs', points: 15, evidence: `${openJobs.length} avointa työpaikkaa.` });
  const hrJobs = openJobs.filter((j) => j.is_hr_related || j.is_payroll_related || j.is_recruiting_related);
  if (hrJobs.length) signals.push({ signal: 'hr_payroll_ops_hiring', points: 15, evidence: `${hrJobs.length} HR/palkanlaskenta/rekrytointi-roolia.` });
  const shiftJobs = openJobs.filter((j) => j.is_shift_work);
  if (shiftJobs.length) signals.push({ signal: 'shift_heavy', points: 15, evidence: `${shiftJobs.length} vuorotyötehtävää.` });
  const industry = (company.industry || '').toLowerCase();
  const targetKw = ['hoiva', 'terveys', 'henkilöstö', 'henkilostopalvelu', 'staffing', 'ravintola', 'hotelli', 'majoitus', 'siivous', 'turvallisuus', 'vartiointi', 'palvelu', 'kotihoito', 'hoitokoti'];
  if (targetKw.some((k) => industry.includes(k))) signals.push({ signal: 'target_industry', points: 15, evidence: `Toimiala "${company.industry}".` });
  else if (!company.industry) missing.push('industry_unknown');
  if ((decisionMakers || []).length) signals.push({ signal: 'decision_maker_found', points: 5, evidence: `${decisionMakers.length} päättäjä löydetty.` });
  else missing.push('no_decision_maker_found');
  if (!openJobs.length && !(jobPostings || []).length) missing.push('open_jobs_not_checked');

  const score = Math.max(0, Math.min(100, signals.reduce((s, x) => s + x.points, 0)));
  const tier = score >= 60 ? 'korkea' : score >= 30 ? 'keskitaso' : 'matala';
  const recommendedProduct = shiftJobs.length ? 'AerShift (AI-työvuorosuunnittelu)'
    : hrJobs.some((j) => j.is_recruiting_related) ? 'AI-rekrytoija'
    : hrJobs.length ? 'Kevyt HR / AerPay' : null;

  return {
    score, tier, signals, missing_data: missing, recommended_product: recommendedProduct,
    recommended_action: tier === 'korkea' ? 'Priorisoi ensikontakti.' : tier === 'keskitaso' ? 'Lisää seurantalistalle.' : 'Ei kiireellinen.',
    rationale: `${signals.length} havaittua signaalia (${score}/100). AI-avusteinen ANALYYSI, ei vahvistettu tosiasia - ${missing.length} tietoa puuttuu.`
  };
}

function ownerCompanySectionHtml(company, section) {
  const { decisionMakers, jobPostings, opportunityScore, partners } = section;
  return `
    <h3 style="margin-top:24px;">🔒 Owner: Päättäjät</h3>
    <div class="timeline">
      ${decisionMakers.length ? decisionMakers.map((d) => `
        <div class="timeline-item">
          <div class="ti-head"><span class="ti-channel">${escapeHtml(d.title || '')}</span><span>${d.review_status}</span></div>
          <p class="ti-summary">${escapeHtml(d.name)} ${d.linkedin_url ? `— <a href="${escapeHtml(d.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</p>
          <p class="muted small">Lähde: ${escapeHtml(d.source)} (${d.confidence}) — löydetty ${fmtDate(d.found_at)}</p>
          ${d.review_status === 'pending' ? `
            <button class="btn-ghost small" data-dm-action="approve" data-dm-id="${d.id}">Hyväksy</button>
            <button class="btn-ghost small" data-dm-action="reject" data-dm-id="${d.id}">Hylkää</button>` : ''}
        </div>`).join('') : '<p class="muted small">Ei vielä löydettyjä päättäjiä.</p>'}
    </div>
    <form id="newDecisionMakerForm" class="form-grid" style="margin-top:10px;">
      <label>Nimi *<input required name="name" /></label>
      <label>Titteli<input name="title" /></label>
      <label>LinkedIn-URL<input name="linkedin_url" /></label>
      <label>Lähde *<input required name="source" placeholder="esim. yrityksen verkkosivu" /></label>
      <label>Luotettavuus
        <select name="confidence">
          <option value="yrityksen_oma_julkaisu">Yrityksen oma julkaisu</option>
          <option value="muu_julkinen">Muu julkinen lähde</option>
          <option value="vahvistettu_lisenssi">Vahvistettu lisensoitu lähde</option>
          <option value="ai_paattely">AI:n päättelemä</option>
          <option value="vahvistamaton">Vahvistamaton</option>
        </select>
      </label>
      <div class="form-actions full"><button type="submit" class="btn-ghost small">+ Lisää päättäjä</button></div>
    </form>

    <h3 style="margin-top:24px;">🔒 Owner: Avoimet työpaikat</h3>
    <div class="timeline">
      ${jobPostings.length ? jobPostings.map((j) => `
        <div class="timeline-item">
          <div class="ti-head"><span class="ti-channel">${j.status}</span><span>${fmtDate(j.published_at)}</span></div>
          <p class="ti-summary"><a href="${escapeHtml(j.source_url)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a> — ${escapeHtml(j.location || '')}</p>
          <p class="muted small">${j.is_shift_work ? 'Vuorotyö · ' : ''}${j.is_hr_related ? 'HR · ' : ''}${j.is_payroll_related ? 'Palkanlaskenta · ' : ''}${j.is_recruiting_related ? 'Rekrytointi · ' : ''}lähde: ${escapeHtml(j.source)}</p>
        </div>`).join('') : '<p class="muted small">Ei havaittuja avoimia työpaikkoja.</p>'}
    </div>
    <form id="newJobPostingForm" class="form-grid" style="margin-top:10px;">
      <label class="full">Tehtävänimike *<input required name="title" /></label>
      <label>Sijainti<input name="location" /></label>
      <label>Alkuperäinen URL *<input required type="url" name="source_url" /></label>
      <label>Lähde *<input required name="source" placeholder="esim. yrityksen rekrytointisivu" /></label>
      <label><input type="checkbox" name="is_shift_work" /> Vuorotyö</label>
      <label><input type="checkbox" name="is_hr_related" /> HR-tehtävä</label>
      <label><input type="checkbox" name="is_payroll_related" /> Palkanlaskenta</label>
      <label><input type="checkbox" name="is_recruiting_related" /> Rekrytointi</label>
      <div class="form-actions full"><button type="submit" class="btn-ghost small">+ Lisää työpaikka</button></div>
    </form>

    <h3 style="margin-top:24px;">🔒 Owner: AerWork Opportunity Score</h3>
    <div id="ownerOpportunityScoreBox">
      ${opportunityScore ? renderOpportunityScore(opportunityScore) : '<p class="muted small">Ei vielä laskettu.</p>'}
    </div>
    <button type="button" class="btn-ghost small" id="calcOpportunityScoreBtn">Laske Opportunity Score</button>

    <h3 style="margin-top:24px;">🔒 Owner: Osoita Certified Partnerille</h3>
    <form id="assignLeadForm" class="form-grid">
      <label class="full">Certified Partner
        <select name="assigned_to_partner_id">
          <option value="">— valitse —</option>
          ${partners.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </label>
      <label>Prioriteetti
        <select name="priority"><option value="A">A</option><option value="B">B</option><option value="C">C</option></select>
      </label>
      <label>Omistajuus päättyy<input type="date" name="ownership_expires_at" /></label>
      <label class="full">Ohje/viesti partnerille<textarea name="instructions" rows="2"></textarea></label>
      <div class="form-actions full"><button type="submit" class="btn-primary">Osoita liidi</button></div>
    </form>`;
}

function renderOpportunityScore(s) {
  return `
    <div class="kpi-card ${s.tier === 'korkea' ? 'alert' : ''}" style="max-width:220px;">
      <div class="kpi-value">${s.score}/100</div>
      <div class="kpi-label">Potentiaali: ${s.tier}</div>
    </div>
    <ul style="margin:10px 0;padding-left:18px;font-size:13px;">
      ${(s.signals || []).map((sig) => `<li>+${sig.points} ${escapeHtml(sig.evidence)}</li>`).join('')}
    </ul>
    <p class="muted small">Puuttuvat tiedot: ${(s.missing_data || []).length ? s.missing_data.join(', ') : 'ei'}</p>
    ${s.recommended_product ? `<p><strong>Suositeltu tuote:</strong> ${escapeHtml(s.recommended_product)}</p>` : ''}
    <p class="muted small">${escapeHtml(s.rationale || '')}</p>
    <p class="muted small" style="font-style:italic;">⚠️ AI-avusteinen analyysi, ei vahvistettu tosiasia.</p>`;
}

function wireOwnerCompanySection(companyId, company, section) {
  const body = $('#companyModalBody');

  $('#newDecisionMakerForm', body)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    const { error } = await supabase.from('decision_makers').insert({
      company_id: companyId, name: payload.name, title: payload.title || null,
      linkedin_url: payload.linkedin_url || null, source: payload.source, confidence: payload.confidence,
      review_status: 'pending', created_by: profile.id
    });
    if (error) { alert(`Lisäys epäonnistui: ${error.message}`); return; }
    await openCompanyModal(companyId);
  });

  $$('[data-dm-action]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.dmAction === 'approve' ? 'approved' : 'rejected';
      await supabase.from('decision_makers').update({ review_status: status, reviewed_by: profile.id, reviewed_at: new Date().toISOString() }).eq('id', btn.dataset.dmId);
      await openCompanyModal(companyId);
    });
  });

  $('#newJobPostingForm', body)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    const postingKey = `${companyId}::${payload.title}::${payload.location || ''}::${payload.source}`.toLowerCase();
    const { error } = await supabase.from('job_postings').upsert({
      company_id: companyId, title: payload.title, location: payload.location || null,
      source: payload.source, source_url: payload.source_url, posting_key: postingKey,
      is_shift_work: fd.get('is_shift_work') === 'on', is_hr_related: fd.get('is_hr_related') === 'on',
      is_payroll_related: fd.get('is_payroll_related') === 'on', is_recruiting_related: fd.get('is_recruiting_related') === 'on',
      last_checked_at: new Date().toISOString()
    }, { onConflict: 'posting_key' });
    if (error) { alert(`Lisäys epäonnistui: ${error.message}`); return; }
    await openCompanyModal(companyId);
  });

  $('#calcOpportunityScoreBtn', body)?.addEventListener('click', async () => {
    const result = calcOpportunityScoreClient(company, section.jobPostings, section.decisionMakers);
    const { error } = await supabase.from('opportunity_scores').upsert({
      company_id: companyId, score: result.score, tier: result.tier, signals: result.signals,
      missing_data: result.missing_data, recommended_product: result.recommended_product,
      recommended_action: result.recommended_action, rationale: result.rationale,
      calculated_by: profile.id, calculated_at: new Date().toISOString()
    }, { onConflict: 'company_id' });
    if (error) { alert(`Tallennus epäonnistui: ${error.message}`); return; }
    $('#ownerOpportunityScoreBox', body).innerHTML = renderOpportunityScore(result);
  });

  $('#assignLeadForm', body)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (!payload.assigned_to_partner_id) { alert('Valitse Certified Partner.'); return; }
    const { error } = await supabase.from('lead_assignments').insert({
      company_id: companyId, assigned_to_partner_id: payload.assigned_to_partner_id,
      priority: payload.priority, ownership_expires_at: payload.ownership_expires_at || null,
      instructions: payload.instructions || null, visibility_scope: 'assigned_partner', assigned_by: profile.id
    });
    if (error) { alert(`Osoitus epäonnistui: ${error.message}`); return; }
    alert('Liidi osoitettu partnerille.');
    e.target.reset();
  });
}

// ---------------------------------------------------------------
// Audit Log (Owner näkee koko historian, ei vain oman partnerin)
// ---------------------------------------------------------------

async function loadOwnerAuditLog() {
  const tableFilter = $('#ownerAuditTableFilter').value;
  let query = supabase.from('audit_log').select('*').order('changed_at', { ascending: false }).limit(200);
  if (tableFilter) query = query.eq('table_name', tableFilter);

  const { data, error } = await query;
  if (error) {
    $('#ownerAuditLog').innerHTML = `<p class="error-text">${error.message}</p>`;
    return;
  }
  $('#ownerAuditLog').innerHTML = `
    <table class="data">
      <thead><tr><th>Aika</th><th>Taulu</th><th>Toiminto</th><th>Kenttä</th><th>Vanha</th><th>Uusi</th></tr></thead>
      <tbody>${(data || []).map((r) => `
        <tr>
          <td>${fmtDateTime(r.changed_at)}</td><td>${escapeHtml(r.table_name)}</td><td>${escapeHtml(r.action)}</td>
          <td>${escapeHtml(r.field_name || '')}</td>
          <td>${escapeHtml((r.old_value || '').toString().slice(0, 40))}</td>
          <td>${escapeHtml((r.new_value || '').toString().slice(0, 40))}</td>
        </tr>`).join('') || '<tr><td colspan="6">Ei tapahtumia.</td></tr>'}</tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Decision Makers (yli koko verkoston)
// ---------------------------------------------------------------

async function loadOwnerDecisionMakers() {
  const el = $('#ownerDecisionMakersList');
  const statusFilter = $('#ownerDmStatusFilter').value;
  el.innerHTML = '<p class="muted">Ladataan…</p>';

  let query = supabase.from('decision_makers').select('*, companies(name)').order('found_at', { ascending: false }).limit(300);
  if (statusFilter) query = query.eq('review_status', statusFilter);
  const { data, error } = await query;
  if (error) { el.innerHTML = `<p class="error-text">${error.message}</p>`; return; }

  el.innerHTML = `
    <table class="data">
      <thead><tr><th>Nimi</th><th>Titteli</th><th>Yritys</th><th>Lähde</th><th>Luotettavuus</th><th>Tila</th><th></th></tr></thead>
      <tbody>${(data || []).map((d) => `
        <tr>
          <td>${escapeHtml(d.name)}${d.linkedin_url ? ` <a href="${escapeHtml(d.linkedin_url)}" target="_blank" rel="noopener">↗</a>` : ''}</td>
          <td>${escapeHtml(d.title || '—')}</td>
          <td>${d.companies ? `<a href="#" data-open-company="${d.company_id}">${escapeHtml(d.companies.name)}</a>` : '—'}</td>
          <td>${escapeHtml(d.source)}</td>
          <td>${d.confidence}</td>
          <td>${d.review_status}</td>
          <td>${d.review_status === 'pending' ? `
            <button class="btn-ghost small" data-dm-list-action="approve" data-dm-id="${d.id}">Hyväksy</button>
            <button class="btn-ghost small" data-dm-list-action="reject" data-dm-id="${d.id}">Hylkää</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7">Ei päättäjiä.</td></tr>'}</tbody>
    </table>`;

  $$('[data-open-company]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCompanyModal(a.dataset.openCompany); }));
  $$('[data-dm-list-action]', el).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.dmListAction === 'approve' ? 'approved' : 'rejected';
      await supabase.from('decision_makers').update({ review_status: status, reviewed_by: profile.id, reviewed_at: new Date().toISOString() }).eq('id', btn.dataset.dmId);
      await loadOwnerDecisionMakers();
    });
  });
}

// ---------------------------------------------------------------
// Open Jobs (yli koko verkoston)
// ---------------------------------------------------------------

async function loadOwnerJobs() {
  const el = $('#ownerJobsList');
  const statusFilter = $('#ownerJobStatusFilter').value;
  el.innerHTML = '<p class="muted">Ladataan…</p>';

  let query = supabase.from('job_postings').select('*, companies(name)').order('first_seen_at', { ascending: false }).limit(300);
  if (statusFilter) query = query.eq('status', statusFilter);
  const { data, error } = await query;
  if (error) { el.innerHTML = `<p class="error-text">${error.message}</p>`; return; }

  el.innerHTML = `
    <table class="data">
      <thead><tr><th>Tehtävä</th><th>Yritys</th><th>Sijainti</th><th>Merkinnät</th><th>Lähde</th><th>Tila</th><th>Havaittu</th></tr></thead>
      <tbody>${(data || []).map((j) => `
        <tr>
          <td><a href="${escapeHtml(j.source_url)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a></td>
          <td>${j.companies ? `<a href="#" data-open-company="${j.company_id}">${escapeHtml(j.companies.name)}</a>` : '—'}</td>
          <td>${escapeHtml(j.location || '—')}</td>
          <td>${[j.is_shift_work && 'Vuorotyö', j.is_hr_related && 'HR', j.is_payroll_related && 'Palkka', j.is_recruiting_related && 'Rekry'].filter(Boolean).join(', ') || '—'}</td>
          <td>${escapeHtml(j.source)}</td>
          <td>${j.status}</td>
          <td>${fmtDate(j.first_seen_at)}</td>
        </tr>`).join('') || '<tr><td colspan="7">Ei avoimia työpaikkoja.</td></tr>'}</tbody>
    </table>`;

  $$('[data-open-company]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCompanyModal(a.dataset.openCompany); }));
}

// ---------------------------------------------------------------
// Opportunity Signals (yli koko verkoston, korkeimmasta matalimpaan)
// ---------------------------------------------------------------

async function loadOwnerSignals() {
  const el = $('#ownerSignalsList');
  el.innerHTML = '<p class="muted">Ladataan…</p>';

  const { data, error } = await supabase
    .from('opportunity_scores')
    .select('*, companies(name, status_id)')
    .order('score', { ascending: false })
    .limit(200);
  if (error) { el.innerHTML = `<p class="error-text">${error.message}</p>`; return; }

  el.innerHTML = `
    <table class="data">
      <thead><tr><th>Yritys</th><th>Score</th><th>Potentiaali</th><th>Suositeltu tuote</th><th>Suositeltu toimenpide</th><th>Laskettu</th></tr></thead>
      <tbody>${(data || []).map((s) => `
        <tr>
          <td>${s.companies ? `<a href="#" data-open-company="${s.company_id}">${escapeHtml(s.companies.name)}</a>` : '—'}</td>
          <td>${s.score}/100</td>
          <td><span class="status-pill ${s.tier === 'korkea' ? 'won' : ''}">${s.tier}</span></td>
          <td>${escapeHtml(s.recommended_product || '—')}</td>
          <td>${escapeHtml(s.recommended_action || '—')}</td>
          <td>${fmtDate(s.calculated_at)}</td>
        </tr>`).join('') || '<tr><td colspan="6">Ei vielä pisteytettyjä yrityksiä. Laske Opportunity Score yrityksen 360°-näkymästä.</td></tr>'}</tbody>
    </table>
    <p class="muted small" style="margin-top:10px;font-style:italic;">⚠️ AI-avusteinen analyysi, ei vahvistettu tosiasia.</p>`;

  $$('[data-open-company]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCompanyModal(a.dataset.openCompany); }));
}

// ---------------------------------------------------------------
// Saved Searches (rakenne valmiina tulevaa ajastusta varten, ei ajastinta MVP:ssä)
// ---------------------------------------------------------------

async function loadOwnerSavedSearches() {
  const el = $('#ownerSavedSearchesList');
  el.innerHTML = '<p class="muted">Ladataan…</p>';
  const { data, error } = await supabase.from('saved_searches').select('*').order('created_at', { ascending: false });
  if (error) { el.innerHTML = `<p class="error-text">${error.message}</p>`; return; }

  el.innerHTML = `
    <table class="data">
      <thead><tr><th>Nimi</th><th>Kuvaus</th><th>Hakuehdot</th><th>Luotu</th><th>Viimeksi ajettu</th></tr></thead>
      <tbody>${(data || []).map((s) => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.description || '—')}</td>
          <td><code>${escapeHtml(JSON.stringify(s.filters))}</code></td>
          <td>${fmtDate(s.created_at)}</td>
          <td>${s.last_run_at ? fmtDateTime(s.last_run_at) : 'Ei vielä ajettu'}</td>
        </tr>`).join('') || '<tr><td colspan="5">Ei tallennettuja hakuja vielä.</td></tr>'}</tbody>
    </table>`;
}

function openSaveSearchModal() {
  const body = $('#genericModalBody');
  const currentInput = $('#ownerSearchInput')?.value.trim() || '';

  body.innerHTML = `
    <h3>Tallenna haku</h3>
    <p class="muted small">Rakenne on valmiina automaattiseen ajastukseen myöhemmin - ei käynnisty automaattisesti ilman erillistä hyväksyntääsi.</p>
    <form id="saveSearchForm" class="form-grid">
      <label class="full">Haun nimi *<input required name="name" placeholder="esim. Suomalaiset kotihoitoyritykset" /></label>
      <label class="full">Kuvaus<textarea name="description" rows="2"></textarea></label>
      <label class="full">Nykyiset hakuehdot (muokattavissa JSON:na)
        <textarea name="filters" rows="2">${escapeHtml(JSON.stringify({ query: currentInput, ...ownerSearchFilters }))}</textarea>
      </label>
      <div class="form-actions full">
        <button type="button" class="btn-ghost" data-close-modal>Peruuta</button>
        <button type="submit" class="btn-primary">Tallenna</button>
      </div>
    </form>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

  $('#saveSearchForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    let filters;
    try { filters = JSON.parse(fd.get('filters')); } catch { filters = {}; }
    const { error } = await supabase.from('saved_searches').insert({
      name: fd.get('name'), description: fd.get('description') || null, filters, created_by: profile.id
    });
    if (error) { alert(`Tallennus epäonnistui: ${error.message}`); return; }
    $('#genericModal').classList.add('hidden');
    await loadOwnerSavedSearches();
  });

  $('#genericModal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Partner Performance
// ---------------------------------------------------------------

async function loadOwnerPartnerPerformance() {
  const el = $('#ownerPartnerPerformance');
  el.innerHTML = '<p class="muted">Ladataan…</p>';

  const [{ data: partners }, { data: companies }, { data: deals }] = await Promise.all([
    supabase.from('organizations').select('id, name, created_at').eq('type', 'certified_partner'),
    supabase.from('companies').select('id, owning_partner_id').is('archived_at', null),
    supabase.from('deals').select('partner_id, mrr, arr, commission_amount, status_id').is('archived_at', null)
  ]);

  el.innerHTML = `
    <table class="data">
      <thead><tr><th>Certified Partner</th><th>Yrityksiä</th><th>Aktiivisia sopimuksia</th><th>MRR</th><th>ARR</th><th>Komissiot (avoin)</th></tr></thead>
      <tbody>${(partners || []).map((p) => {
        const partnerCompanies = (companies || []).filter((c) => c.owning_partner_id === p.id);
        const partnerDeals = (deals || []).filter((d) => d.partner_id === p.id);
        const mrr = partnerDeals.reduce((s, d) => s + (Number(d.mrr) || 0), 0);
        const arr = partnerDeals.reduce((s, d) => s + (Number(d.arr) || 0), 0);
        const commission = partnerDeals.reduce((s, d) => s + (Number(d.commission_amount) || 0), 0);
        return `<tr>
          <td>${escapeHtml(p.name)}</td><td>${partnerCompanies.length}</td><td>${partnerDeals.length}</td>
          <td>${money(mrr)}</td><td>${money(arr)}</td><td>${money(commission)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="6">Ei Certified Partnereita vielä.</td></tr>'}</tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Data Sources & Integrations
// ---------------------------------------------------------------

const DATA_SOURCE_STATUS_LABEL = {
  available: 'Saatavilla', not_available: 'Ei saatavilla', requires_integration: 'Vaatii integraation',
  requires_paid_source: 'Vaatii maksullisen tietolähteen', check_failed: 'Tarkistus epäonnistui', not_configured: 'Ei määritetty'
};

async function loadOwnerDataSources() {
  const listEl = $('#ownerDataSourcesList');
  const usageEl = $('#ownerIntegrationUsage');
  listEl.innerHTML = '<p class="muted">Ladataan…</p>';

  const [{ data: sources, error }, { data: usage }] = await Promise.all([
    supabase.from('data_sources').select('*').order('label'),
    supabase.from('integration_usage_log').select('*').order('created_at', { ascending: false }).limit(50)
  ]);
  if (error) { listEl.innerHTML = `<p class="error-text">${error.message}</p>`; return; }

  const statusPillClass = (s) => (s === 'available' ? 'won' : s === 'not_available' || s === 'check_failed' ? 'lost' : '');
  listEl.innerHTML = `
    <table class="data">
      <thead><tr><th>Tietolähde</th><th>Tila</th><th>Vaatii lisenssin</th><th>Huomiot</th></tr></thead>
      <tbody>${(sources || []).map((s) => `
        <tr>
          <td>${escapeHtml(s.label)}</td>
          <td><span class="status-pill ${statusPillClass(s.status)}">${DATA_SOURCE_STATUS_LABEL[s.status] || s.status}</span></td>
          <td>${s.requires_license ? 'Kyllä' : 'Ei'}</td>
          <td class="muted small">${escapeHtml(s.notes || '')}</td>
        </tr>`).join('')}</tbody>
    </table>`;

  usageEl.innerHTML = `
    <table class="data">
      <thead><tr><th>Aika</th><th>Lähde</th><th>Toiminto</th><th>Tulokset</th><th>Onnistui</th></tr></thead>
      <tbody>${(usage || []).map((u) => `
        <tr>
          <td>${fmtDateTime(u.created_at)}</td><td>${escapeHtml(u.data_source_key)}</td><td>${escapeHtml(u.action)}</td>
          <td>${u.result_count ?? '—'}</td><td>${u.succeeded ? '✅' : `❌ ${escapeHtml(u.error_message || '')}`}</td>
        </tr>`).join('') || '<tr><td colspan="5">Ei vielä käyttöä.</td></tr>'}</tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Owner Settings — vain luku, kirjoitus tarkoituksella VAIN SQL:stä
// ---------------------------------------------------------------

async function loadOwnerAllowlistView() {
  const el = $('#ownerAllowlistView');
  el.innerHTML = '<p class="muted">Ladataan…</p>';
  const { data, error } = await supabase.from('owner_allowlist').select('*').order('approved_at');
  if (error) { el.innerHTML = `<p class="error-text">${error.message}</p>`; return; }

  // owner_allowlist.user_id viittaa auth.users(id):hen, ei suoraan profiles-tauluun
  // (ei PostgREST-upotettavaa vierasavainta) - haetaan nimet erikseen ja yhdistetään.
  const userIds = (data || []).map((o) => o.user_id).filter(Boolean);
  const { data: profs } = userIds.length
    ? await supabase.from('profiles').select('id, name').in('id', userIds)
    : { data: [] };
  const nameById = Object.fromEntries((profs || []).map((p) => [p.id, p.name]));

  el.innerHTML = `
    <table class="data">
      <thead><tr><th>Sähköposti</th><th>Nimi</th><th>Tila</th><th>Hyväksytty</th></tr></thead>
      <tbody>${(data || []).map((o) => `
        <tr><td>${escapeHtml(o.email)}</td><td>${escapeHtml(nameById[o.user_id] || '—')}</td>
        <td>${o.active ? 'Aktiivinen' : 'Ei aktiivinen'}</td><td>${fmtDate(o.approved_at)}</td></tr>`).join('')}</tbody>
    </table>`;
}

init();
