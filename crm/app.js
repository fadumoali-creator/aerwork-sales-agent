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
let pipelineStages = []; // pipeline_stages, sort_order-järjestyksessä (ks. 0005_opportunities_pipeline.sql)
let productsCache = [];
let orgProfilesCache = []; // profiilit vastuuhenkilövalintoihin (oma partneri, tai kaikki jos owner)
let opportunitiesCache = [];
let pipelineOnlyMine = false;
let pipelineViewMode = localStorage.getItem('aerwork_pipeline_view_mode') || 'kanban';

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

// Toast-ilmoitukset selaimen alert()-kutsujen sijaan (vaatimuksen kohta 11:
// "älä käytä selaimen oletusalertteja"). #toastHost on jo index.html:ssä.
function showToast(message, type) {
  const host = $('#toastHost');
  const el = document.createElement('div');
  el.className = `toast ${type || ''}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// Vahvistusikkuna vaarallisille toiminnoille (kohta 8: nimi, toimenpide,
// vaikutus, tarvittaessa syykenttä, selkeä vahvistuspainike, punainen
// merkintä). Palauttaa Promisen jonka resolve-arvo on syy-tekstikentän
// sisältö (tai tyhjä merkkijono) jos vahvistettiin, tai null jos peruttiin.
function confirmDangerousAction({ title, body, confirmLabel, needsReason }) {
  return new Promise((resolve) => {
    const modalBody = $('#genericModalBody');
    modalBody.innerHTML = `
      <h3>⚠ ${escapeHtml(title)}</h3>
      <p class="muted">${body}</p>
      ${needsReason ? '<label class="full" style="display:block; margin-top:10px;">Syy (valinnainen)<textarea id="confirmReasonInput" rows="2" style="width:100%; margin-top:4px;"></textarea></label>' : ''}
      <div class="form-actions">
        <button type="button" class="btn-ghost" id="confirmCancelBtn">Peruuta</button>
        <button type="button" class="btn-danger" id="confirmOkBtn">${escapeHtml(confirmLabel)}</button>
      </div>`;
    $('#genericModal').classList.remove('hidden');
    const cleanup = (result) => { $('#genericModal').classList.add('hidden'); resolve(result); };
    $('#confirmCancelBtn', modalBody).addEventListener('click', () => cleanup(null));
    $('#confirmOkBtn', modalBody).addEventListener('click', () => {
      const reason = needsReason ? ($('#confirmReasonInput', modalBody).value || '').trim() : '';
      cleanup(reason);
    });
  });
}

// PRH/YTJ v3 -rajapinnan address.postOffices on lista SAMAN paikkakunnan
// nimestä eri kielillä (languageCode: 1 = suomi, 2 = ruotsi, 3 = englanti),
// ei useita eri paikkakuntia. Otettiin aiemmin virheellisesti vain
// postOffices[0] — järjestys ei ole taattu, joten kaupunki saattoi näkyä
// esim. ruotsiksi ("Helsingfors") eikä täsmännyt suomenkieliseen hakuun.
// Tämä valitsee aina ensisijaisesti suomenkielisen nimen.
function resolvePrhCity(address) {
  const list = (address && address.postOffices) || [];
  if (!list.length) return null;
  const fi = list.find((po) => String(po.languageCode) === '1');
  return (fi || list[0]).city || null;
}

// Kauppalehden yrityssivu Y-tunnuksen perusteella (esim.
// https://www.kauppalehti.fi/yritykset/yritys/01845830 Y-tunnukselle
// 0184583-0). Vain linkki käyttäjälle avattavaksi — ei mitään automaattista
// hakua/skreippausta Kauppalehden sivulta (heidän yritystietonsa on oma
// kaupallinen tuotteensa, ks. myös lukittu liikevaihtosuodatin).
function kauppalehtiCompanyUrl(businessId) {
  if (!businessId) return null;
  const digitsOnly = String(businessId).replace(/[^0-9]/g, '');
  if (!digitsOnly) return null;
  return `https://www.kauppalehti.fi/yritykset/yritys/${digitsOnly}`;
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

  const { data: stages } = await supabase.from('pipeline_stages').select('*').eq('active', true).order('sort_order');
  pipelineStages = stages || [];
  const { data: prods } = await supabase.from('products').select('*').eq('active', true).order('name');
  productsCache = prods || [];

  $('#logoutBtn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  await loadDashboard();
}

// Suomenkieliset roolinimet käyttöliittymään (kohta 11: "älä näytä
// käyttäjälle teknistä tekstiä kuten owner_super_admin"). Tietokannan
// roolikoodeja EI nimetä uudelleen - ks. 0008_user_management.sql:n
// alkukommentti - vain nämä näyttönimet muuttuvat.
const ROLE_LABELS = {
  owner_super_admin: 'Omistaja / pääylläpitäjä',
  super_admin: 'AerWork-ylläpitäjä',
  partner_admin: 'Partnerin pääkäyttäjä',
  partner_user: 'Myyjä',
  read_only: 'Katselija'
};
function roleLabel(role) { return ROLE_LABELS[role] || role; }

// Kumppanitasot (Kumppanuus- ja Revenue Share -sopimus, Liite A). Kiinteät
// sopimusarvot - Strategic-tason luvut ovat aina partnerikohtaisia (ks.
// organizations.partner_custom_*), ei siis omaa riviä tässä.
const PARTNER_TIER_LABELS = {
  introduction: 'Introduction Partner',
  sales: 'Sales Partner',
  certified: 'Certified AerWork Partner',
  strategic: 'Strategic Partner'
};
const PARTNER_TIER_DEFAULTS = {
  introduction: { subscription_rate: 10, ai_credit_rate: 5, period_months: 12 },
  sales: { subscription_rate: 15, ai_credit_rate: 7.5, period_months: 18 },
  certified: { subscription_rate: 20, ai_credit_rate: 10, period_months: 24 }
};
function partnerTierLabel(level) { return level ? (PARTNER_TIER_LABELS[level] || level) : 'Ei asetettu (oletus: Introduction)'; }

// Roolihierarkia (peilaa netlify/functions/_crm-shared.js:n ROLE_RANK/
// canManageRole - kaksoiskappale, sama periaate kuin muissakin client-puolen
// esikatseluissa: PALVELIN on aina lopullinen totuus, tämä ohjaa vain mitä
// UI näyttää valittavaksi).
function rolesManageableBy(callerRole, isOwner) {
  if (isOwner) return ['super_admin', 'partner_admin', 'partner_user', 'read_only'];
  if (callerRole === 'super_admin') return ['super_admin', 'partner_admin', 'partner_user', 'read_only'];
  if (callerRole === 'partner_admin') return ['partner_user', 'read_only'];
  return [];
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
  $('#claimFilter').addEventListener('change', renderCompanyList);
  $('#exportCsvBtn').addEventListener('click', exportCompaniesCsv);
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
  wirePipelineChrome();
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
    const prevCity = ownerSearchFilters.city;
    ownerSearchFilters = {
      city: $('#fCity').value.trim(), industry: $('#fIndustry').value.trim(),
      crm: $('#fCrm').value, dm: $('#fDm').value, sort: $('#fSort').value
    };
    closeFiltersDrawer();
    // Kaupunki haetaan PRH:sta itse (location-parametri), ei vain
    // jälkikäteissuodateta - jos kaupunki muuttui, pitää hakea uudestaan.
    // Muut suotimet (toimiala/CRM/päättäjä/järjestys) suodattavat jo
    // haettua tulosjoukkoa, eivät vaadi uutta hakua.
    if (ownerSearchFilters.city !== prevCity) runOwnerCompanySearch();
    else renderOwnerSearchResults();
  });
  $('#ownerClearFiltersBtn').addEventListener('click', () => {
    const prevCity = ownerSearchFilters.city;
    ownerSearchFilters = { city: '', industry: '', crm: '', dm: '', sort: 'default' };
    $('#fCity').value = ''; $('#fIndustry').value = ''; $('#fCrm').value = ''; $('#fDm').value = ''; $('#fSort').value = 'default';
    if (prevCity) runOwnerCompanySearch();
    else renderOwnerSearchResults();
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

  const [{ count: totalCompanies }, { data: openFollowups }, { data: deals }, { data: claimCompanies }, { data: ledgerRows }] = await Promise.all([
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('followup_tasks').select('due_date').eq('status', 'open'),
    supabase.from('deals').select('mrr, arr').is('archived_at', null),
    supabase.from('companies').select('claim_status, protection_expires_at, protection_started_at, converted_to_customer_at').is('archived_at', null),
    // Partnerikomissiot lasketaan commission_ledger-taulusta (kuukausittain,
    // vain lukitun provisiokauden sisällä syntyneet rivit) - EI enää
    // deals.commission_amount:sta, joka oli kertaluontoinen koko sopimuksen
    // arvo eikä huomioinut kumppanitasoa/provisiokautta/AI-credit-osuutta.
    // RLS rajaa automaattisesti: partneri näkee vain omat rivinsä, Owner kaikki.
    supabase.from('commission_ledger').select('commission_amount')
  ]);

  const today = todayISO();
  const overdueCount = (openFollowups || []).filter((f) => f.due_date < today).length;
  const totalMrr = (deals || []).reduce((s, d) => s + (Number(d.mrr) || 0), 0);
  const totalArr = (deals || []).reduce((s, d) => s + (Number(d.arr) || 0), 0);
  const totalCommission = (ledgerRows || []).reduce((s, r) => s + (Number(r.commission_amount) || 0), 0);

  // 90 päivän liidisuojan mittarit (kohta 15).
  const claims = claimCompanies || [];
  const activeClaims = claims.filter((c) => c.claim_status === 'active' && c.protection_expires_at && new Date(c.protection_expires_at) > new Date());
  const expiringSoon = activeClaims.filter((c) => (new Date(c.protection_expires_at) - Date.now()) < 14 * 86400000);
  const expiredClaims = claims.filter((c) => c.claim_status === 'expired');
  const convertedClaims = claims.filter((c) => c.claim_status === 'converted_to_customer');
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const addedThisMonth = claims.filter((c) => c.protection_started_at && new Date(c.protection_started_at) >= monthStart).length;
  const conversionRate = claims.length ? Math.round((convertedClaims.length / claims.length) * 100) : 0;

  const cards = [
    { label: 'Yrityksiä yhteensä', value: totalCompanies ?? 0 },
    { label: 'Myöhässä olevat follow-upit', value: overdueCount, alert: overdueCount > 0 },
    { label: 'MRR yhteensä', value: money(totalMrr) },
    { label: 'ARR yhteensä', value: money(totalArr) },
    { label: 'Partnerikomissiot', value: money(totalCommission), hint: 'Vain aktiivisen provisiokauden sisällä syntynyt, kuukausittain laskettu provisio (ks. Kumppanuus- ja Revenue Share -sopimus).' },
    { label: 'Aktiiviset suojatut liidit', value: activeClaims.length },
    { label: 'Tässä kuussa lisätyt liidit', value: addedThisMonth },
    { label: 'Pian vanhenevat liidit (<14 pv)', value: expiringSoon.length, alert: expiringSoon.length > 0 },
    { label: 'Vanhentuneet liidit', value: expiredClaims.length },
    { label: 'Asiakkaiksi muutetut', value: convertedClaims.length },
    { label: 'Liidi → asiakas -konversio', value: `${conversionRate}%` }
  ];

  grid.innerHTML = cards.map((c) => `
    <div class="kpi-card ${c.alert ? 'alert' : ''}" ${c.hint ? `title="${c.hint}"` : ''}>
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
  const claimFilter = $('#claimFilter').value;

  const filtered = companiesCache.filter((c) => {
    if (statusFilter && c.status_id !== statusFilter) return false;
    if (claimFilter) {
      const claim = claimDisplayStatusClient(c);
      if (claimFilter === 'active' && claim.key !== 'active') return false;
      if (claimFilter === 'expiring_30' && !(claim.key === 'active' && claim.daysRemaining < 30)) return false;
      if (claimFilter === 'expiring_14' && !(claim.key === 'active' && claim.daysRemaining < 14)) return false;
      if (claimFilter === 'expiring_7' && !(claim.key === 'active' && claim.daysRemaining < 7)) return false;
      if (claimFilter === 'expired' && claim.key !== 'expired') return false;
      if (claimFilter === 'converted_to_customer' && claim.key !== 'converted_to_customer') return false;
      if (claimFilter === 'under_review' && claim.key !== 'under_review') return false;
    }
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
    const claim = claimDisplayStatusClient(c);
    return `
      <div class="company-card" data-id="${c.id}">
        <div class="cc-main">
          <div class="cc-name">${escapeHtml(c.name)}</div>
          <div class="cc-sub">${escapeHtml(c.city || '')}${c.city && c.country ? ', ' : ''}${escapeHtml(c.country || '')} · ${escapeHtml(c.contact_name || 'ei kontaktia')}</div>
        </div>
        <div class="cc-meta">
          <div><span class="lbl">Tila</span><span class="status-pill ${pillClass}">${status ? status.label_fi : '—'}</span></div>
          <div><span class="lbl">Liidisuoja</span><span class="claim-status-pill color-${claim.color}">${claim.key === 'active' ? `${claim.daysRemaining} pv jäljellä` : claim.label}</span></div>
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

// 90 päivän liidisuoja: laskee ja näyttää käyttäjän omalla aikavyöhykkeellä,
// tallennus tehdään aina UTC:ssä (tietokanta hoitaa tämän - ks.
// fn_set_lead_protection, 0009_lead_claim_protection.sql).
function fmtLocalDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fi-FI', { dateStyle: 'medium', timeStyle: 'short' });
}

// Kaksoiskappale crm/lib/leadClaim.js:stä (testattu tests/lead-claim.test.js) -
// pidettävä käsin synkassa, sama periaate kuin muuallakin tässä tiedostossa
// (ei build-vaihetta CommonJS-tiedoston tuomiseksi ESM-moduuliin).
const CLAIM_DISPLAY_CLIENT = {
  converted_to_customer: { label: 'Muutettu asiakkaaksi', color: 'blue' },
  released: { label: 'Vapautettu', color: 'gray' },
  under_review: { label: 'Ylläpidon tarkistuksessa', color: 'gray' },
  expired: { label: 'Vanhentunut', color: 'gray' }
};
function claimDisplayStatusClient(company) {
  const status = company && company.claim_status;
  if (status && CLAIM_DISPLAY_CLIENT[status]) return { key: status, ...CLAIM_DISPLAY_CLIENT[status], daysRemaining: 0, hoursRemaining: 0 };
  const expiresAt = company && company.protection_expires_at;
  const totalMs = expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0;
  if (!expiresAt || totalMs <= 0) return { key: 'expired', label: 'Vanhentunut', color: 'gray', daysRemaining: 0, hoursRemaining: 0 };
  const days = Math.floor(totalMs / 86400000);
  const hours = Math.floor((totalMs % 86400000) / 3600000);
  let color = 'green';
  if (days < 3) color = 'red'; else if (days < 14) color = 'orange';
  return { key: 'active', label: `Liidisuoja aktiivinen – ${days} päivää jäljellä`, color, daysRemaining: days, hoursRemaining: hours };
}

function openNewCompanyModal() {
  const body = $('#genericModalBody');
  const now = new Date();
  const expiresPreview = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  body.innerHTML = `
    <h3>Uusi yritys</h3>
    <div class="lead-protection-box">
      <strong>90 päivän liidisuoja</strong>
      <p class="muted small">Kun tallennat yrityksen, saat siihen 90 päivän liidisuojan. Suoja alkaa tallennushetkestä. Tänä aikana muut Certified Partnerit eivät voi varata samaa yritystä. Suoja päättyy automaattisesti 90 päivän kuluttua.</p>
      <div class="lead-protection-dates">
        <div><span class="lbl">Arvioitu alkaminen</span>${fmtLocalDateTime(now.toISOString())}</div>
        <div><span class="lbl">Arvioitu päättyminen</span>${fmtLocalDateTime(expiresPreview.toISOString())}</div>
        <div><span class="lbl">Kirjataan nimiin</span>${escapeHtml(profile.name)}</div>
      </div>
    </div>
    <div id="claimCheckResult"></div>
    <form id="newCompanyForm" class="form-grid">
      <label class="full">Yrityksen nimi *<input required name="name" /></label>
      <label>Maa *<input required name="country" placeholder="esim. FI" /></label>
      <label>Kaupunki<input name="city" /></label>
      <label>Y-tunnus / rekisterinumero<input name="business_id" placeholder="ensisijainen tunniste Suomessa" /></label>
      <label>Verkkosivu<input name="website" /></label>
      <label>Toimiala<input name="industry" /></label>
      <label>Työntekijämäärä<input type="number" name="employee_count" /></label>
      <label>Yhteyshenkilön nimi<input name="contact_name" /></label>
      <label>Yhteyshenkilön titteli<input name="contact_title" /></label>
      <label>Yrityksen virallinen sähköposti<input type="email" name="contact_email" /></label>
      <label>Puhelin<input name="contact_phone" /></label>
      <label>Liidin lähde<input name="lead_source" /></label>
      <label class="full">Muistiinpanot<textarea name="notes" rows="2"></textarea></label>
      <p class="muted small full">* Nimi, maa ja vähintään yksi yksilöivä tieto (Y-tunnus, verkkosivu tai yrityksen virallinen sähköposti) vaaditaan.</p>
      <div class="form-actions full">
        <button type="button" class="btn-ghost" data-close-modal>Peruuta</button>
        <button type="submit" class="btn-primary" id="newCompanySubmitBtn" disabled>Tallenna ja aktivoi 90 päivän suoja</button>
      </div>
    </form>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

  const form = $('#newCompanyForm', body);
  const resultEl = $('#claimCheckResult', body);
  const submitBtn = $('#newCompanySubmitBtn', body);
  let lastCheck = null;       // viimeisin fn_check_lead_claim-tulos
  let confirmedDifferent = false; // "Tämä on eri yritys" -vahvistus epävarmalle osumalle

  const runCheck = debounce(async () => {
    const name = form.name.value.trim();
    const country = form.country.value.trim();
    if (!name || !country) { resultEl.innerHTML = ''; lastCheck = null; updateSubmitState(); return; }
    confirmedDifferent = false;
    const { data, error } = await supabase.rpc('fn_check_lead_claim', {
      p_name: name, p_business_id: form.business_id.value || null, p_website: form.website.value || null,
      p_country: country, p_city: form.city.value || null,
      p_email: form.contact_email.value || null, p_phone: form.contact_phone.value || null
    });
    lastCheck = error ? null : data;
    renderCheckResult();
    updateSubmitState();
  }, 400);
  ['name', 'country', 'city', 'business_id', 'website', 'contact_email', 'contact_phone'].forEach((f) => {
    form[f]?.addEventListener('input', runCheck);
  });

  function updateSubmitState() {
    const requiredIdentifier = form.business_id.value.trim() || form.website.value.trim() || form.contact_email.value.trim();
    const hasBasics = form.name.value.trim() && form.country.value.trim() && requiredIdentifier;
    const result = lastCheck ? lastCheck.result : null;
    const blocked = result === 'active_elsewhere' || result === 'own_active';
    const uncertainNeedsConfirm = result === 'uncertain' && !confirmedDifferent;
    submitBtn.disabled = !hasBasics || blocked || uncertainNeedsConfirm || result === 'expired_reclaimable';
    // 'expired_reclaimable' käyttää eri toimintoa (vahvista varaus -painike renderCheckResult:ssa), ei tavallista submitia.
  }

  function renderCheckResult() {
    if (!lastCheck) { resultEl.innerHTML = ''; return; }
    const r = lastCheck;
    if (r.result === 'none') {
      resultEl.innerHTML = `<div class="claim-check-box ok">Yritystä ei löytynyt CRM:stä. Voit kirjata sen uutena liidinä.</div>`;
    } else if (r.result === 'active_elsewhere') {
      resultEl.innerHTML = `<div class="claim-check-box blocked">${escapeHtml(r.message)}</div>`;
    } else if (r.result === 'own_active') {
      resultEl.innerHTML = `<div class="claim-check-box own">Yritys on jo sinun liidilistallasi.
        <button type="button" class="btn-ghost small" id="ccOpenOwnBtn">Avaa yritys</button></div>`;
      $('#ccOpenOwnBtn', resultEl).addEventListener('click', () => { $('#genericModal').classList.add('hidden'); openCompanyModal(r.company_id); });
    } else if (r.result === 'expired_reclaimable') {
      resultEl.innerHTML = `<div class="claim-check-box expired">${escapeHtml(r.message)}
        <button type="button" class="btn-primary small" id="ccReclaimBtn">Varaa yritys uudelleen</button></div>`;
      $('#ccReclaimBtn', resultEl).addEventListener('click', async () => {
        const { data, error } = await supabase.rpc('fn_reclaim_expired_company', {
          p_company_id: r.company_id, p_owning_partner_id: profile.organization_id, p_created_by: profile.id
        });
        if (error || !data.ok) { showToast((data && data.error) || (error && error.message) || 'Varaus epäonnistui.', 'error'); return; }
        $('#genericModal').classList.add('hidden');
        showToast('Yritys varattu - 90 päivän suoja aktivoitu.', 'success');
        await loadCompanies();
        openCompanyModal(data.company.id);
      });
    } else if (r.result === 'uncertain') {
      resultEl.innerHTML = `
        <div class="claim-check-box uncertain">
          CRM:stä löytyi mahdollisesti sama yritys. Tarkista tiedot ennen tallentamista.
          <ul class="claim-candidates">${(r.candidates || []).map((c) => `<li>${escapeHtml(c.name)} — ${escapeHtml(c.country || '')} ${escapeHtml(c.city || '')} ${c.website ? '· ' + escapeHtml(c.website) : ''}${c.business_id ? ' · ' + escapeHtml(c.business_id) : ''}</li>`).join('')}</ul>
          <div class="claim-candidates-actions">
            <button type="button" class="btn-ghost small" id="ccSameBtn">Tämä on sama yritys</button>
            <button type="button" class="btn-ghost small" id="ccDifferentBtn">Tämä on eri yritys</button>
            <button type="button" class="btn-text small" id="ccReviewBtn">Lähetä ylläpidon tarkistettavaksi</button>
          </div>
        </div>`;
      $('#ccSameBtn', resultEl).addEventListener('click', () => {
        const candidateId = r.candidates && r.candidates[0] && r.candidates[0].company_id;
        if (candidateId) { $('#genericModal').classList.add('hidden'); openCompanyModal(candidateId); }
      });
      $('#ccDifferentBtn', resultEl).addEventListener('click', () => { confirmedDifferent = true; updateSubmitState(); showToast('Merkitty eri yritykseksi - voit nyt tallentaa.', 'success'); });
      $('#ccReviewBtn', resultEl).addEventListener('click', () => { flagForReviewAfterCreate = true; confirmedDifferent = true; updateSubmitState(); showToast('Yritys tallennetaan ylläpidon tarkistukseen tallennuksen yhteydessä.', 'success'); });
    }
  }

  let flagForReviewAfterCreate = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    payload.employee_count = payload.employee_count ? Number(payload.employee_count) : null;
    payload.owning_partner_id = profile.organization_id;
    payload.created_by = profile.id;
    payload.status_id = leadStatuses.find((s) => s.key === 'new_lead')?.id || null;
    payload.currency = 'EUR';

    const { data, error } = await supabase.rpc('fn_create_company_claim', { p_company: payload });
    if (error || !data.ok) {
      const msg = (data && data.check && data.check.message) || (error && error.message) || 'Tallennus epäonnistui.';
      showToast(msg, 'error');
      lastCheck = (data && data.check) || null;
      renderCheckResult();
      updateSubmitState();
      return;
    }
    if (flagForReviewAfterCreate) {
      await supabase.rpc('fn_flag_lead_for_review', { p_company_id: data.company.id, p_reason: 'Käyttäjä merkitsi epävarman osuman ylläpidon tarkistettavaksi tallennuksen yhteydessä.' });
    }
    $('#genericModal').classList.add('hidden');
    showToast('Yritys tallennettu ja 90 päivän suoja aktivoitu.', 'success');
    await loadCompanies();
  });

  $('#genericModal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Yrityksen detail + aikajana
// ---------------------------------------------------------------

function wireLeadClaimSection(id, company, body) {
  $('#convertToCustomerBtn', body)?.addEventListener('click', async () => {
    const reason = await confirmDangerousAction({
      title: 'Muuta asiakkaaksi', confirmLabel: 'Muuta asiakkaaksi',
      body: `<strong>${escapeHtml(company.name)}</strong><br/>Yrityksen liidisuoja muuttuu pysyväksi asiakkuudeksi. Yritystä ei enää vapauteta muille partnereille 90 päivän jälkeen.`,
      needsReason: true
    });
    if (reason === null) return;
    const { data, error } = await supabase.rpc('fn_convert_lead_to_customer', { p_company_id: id, p_reason: reason || null });
    if (error || !data.ok) { showToast((data && data.error) || (error && error.message) || 'Toiminto epäonnistui.', 'error'); return; }
    showToast('Yritys muutettu asiakkaaksi.', 'success');
    openCompanyModal(id);
  });

  $('#releaseClaimBtn', body)?.addEventListener('click', async () => {
    const reason = await confirmDangerousAction({
      title: 'Vapauta liidi', confirmLabel: 'Vapauta liidi',
      body: `<strong>${escapeHtml(company.name)}</strong><br/>Liidisuoja päättyy välittömästi ja yritys vapautuu muiden Certified Partnerien varattavaksi.`,
      needsReason: true
    });
    if (reason === null) return;
    if (!reason) { showToast('Syy on pakollinen vapautukselle.', 'error'); return; }
    const { data, error } = await supabase.rpc('fn_release_lead_claim', { p_company_id: id, p_reason: reason });
    if (error || !data.ok) { showToast((data && data.error) || (error && error.message) || 'Toiminto epäonnistui.', 'error'); return; }
    showToast('Liidi vapautettu.', 'success');
    openCompanyModal(id);
  });

  $('#transferClaimBtn', body)?.addEventListener('click', async () => {
    const { data: orgs } = await supabase.from('organizations').select('id, name').eq('type', 'certified_partner').neq('id', company.owning_partner_id);
    const modalBody = $('#genericModalBody');
    modalBody.innerHTML = `
      <h3>Siirrä liidi toiselle partnerille</h3>
      <p class="muted">${escapeHtml(company.name)}</p>
      <form id="transferClaimForm" class="form-grid">
        <label class="full">Uusi partneri<select name="new_partner_id">${(orgs || []).map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></label>
        <label class="full">Syy *<textarea required name="reason" rows="2"></textarea></label>
        <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Siirrä</button></div>
      </form>`;
    $$('[data-close-modal]', modalBody).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));
    $('#transferClaimForm', modalBody).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const { data, error } = await supabase.rpc('fn_transfer_lead_claim', {
        p_company_id: id, p_new_partner_id: fd.get('new_partner_id'), p_reason: fd.get('reason')
      });
      if (error || !data.ok) { showToast((data && data.error) || (error && error.message) || 'Siirto epäonnistui.', 'error'); return; }
      $('#genericModal').classList.add('hidden');
      showToast('Liidi siirretty.', 'success');
      $('#companyModal').classList.add('hidden');
      await loadCompanies();
    });
    $('#genericModal').classList.remove('hidden');
  });

  $('#mergeDuplicateBtn', body)?.addEventListener('click', async () => {
    const modalBody = $('#genericModalBody');
    modalBody.innerHTML = `
      <h3>Yhdistä duplikaattiyritys</h3>
      <p class="muted">Säilytettävä (tämä) yritys: <strong>${escapeHtml(company.name)}</strong></p>
      <p class="muted small">Vain SAMAN partnerin (${escapeHtml(company.owning_partner_id === profile.organization_id ? 'oma organisaatiosi' : company.owning_partner_id)}) virheellisesti kahdesti luotu yritys voidaan yhdistää. Poistettavan yrityksen historia (kontaktit, aktiviteetit, follow-upit, mahdollisuudet) siirtyy tälle riville - mitään ei kadoteta.</p>
      <form id="mergeDupForm" class="form-grid">
        <label class="full">Poistettavan (duplikaatti-) yrityksen nimi<input required name="dup_search" placeholder="Hae yrityksen nimellä…" /></label>
        <div id="mergeDupCandidates" class="full"></div>
        <label class="full">Syy *<textarea required name="reason" rows="2" placeholder="esim. Sama yritys kirjattu vahingossa kahdesti"></textarea></label>
        <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-danger" id="mergeDupSubmitBtn" disabled>Yhdistä</button></div>
      </form>`;
    $$('[data-close-modal]', modalBody).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

    let selectedDupId = null;
    const searchInput = $('[name="dup_search"]', modalBody);
    const candidatesEl = $('#mergeDupCandidates', modalBody);
    const submitBtn = $('#mergeDupSubmitBtn', modalBody);
    searchInput.addEventListener('input', debounce(async () => {
      selectedDupId = null; submitBtn.disabled = true;
      const term = searchInput.value.trim();
      if (term.length < 2) { candidatesEl.innerHTML = ''; return; }
      const { data: candidates } = await supabase.from('companies').select('id, name, business_id, city')
        .eq('owning_partner_id', company.owning_partner_id).neq('id', id).is('archived_at', null).ilike('name', `%${term}%`).limit(5);
      candidatesEl.innerHTML = (candidates || []).map((c) => `
        <button type="button" class="btn-ghost small" data-dup-id="${c.id}" style="display:block; width:100%; text-align:left; margin-bottom:4px;">
          ${escapeHtml(c.name)} ${c.business_id ? `(${escapeHtml(c.business_id)})` : ''} ${c.city ? '· ' + escapeHtml(c.city) : ''}
        </button>`).join('') || '<p class="muted small">Ei osumia.</p>';
      $$('[data-dup-id]', candidatesEl).forEach((btn) => btn.addEventListener('click', () => {
        selectedDupId = btn.dataset.dupId;
        $$('[data-dup-id]', candidatesEl).forEach((b) => b.classList.remove('btn-primary'));
        btn.classList.add('btn-primary');
        submitBtn.disabled = false;
      }));
    }, 300));

    $('#mergeDupForm', modalBody).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedDupId) return;
      const fd = new FormData(e.target);
      const { data, error } = await supabase.rpc('fn_merge_duplicate_companies', {
        p_keep_id: id, p_remove_id: selectedDupId, p_reason: fd.get('reason')
      });
      if (error || !data.ok) { showToast((data && data.error) || (error && error.message) || 'Yhdistäminen epäonnistui.', 'error'); return; }
      $('#genericModal').classList.add('hidden');
      showToast('Yritykset yhdistetty.', 'success');
      openCompanyModal(id);
    });
    $('#genericModal').classList.remove('hidden');
  });

  $('#viewClaimLogBtn', body)?.addEventListener('click', async () => {
    const box = $('#claimLogBox', body);
    const { data, error } = await supabase.from('lead_claim_audit_log').select('*').eq('company_id', id).order('created_at', { ascending: false });
    if (error) { box.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`; return; }
    box.innerHTML = (data || []).length
      ? `<table class="detail-table" style="margin-top:10px;"><tbody>${data.map((l) => `
          <tr><td>${fmtDateTime(l.created_at)}</td><td>${escapeHtml(l.event_type)}${l.reason ? ' — ' + escapeHtml(l.reason) : ''}</td></tr>
        `).join('')}</tbody></table>`
      : '<p class="muted small">Ei lokitapahtumia.</p>';
  });
}

async function openCompanyModal(id) {
  const body = $('#companyModalBody');
  body.innerHTML = '<p class="muted">Ladataan…</p>';
  $('#companyModal').classList.remove('hidden');

  const [{ data: company, error: companyErr }, { data: activities }, { data: followups }, { data: companyOpps }] = await Promise.all([
    supabase.from('companies').select('*, lead_statuses(label_fi)').eq('id', id).single(),
    supabase.from('activities').select('*').eq('company_id', id).order('occurred_at', { ascending: false }),
    supabase.from('followup_tasks').select('*').eq('company_id', id).eq('status', 'open').order('due_date'),
    supabase.from('opportunities').select('id, title, estimated_value, stage_id, products(name)').eq('company_id', id).is('archived_at', null)
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

  const claim = claimDisplayStatusClient(company);

  body.innerHTML = `
    <h3>${escapeHtml(company.name)}</h3>
    <p class="muted small">${escapeHtml(company.city || '')} ${escapeHtml(company.country || '')} · ${escapeHtml(company.industry || 'toimiala tuntematon')}</p>
    <p><span class="status-pill">${company.lead_statuses ? company.lead_statuses.label_fi : '—'}</span></p>

    <div class="lead-claim-section color-${claim.color}">
      <div class="lead-claim-title color-${claim.color}">${escapeHtml(claim.label)}</div>
      <div class="lead-claim-grid">
        <div><span class="lbl">Alkoi</span>${fmtLocalDateTime(company.protection_started_at)}</div>
        <div><span class="lbl">Päättyy</span>${fmtLocalDateTime(company.protection_expires_at)}</div>
        <div><span class="lbl">Vastuuhenkilö</span>${escapeHtml(company.responsible_user_id ? '—' : 'Ei asetettu')}</div>
        <div><span class="lbl">Tila</span><span class="claim-status-pill color-${claim.color}">${escapeHtml(claim.key)}</span></div>
      </div>
      <div class="form-actions" style="margin-top:10px;">
        ${claim.key === 'active' ? '<button class="btn-primary small" id="convertToCustomerBtn">Merkitse kauppa voitetuksi / Muuta asiakkaaksi</button>' : ''}
        ${isOwner ? `
          <button class="btn-ghost small" id="viewClaimLogBtn">Näytä suojan loki</button>
          ${claim.key === 'active' ? '<button class="btn-ghost small" id="releaseClaimBtn">Vapauta liidi</button><button class="btn-ghost small" id="transferClaimBtn">Siirrä toiselle partnerille</button>' : ''}
          <button class="btn-text small" id="mergeDuplicateBtn">Yhdistä duplikaattiyritys tähän</button>
        ` : ''}
      </div>
      <div id="claimLogBox"></div>
    </div>

    <h3 style="margin-top:20px;">Myyntiputken mahdollisuudet (${(companyOpps || []).length})</h3>
    ${(companyOpps || []).length ? `<ul>${companyOpps.map((o) => {
      const s = stageById(o.stage_id);
      return `<li>${escapeHtml(o.title || (o.products ? o.products.name : 'Mahdollisuus'))} — ${money(o.estimated_value)} · ${s ? escapeHtml(s.label_fi) : '—'} <button class="btn-text small" data-open-opp-from-company="${o.id}">Avaa</button></li>`;
    }).join('')}</ul>` : '<p class="muted small">Ei vielä avoimia mahdollisuuksia.</p>'}
    <button class="btn-ghost small" id="newOppFromCompanyBtn">+ Uusi mahdollisuus</button>

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
  wireLeadClaimSection(id, company, body);

  $('#newOppFromCompanyBtn', body).addEventListener('click', () => {
    $('#companyModal').classList.add('hidden'); // ei jätetä kahta modaalia päällekkäin näkyviin
    openNewOpportunityModal(id);
  });
  $$('[data-open-opp-from-company]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      $('#companyModal').classList.add('hidden');
      await loadPipeline();
      openOpportunityDrawer(btn.dataset.openOppFromCompany);
    });
  });

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
// Myyntiputki — kauppa (opportunity) on OMA tietueensa, ei sama kuin yritys
// (ks. supabase/migrations/0005_opportunities_pipeline.sql). Yhdellä
// yrityksellä voi siis olla useita rinnakkaisia mahdollisuuksia.
//
// calcWeightedForecast/daysInStage/isStalled kaksoiskappale
// crm/lib/pipelineForecast.js:stä (testattu tests/pipeline-forecast.test.js)
// — pidettävä käsin synkassa, sama periaate kuin calcOpportunityScoreClient.
// ---------------------------------------------------------------

function calcWeightedForecastClient(opportunities) {
  return (opportunities || []).reduce((acc, o) => {
    const value = Number(o.estimated_value) || 0;
    const probability = Math.max(0, Math.min(100, Number(o.probability) || 0));
    acc.totalValue += value;
    acc.weightedValue += value * (probability / 100);
    acc.count += 1;
    return acc;
  }, { totalValue: 0, weightedValue: 0, count: 0 });
}
function daysInStageClient(stageEnteredAt, now) {
  if (!stageEnteredAt) return 0;
  const ms = (now ? new Date(now) : new Date()).getTime() - new Date(stageEnteredAt).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
function isStalledClient(opportunity, stage, now) {
  if (!stage || stage.max_duration_days == null || stage.is_won || stage.is_lost) return false;
  return daysInStageClient(opportunity.stage_entered_at, now) > stage.max_duration_days;
}

// Näihin vaiheisiin siirto avaa kevyen lomakkeen sen sijaan että vain
// vaihtaisi statuksen — vain vaiheen kannalta välttämättömät kentät
// (spesifikaation kohta 7: "älkää tehkö vaiheiden siirtämisestä raskasta").
const STAGE_TRANSITION_FORMS = new Set(['meeting_demo', 'offer', 'won', 'lost']);

function stageById(id) { return pipelineStages.find((s) => s.id === id); }

async function loadPipeline() {
  const board = $('#kanbanBoard');
  board.innerHTML = Array.from({ length: 4 }, () => '<div class="kanban-col"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-card"></div></div>').join('');

  const [{ data: opps, error }, { data: profiles }] = await Promise.all([
    supabase
      .from('opportunities')
      .select('*, companies(id, name, contact_name, contact_title, city, country), products(name), profiles!opportunities_responsible_user_id_fkey(id, name)')
      .is('archived_at', null),
    supabase.from('profiles').select('id, name').eq('active', true).order('name')
  ]);
  orgProfilesCache = profiles || [];

  if (error) {
    board.innerHTML = `<div class="empty-state"><div class="es-title">Myyntiputken haku epäonnistui</div>${escapeHtml(error.message)}</div>`;
    return;
  }

  opportunitiesCache = opps || [];

  // Avoimet follow-upit haetaan erikseen ja liitetään mahdollisuuteen
  // opportunity_id:n perusteella (0005-migraation uusi sarake).
  const oppIds = opportunitiesCache.map((o) => o.id);
  let followupsByOpp = {};
  if (oppIds.length) {
    const { data: fus } = await supabase
      .from('followup_tasks')
      .select('*')
      .eq('status', 'open')
      .in('opportunity_id', oppIds)
      .order('due_date');
    (fus || []).forEach((f) => {
      if (!followupsByOpp[f.opportunity_id]) followupsByOpp[f.opportunity_id] = f; // lähin riittää kortille
    });
  }
  opportunitiesCache.forEach((o) => { o._nextFollowup = followupsByOpp[o.id] || null; });

  renderPipeline();
}

function pipelineFilteredOpportunities() {
  if (!pipelineOnlyMine) return opportunitiesCache;
  return opportunitiesCache.filter((o) => o.responsible_user_id === profile.id);
}

function renderPipeline() {
  const rows = pipelineFilteredOpportunities();
  renderForecastBar(rows);
  if (pipelineViewMode === 'kanban') {
    $('#kanbanBoard').classList.remove('hidden');
    $('#pipelineTableWrap').classList.add('hidden');
    renderPipelineKanban(rows);
  } else {
    $('#kanbanBoard').classList.add('hidden');
    $('#pipelineTableWrap').classList.remove('hidden');
    renderPipelineTable(rows);
  }
}

function renderForecastBar(rows) {
  const open = rows.filter((o) => { const s = stageById(o.stage_id); return s && !s.is_won && !s.is_lost; });
  const won = rows.filter((o) => { const s = stageById(o.stage_id); return s && s.is_won; });
  const { totalValue, weightedValue, count } = calcWeightedForecastClient(open);
  const stalled = open.filter((o) => isStalledClient(o, stageById(o.stage_id))).length;
  const wonTotal = won.reduce((sum, o) => sum + (Number(o.estimated_value) || 0), 0);

  $('#pipelineForecastBar').innerHTML = `
    <div class="forecast-stat"><span class="fs-label">Avoin putki</span><span class="fs-value">${money(totalValue)}</span><span class="fs-sub">${count} kauppaa</span></div>
    <div class="forecast-stat"><span class="fs-label">Painotettu ennuste</span><span class="fs-value teal">${money(weightedValue)}</span><span class="fs-sub">arvo × todennäköisyys</span></div>
    <div class="forecast-stat"><span class="fs-label">Voitettu (näkyvät)</span><span class="fs-value">${money(wonTotal)}</span><span class="fs-sub">${won.length} kauppaa</span></div>
    <div class="forecast-stat ${stalled ? 'warn' : ''}"><span class="fs-label">Pysähtyneet</span><span class="fs-value">${stalled}</span><span class="fs-sub">${stalled ? 'vaatii huomiota' : 'kaikki liikkeessä'}</span></div>`;
}

function opportunityCardHtml(o) {
  const stage = stageById(o.stage_id);
  const stalled = isStalledClient(o, stage);
  const days = daysInStageClient(o.stage_entered_at);
  const fu = o._nextFollowup;
  const today = todayISO();
  let fuClass = 'missing', fuLabel = 'Seuraavaa toimenpidettä ei ole määritelty.';
  if (fu) {
    if (fu.due_date < today) { fuClass = 'overdue'; fuLabel = `Myöhässä: ${escapeHtml(fu.description || 'Follow-up')} (${fmtDate(fu.due_date)})`; }
    else if (fu.due_date === today) { fuClass = 'today'; fuLabel = `Tänään: ${escapeHtml(fu.description || 'Follow-up')}`; }
    else { fuClass = 'upcoming'; fuLabel = `${fmtDate(fu.due_date)}: ${escapeHtml(fu.description || 'Follow-up')}`; }
  }
  const company = o.companies || {};
  const resp = o.profiles;

  return `
    <div class="opp-card ${stalled ? 'stalled' : ''}" draggable="true" data-opp-id="${o.id}">
      <div class="opp-top">
        <div class="opp-name">${escapeHtml(company.name || '(yritys puuttuu)')}</div>
        ${stalled ? `<span class="opp-stalled-badge" title="Ei liikettä ${days} päivään">⚠ Pysähtynyt</span>` : ''}
      </div>
      ${company.contact_name ? `<div class="opp-contact">${escapeHtml(company.contact_name)}${company.contact_title ? ' · ' + escapeHtml(company.contact_title) : ''}</div>` : ''}
      <div class="opp-mid-row">
        <span class="opp-product">${escapeHtml(o.products ? o.products.name : (o.title || 'Ei tuotetta valittu'))}</span>
        <span class="opp-value">${money(o.estimated_value, o.currency)}</span>
      </div>
      <div class="opp-prob-row" title="Todennäköisyys ${o.probability}%">
        <div class="opp-prob-bar"><div class="opp-prob-fill" style="width:${o.probability}%"></div></div>
        <span class="opp-prob-pct">${o.probability}%</span>
      </div>
      <div class="opp-bottom">
        <span class="opp-resp" title="Vastuuhenkilö">${resp ? escapeHtml(initials(resp.name)) : '—'}</span>
        <span class="opp-days muted small">${days} pv vaiheessa</span>
      </div>
      <div class="opp-followup ${fuClass}">${fuLabel}</div>
      <select class="opp-stage-select" data-no-open data-opp-id="${o.id}" title="Siirrä toiseen vaiheeseen">
        ${pipelineStages.map((s) => `<option value="${s.id}" ${s.id === o.stage_id ? 'selected' : ''}>${escapeHtml(s.label_fi)}</option>`).join('')}
      </select>
    </div>`;
}

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
}

function renderPipelineKanban(rows) {
  const board = $('#kanbanBoard');
  board.innerHTML = pipelineStages.map((stage) => {
    const cards = rows.filter((o) => o.stage_id === stage.id);
    const total = cards.reduce((sum, o) => sum + (Number(o.estimated_value) || 0), 0);
    return `
      <div class="kanban-col ${stage.is_won ? 'col-won' : stage.is_lost ? 'col-lost' : ''}" data-stage-id="${stage.id}">
        <h4>${escapeHtml(stage.label_fi)} <span class="col-count">${cards.length}</span></h4>
        <div class="col-total muted small">${money(total)}</div>
        ${cards.length ? cards.map(opportunityCardHtml).join('') : '<div class="empty-state small">Ei kauppoja</div>'}
      </div>`;
  }).join('');

  wirePipelineDragDrop(board);
  wirePipelineCardOpen(board);
}

function renderPipelineTable(rows) {
  const wrap = $('#pipelineTableWrap');
  if (!rows.length) { wrap.innerHTML = '<div class="empty-state"><div class="es-title">Ei kauppoja</div></div>'; return; }
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Yritys</th><th>Vaihe</th><th>Tuote</th><th>Arvo</th><th>Tod.näk.</th><th>Vastuuhenkilö</th><th>Seuraava follow-up</th><th></th></tr></thead>
      <tbody>${rows.map((o) => {
        const stage = stageById(o.stage_id);
        const fu = o._nextFollowup;
        const stalled = isStalledClient(o, stage);
        return `<tr class="${stalled ? 'row-stalled' : ''}">
          <td>${escapeHtml((o.companies || {}).name || '—')}</td>
          <td>${stage ? escapeHtml(stage.label_fi) : '—'}${stalled ? ' ⚠' : ''}</td>
          <td>${escapeHtml(o.products ? o.products.name : (o.title || '—'))}</td>
          <td>${money(o.estimated_value, o.currency)}</td>
          <td>${o.probability}%</td>
          <td>${o.profiles ? escapeHtml(o.profiles.name) : '—'}</td>
          <td>${fu ? fmtDate(fu.due_date) : '<span class="muted">puuttuu</span>'}</td>
          <td><button class="btn-ghost small" data-open-opp="${o.id}">Avaa</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    </div>`;
  $$('[data-open-opp]', wrap).forEach((btn) => btn.addEventListener('click', () => openOpportunityDrawer(btn.dataset.openOpp)));
}

function wirePipelineCardOpen(board) {
  $$('.opp-card', board).forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-no-open]')) return;
      openOpportunityDrawer(card.dataset.oppId);
    });
  });
}

// Yhteinen "yritä siirtää vaihetta" -logiikka raahaukselle JA kortin omalle
// vaihevalitsimelle (ks. alla - raahaus on osalle käyttäjistä hankalaa
// esim. kosketuslevyllä, joten sama toiminto on aina saatavilla myös
// pudotusvalikkona ilman raahausta).
async function attemptMoveOpportunity(opp, targetStage, revertSelect) {
  if (!opp || !targetStage || opp.stage_id === targetStage.id) return;
  if (STAGE_TRANSITION_FORMS.has(targetStage.key)) {
    openStageTransitionModal(opp, targetStage);
    if (revertSelect) revertSelect(); // lomake voi vielä peruuntua - valitsin ei saa jäädä väärään tilaan
    return;
  }
  await moveOpportunityToStage(opp, targetStage, {});
}

function wirePipelineDragDrop(board) {
  $$('.opp-card', board).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.oppId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  $$('.kanban-col', board).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const oppId = e.dataTransfer.getData('text/plain');
      const targetStage = stageById(col.dataset.stageId);
      const opp = opportunitiesCache.find((o) => o.id === oppId);
      await attemptMoveOpportunity(opp, targetStage);
    });
  });
  // Vaihdon voi tehdä myös suoraan kortin omasta pudotusvalikosta - ei vaadi
  // raahausta ollenkaan, toimii yhtä lailla kosketusnäytöllä/kosketuslevyllä.
  $$('.opp-stage-select', board).forEach((select) => {
    select.addEventListener('mousedown', (e) => e.stopPropagation());
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', async (e) => {
      const opp = opportunitiesCache.find((o) => o.id === select.dataset.oppId);
      const targetStage = stageById(e.target.value);
      const revert = () => { select.value = opp.stage_id; };
      await attemptMoveOpportunity(opp, targetStage, revert);
    });
  });
}

// Siirtää mahdollisuuden uuteen vaiheeseen. extraFields yhdistetään samaan
// UPDATE-kutsuun (esim. lost_reason) jotta koko siirto on yksi atominen
// tietokantaoperaatio. Epäonnistunut päivitys EI muuta paikallista tilaa,
// joten kortti palautuu vanhaan sarakkeeseen automaattisesti seuraavassa
// renderissä (spesifikaation kohta 17).
async function moveOpportunityToStage(opp, targetStage, extraFields) {
  const payload = {
    stage_id: targetStage.id,
    ...(opp.probability_overridden ? {} : { probability: targetStage.default_probability }),
    ...extraFields
  };
  const { error } = await supabase.from('opportunities').update(payload).eq('id', opp.id);
  if (error) {
    alert(`Vaiheen vaihto epäonnistui: ${error.message}. Kauppa pysyy alkuperäisessä vaiheessa.`);
    return false;
  }
  await loadPipeline();
  return true;
}

function wirePipelineChrome() {
  $('#newOpportunityBtn').addEventListener('click', () => openNewOpportunityModal());
  $('#pipelineOnlyMine').addEventListener('change', (e) => { pipelineOnlyMine = e.target.checked; renderPipeline(); });
  $$('.view-toggle-btn', $('#pipelineViewToggle')).forEach((btn) => {
    btn.addEventListener('click', () => {
      pipelineViewMode = btn.dataset.mode;
      localStorage.setItem('aerwork_pipeline_view_mode', pipelineViewMode);
      $$('.view-toggle-btn', $('#pipelineViewToggle')).forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      renderPipeline();
    });
  });
  $('#opportunityDrawerClose').addEventListener('click', closeOpportunityDrawer);
  $('#opportunityDrawerOverlay').addEventListener('click', closeOpportunityDrawer);
}

function closeOpportunityDrawer() {
  $('#opportunityDrawer').classList.add('hidden');
  $('#opportunityDrawerOverlay').classList.add('hidden');
}

// ---------------------------------------------------------------
// Uusi mahdollisuus
// ---------------------------------------------------------------

async function openNewOpportunityModal(preselectCompanyId) {
  const { data: companies } = await supabase.from('companies').select('id, name').is('archived_at', null).order('name');
  const body = $('#genericModalBody');
  body.innerHTML = `
    <h3>Uusi mahdollisuus</h3>
    <form id="newOppForm" class="form-grid">
      <label class="full">Yritys *
        <select name="company_id" required>
          <option value="">Valitse yritys…</option>
          ${(companies || []).map((c) => `<option value="${c.id}" ${c.id === preselectCompanyId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>Tuote
        <select name="product_id"><option value="">Ei valittu</option>${productsCache.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
      </label>
      <label>Arvioitu arvo (€)<input type="number" name="estimated_value" min="0" step="100" /></label>
      <label>Vastuuhenkilö
        <select name="responsible_user_id">${orgProfilesCache.map((p) => `<option value="${p.id}" ${p.id === profile.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      </label>
      <label>Liidin lähde<input name="lead_source" /></label>
      <label class="full">Vapaaehtoinen kuvaus (jos yrityksellä useita mahdollisuuksia)<input name="title" placeholder="esim. Kevät-Pay laajennus" /></label>
      <div class="form-actions full">
        <button type="button" class="btn-ghost" data-close-modal>Peruuta</button>
        <button type="submit" class="btn-primary">Luo mahdollisuus</button>
      </div>
    </form>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

  $('#newOppForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (!payload.company_id) return;
    const newLeadStage = pipelineStages.find((s) => s.key === 'new_lead');
    const { data: companyRow } = await supabase.from('companies').select('owning_partner_id').eq('id', payload.company_id).single();

    const { error } = await supabase.from('opportunities').insert({
      company_id: payload.company_id,
      partner_id: companyRow ? companyRow.owning_partner_id : profile.organization_id,
      product_id: payload.product_id || null,
      estimated_value: payload.estimated_value ? Number(payload.estimated_value) : null,
      responsible_user_id: payload.responsible_user_id || profile.id,
      lead_source: payload.lead_source || null,
      title: payload.title || null,
      stage_id: newLeadStage ? newLeadStage.id : null,
      probability: newLeadStage ? newLeadStage.default_probability : 0,
      created_by: profile.id
    });
    if (error) { alert(`Luonti epäonnistui: ${error.message}`); return; }
    $('#genericModal').classList.add('hidden');
    await loadPipeline();
  });

  $('#genericModal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Vaiheen vaihdon lomakkeet (vain kevyt, vaiheen kannalta välttämätön tieto)
// ---------------------------------------------------------------

// "Voitettu"-lomakkeen tuoterivit — yksi kauppa (projekti) voi sisältää
// useamman tuotteen, esim. AerWork + Kehitys samassa sopimuksessa. Jokainen
// rivi vastaa yhtä deal_line_items-riviä (kesto/laskutusväli on yhteinen
// koko sopimukselle, samoin kuin lomakkeen muissa kentissä).
function addWonProductLine(container, opp, preselectOpportunityProduct) {
  const row = document.createElement('div');
  row.className = 'won-product-line';
  row.innerHTML = `
    <select class="wpl-product" required>
      <option value="">Valitse tuote…</option>
      ${productsCache.map((p) => `<option value="${p.id}" ${preselectOpportunityProduct && p.id === opp.product_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
    </select>
    <input type="number" class="wpl-price" placeholder="Kuukausihinta (€)" min="0" step="10" required />
    <button type="button" class="btn-text small wpl-remove">Poista</button>`;
  row.querySelector('.wpl-remove').addEventListener('click', () => {
    if (container.children.length > 1) row.remove(); // aina jäätävä vähintään yksi rivi
  });
  container.appendChild(row);
}

function openStageTransitionModal(opp, targetStage) {
  const body = $('#genericModalBody');
  const company = opp.companies || {};
  const forms = {
    meeting_demo: () => `
      <h3>Siirto: ${escapeHtml(targetStage.label_fi)}</h3>
      <p class="muted small">${escapeHtml(company.name)}</p>
      <form id="stageForm" class="form-grid">
        <label>Päivämäärä *<input required type="date" name="meeting_date" min="${todayISO()}" /></label>
        <label>Kellonaika<input type="time" name="meeting_time" /></label>
        <label class="full">Osallistujat<input name="participants" placeholder="esim. Matti Meikäläinen, Liisa Virtanen" /></label>
        <label class="full">Tavoite<input name="objective" placeholder="esim. Tarpeen kartoitus" /></label>
        <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Vahvista siirto</button></div>
      </form>`,
    offer: () => `
      <h3>Siirto: ${escapeHtml(targetStage.label_fi)}</h3>
      <p class="muted small">${escapeHtml(company.name)}</p>
      <form id="stageForm" class="form-grid">
        <label>Tarjouksen arvo (€) *<input required type="number" min="0" step="100" name="offer_value" value="${opp.estimated_value ?? ''}" /></label>
        <label>Tuote<select name="product_id"><option value="">Ei valittu</option>${productsCache.map((p) => `<option value="${p.id}" ${p.id === opp.product_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>
        <label>Voimassaolo asti<input type="date" name="valid_until" /></label>
        <label>Seuraava follow-up *<input required type="date" name="followup_date" min="${todayISO()}" /></label>
        <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Vahvista siirto</button></div>
      </form>`,
    won: () => `
      <h3>🎉 Siirto: Voitettu</h3>
      <p class="muted small">${escapeHtml(company.name)}</p>
      <form id="stageForm" class="form-grid">
        <label class="full">Myydyt tuotteet * <span class="muted small">(projekti voi sisältää useamman tuotteen — lisää tarvittaessa rivejä)</span></label>
        <div id="wonProductLines" class="full"></div>
        <button type="button" class="btn-ghost small full" id="wonAddProductLine" style="width:fit-content;">+ Lisää tuote</button>
        <label>Sopimuksen alkamispäivä *<input required type="date" name="contract_start_date" value="${todayISO()}" /></label>
        <label>Kesto (kk) *<input required type="number" min="1" name="length_months" value="12" /></label>
        <label>Laskutusväli<select name="billing_interval"><option value="monthly">Kuukausittain</option><option value="quarterly">Neljännesvuosittain</option><option value="yearly">Vuosittain</option></select></label>
        <label>Käyttöönottovastuuhenkilö<select name="onboarding_owner_id">${orgProfilesCache.map((p) => `<option value="${p.id}" ${p.id === opp.responsible_user_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>
        <p class="muted small full">Lopullinen arvo ja kuukausihinta (MRR) lasketaan automaattisesti tuoteriveiltä. Partnerikomissio lasketaan automaattisesti komissiosäännöistä sopimuksen tallennuksen yhteydessä.</p>
        <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Merkitse voitetuksi</button></div>
      </form>`,
    lost: () => `
      <h3>Siirto: Hävitty</h3>
      <p class="muted small">${escapeHtml(company.name)}</p>
      <form id="stageForm" class="form-grid">
        <label class="full">Häviämisen syy *<input required name="lost_reason" /></label>
        <label>Kilpailija (jos tiedossa)<input name="lost_competitor" /></label>
        <label class="full">Asiakkaan palaute<textarea name="feedback" rows="2"></textarea></label>
        <label class="checkbox-inline full"><input type="checkbox" name="can_revisit" /> Asiakkaaseen voi palata myöhemmin</label>
        <label>Uusi yhteydenottopäivä<input type="date" name="revisit_date" /></label>
        <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Merkitse hävityksi</button></div>
      </form>`
  };

  body.innerHTML = forms[targetStage.key]();
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));

  if (targetStage.key === 'won') {
    const container = $('#wonProductLines', body);
    addWonProductLine(container, opp, true); // ensimmäinen rivi valmiiksi, esitäytetty mahdollisuuden tuotteella
    $('#wonAddProductLine', body).addEventListener('click', () => addWonProductLine(container, opp, false));
  }

  $('#stageForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const v = Object.fromEntries(fd.entries());
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      if (targetStage.key === 'meeting_demo') {
        await supabase.from('activities').insert({
          company_id: opp.company_id, partner_id: opp.partner_id, performed_by: profile.id,
          channel: 'meeting', purpose: v.objective || 'Tapaaminen sovittu',
          summary: `Osallistujat: ${v.participants || '—'}`,
          next_followup_date: v.meeting_date, followup_owner_id: opp.responsible_user_id || profile.id
        });
        await moveOpportunityToStage(opp, targetStage, {});
      } else if (targetStage.key === 'offer') {
        await supabase.from('activities').insert({
          company_id: opp.company_id, partner_id: opp.partner_id, performed_by: profile.id,
          channel: 'email', purpose: 'Tarjous lähetetty', outcome: `Arvo ${v.offer_value} €`,
          next_followup_date: v.followup_date, followup_owner_id: opp.responsible_user_id || profile.id
        });
        await supabase.from('followup_tasks').insert({
          company_id: opp.company_id, partner_id: opp.partner_id, owner_id: opp.responsible_user_id || profile.id,
          due_date: v.followup_date, description: 'Tarjouksen follow-up', opportunity_id: opp.id, created_by: profile.id
        });
        await moveOpportunityToStage(opp, targetStage, {
          estimated_value: Number(v.offer_value), product_id: v.product_id || opp.product_id,
          expected_close_date: v.valid_until || opp.expected_close_date
        });
      } else if (targetStage.key === 'won') {
        const lineRows = $$('.won-product-line', e.target).map((row) => ({
          product_id: row.querySelector('.wpl-product').value,
          monthly_price: Number(row.querySelector('.wpl-price').value) || 0
        })).filter((r) => r.product_id);
        if (!lineRows.length) { alert('Lisää vähintään yksi tuote ennen tallennusta.'); submitBtn.disabled = false; return; }

        const start = v.contract_start_date;
        const end = new Date(start);
        end.setMonth(end.getMonth() + Number(v.length_months || 0));
        const { data: signedStatus } = await supabase.from('deal_statuses').select('id').eq('key', 'signed').maybeSingle();
        const { data: deal, error: dealErr } = await supabase.from('deals').insert({
          company_id: opp.company_id, partner_id: opp.partner_id, responsible_user_id: v.onboarding_owner_id || opp.responsible_user_id,
          contract_signed_date: todayISO(), contract_start_date: start, contract_end_date: end.toISOString().slice(0, 10),
          billing_interval: v.billing_interval, currency: opp.currency || 'EUR',
          status_id: signedStatus ? signedStatus.id : null, created_by: profile.id
        }).select().single();
        if (dealErr) throw dealErr;

        const { error: lineErr } = await supabase.from('deal_line_items').insert(
          lineRows.map((r) => ({ deal_id: deal.id, product_id: r.product_id, quantity: 1, monthly_price: r.monthly_price }))
        );
        if (lineErr) throw lineErr;

        // fn_recalc_deal_totals-trigger laski total_value/mrr jo tuoterivien
        // lisäyksen yhteydessä palvelimella - haetaan lopullinen summa sieltä,
        // ei lasketa (eikä kysytä) sitä enää erikseen käyttäjältä.
        const { data: recalculatedDeal } = await supabase.from('deals').select('total_value, mrr').eq('id', deal.id).single();

        const ok = await moveOpportunityToStage(opp, targetStage, {
          estimated_value: recalculatedDeal ? recalculatedDeal.total_value : null,
          product_id: lineRows[0].product_id, // ensisijainen tuote listan kärjestä, mahdollisuudella yksi "pääsymbolinen" tuote
          won_deal_id: deal.id,
          probability: targetStage.default_probability // voitto pakottaa aina 100%, ohittaa käsin-muutetun lipun
        });
        if (!ok) return;
      } else if (targetStage.key === 'lost') {
        await moveOpportunityToStage(opp, targetStage, {
          lost_reason: v.lost_reason, lost_competitor: v.lost_competitor || null,
          lost_can_revisit: !!v.can_revisit, lost_revisit_date: v.revisit_date || null,
          probability: targetStage.default_probability, // häviö pakottaa aina 0%, ohittaa käsin-muutetun lipun
          notes: [opp.notes, v.feedback ? `Asiakkaan palaute: ${v.feedback}` : null].filter(Boolean).join('\n')
        });
      }
      $('#genericModal').classList.add('hidden');
    } catch (err) {
      alert(`Tallennus epäonnistui: ${err.message || err}. Kauppa pysyy alkuperäisessä vaiheessa.`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  $('#genericModal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Mahdollisuuden sivupaneeli
// ---------------------------------------------------------------

async function openOpportunityDrawer(oppId) {
  const opp = opportunitiesCache.find((o) => o.id === oppId);
  if (!opp) return;
  const stage = stageById(opp.stage_id);
  const company = opp.companies || {};

  $('#oppDrawerTitle').textContent = company.name || 'Mahdollisuus';
  const body = $('#opportunityDrawerBody');
  body.innerHTML = '<p class="muted">Ladataan…</p>';
  $('#opportunityDrawer').classList.remove('hidden');
  $('#opportunityDrawerOverlay').classList.remove('hidden');

  const [{ data: activities }, { data: followups }, { data: siblingOpps }] = await Promise.all([
    supabase.from('activities').select('*').eq('company_id', opp.company_id).order('occurred_at', { ascending: false }).limit(8),
    supabase.from('followup_tasks').select('*').eq('opportunity_id', opp.id).eq('status', 'open').order('due_date'),
    supabase.from('opportunities').select('id, title, estimated_value, stage_id').eq('company_id', opp.company_id).neq('id', opp.id).is('archived_at', null)
  ]);

  const otherOpps = siblingOpps || [];

  body.innerHTML = `
    <div class="opp-drawer-section">
      <div class="opp-prob-row" title="Todennäköisyys"><div class="opp-prob-bar"><div class="opp-prob-fill" style="width:${opp.probability}%"></div></div><span class="opp-prob-pct">${opp.probability}%</span></div>
      <table class="detail-table">
        <tr><td>Vaihe</td><td>${stage ? escapeHtml(stage.label_fi) : '—'}</td></tr>
        <tr><td>Yhteyshenkilö</td><td>${escapeHtml(company.contact_name || '—')}${company.contact_title ? ' · ' + escapeHtml(company.contact_title) : ''}</td></tr>
        <tr><td>Tuote</td><td>${escapeHtml(opp.products ? opp.products.name : (opp.title || '—'))}</td></tr>
        <tr><td>Arvo</td><td>${money(opp.estimated_value, opp.currency)}</td></tr>
        <tr><td>Vastuuhenkilö</td><td>
          <select id="oppRespSelect">${orgProfilesCache.map((p) => `<option value="${p.id}" ${p.id === opp.responsible_user_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
        </td></tr>
        <tr><td>Todennäköisyys</td><td><input id="oppProbInput" type="number" min="0" max="100" value="${opp.probability}" style="width:70px;" /> %</td></tr>
        <tr><td>Liidin lähde</td><td>${escapeHtml(opp.lead_source || '—')}</td></tr>
        <tr><td>Arvioitu päätöspäivä</td><td>${opp.expected_close_date ? fmtDate(opp.expected_close_date) : '—'}</td></tr>
      </table>
      <button class="btn-primary small" id="openCompanyFromDrawer">Avaa yritys</button>
    </div>

    ${otherOpps.length ? `
    <div class="opp-drawer-section">
      <h4>Muut tämän yrityksen mahdollisuudet (${otherOpps.length})</h4>
      <ul class="muted small">${otherOpps.map((o) => `<li>${escapeHtml(o.title || 'Mahdollisuus')} — ${money(o.estimated_value)}</li>`).join('')}</ul>
    </div>` : ''}

    <div class="opp-drawer-section">
      <h4>Avoimet follow-upit</h4>
      ${(followups || []).length ? `<ul>${followups.map((f) => `<li>${fmtDate(f.due_date)} — ${escapeHtml(f.description || '')}</li>`).join('')}</ul>` : '<p class="muted small">Ei avoimia follow-upeja.</p>'}
      <form id="drawerFollowupForm" class="form-grid">
        <label>Uusi follow-up<input type="date" name="due_date" required min="${todayISO()}" /></label>
        <label class="full">Kuvaus<input name="description" /></label>
        <button type="submit" class="btn-ghost small">Lisää follow-up</button>
      </form>
    </div>

    <div class="opp-drawer-section">
      <h4>Yrityksen viimeisimmät aktiviteetit</h4>
      ${(activities || []).length ? `<ul>${(activities || []).map((a) => `<li><strong>${escapeHtml(a.channel)}</strong> · ${fmtDate(a.occurred_at)} — ${escapeHtml(a.purpose || a.summary || '')}</li>`).join('')}</ul>` : '<p class="muted small">Ei vielä aktiviteetteja.</p>'}
      <form id="drawerActivityForm" class="form-grid">
        <label>Tyyppi<select name="channel"><option value="call">Puhelu</option><option value="email">Sähköposti</option><option value="linkedin">LinkedIn</option><option value="whatsapp">WhatsApp</option><option value="meeting">Tapaaminen</option><option value="other">Muu</option></select></label>
        <label class="full">Muistiinpano<input name="summary" /></label>
        <button type="submit" class="btn-ghost small">Kirjaa aktiviteetti</button>
      </form>
    </div>`;

  $('#openCompanyFromDrawer', body).addEventListener('click', () => { closeOpportunityDrawer(); openCompanyModal(opp.company_id); });

  $('#oppRespSelect', body).addEventListener('change', async (e) => {
    const { error: e1 } = await supabase.from('opportunities').update({ responsible_user_id: e.target.value }).eq('id', opp.id);
    if (e1) { alert(`Vastuuhenkilön vaihto epäonnistui: ${e1.message}`); return; }
    await loadPipeline();
  });
  $('#oppProbInput', body).addEventListener('change', async (e) => {
    const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    const { error: e2 } = await supabase.from('opportunities').update({ probability: val, probability_overridden: true }).eq('id', opp.id);
    if (e2) { alert(`Todennäköisyyden muutos epäonnistui: ${e2.message}`); return; }
    await loadPipeline();
  });

  $('#drawerFollowupForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error: e3 } = await supabase.from('followup_tasks').insert({
      company_id: opp.company_id, partner_id: opp.partner_id, owner_id: opp.responsible_user_id || profile.id,
      due_date: fd.get('due_date'), description: fd.get('description') || null, opportunity_id: opp.id, created_by: profile.id
    });
    if (e3) { alert(`Follow-upin lisäys epäonnistui: ${e3.message}`); return; }
    await loadPipeline();
    openOpportunityDrawer(opp.id);
  });

  $('#drawerActivityForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error: e4 } = await supabase.from('activities').insert({
      company_id: opp.company_id, partner_id: opp.partner_id, performed_by: profile.id,
      channel: fd.get('channel'), summary: fd.get('summary') || null
    });
    if (e4) { alert(`Aktiviteetin kirjaus epäonnistui: ${e4.message}`); return; }
    openOpportunityDrawer(opp.id);
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
// Käyttäjät ja käyttöoikeudet
// ---------------------------------------------------------------

const USER_PAGE_SIZE = 20;
let userListCache = [];
let userOrgsCache = [];
let userFilters = { search: '', role: '', status: '', org: '' };
let userPage = 1;
let userTabsWired = false;
const canSeeMultipleOrgs = () => isOwner || profile.role === 'super_admin';

async function loadUsers() {
  if (!userTabsWired) { wireUserTabs(); userTabsWired = true; }
  await loadUserOrgsIfNeeded();
  await loadUserStats();
  await switchUserTab('users');
}

async function loadUserOrgsIfNeeded() {
  if (!canSeeMultipleOrgs()) return;
  const { data } = await supabase.from('organizations').select('id, name').order('name');
  userOrgsCache = data || [];
  $('#userOrgFilter').classList.remove('hidden');
  $('#userOrgFilter').innerHTML = '<option value="">Kaikki organisaatiot</option>' +
    userOrgsCache.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
}

async function loadUserStats() {
  const [{ data: profiles }, { data: invites }] = await Promise.all([
    supabase.from('profiles').select('active, removed_at'),
    supabase.from('invitations').select('status').eq('status', 'pending')
  ]);
  const total = (profiles || []).length;
  const active = (profiles || []).filter((p) => p.active && !p.removed_at).length;
  const suspended = (profiles || []).filter((p) => !p.active && !p.removed_at).length;
  const pendingInvites = (invites || []).length;

  $('#userStatsRow').innerHTML = `
    <div class="forecast-stat"><span class="fs-label">Käyttäjiä yhteensä</span><span class="fs-value">${total}</span></div>
    <div class="forecast-stat"><span class="fs-label">Aktiivisia</span><span class="fs-value teal">${active}</span></div>
    <div class="forecast-stat"><span class="fs-label">Odottavia kutsuja</span><span class="fs-value">${pendingInvites}</span></div>
    <div class="forecast-stat ${suspended ? 'warn' : ''}"><span class="fs-label">Estettyjä</span><span class="fs-value">${suspended}</span></div>`;
}

function wireUserTabs() {
  $$('[data-user-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchUserTab(btn.dataset.userTab));
  });
  $('#userSearchInput').addEventListener('input', debounce(() => { userFilters.search = $('#userSearchInput').value.trim().toLowerCase(); userPage = 1; renderUserList(); }));
  $('#userRoleFilter').addEventListener('change', () => { userFilters.role = $('#userRoleFilter').value; userPage = 1; renderUserList(); });
  $('#userStatusFilter').addEventListener('change', () => { userFilters.status = $('#userStatusFilter').value; userPage = 1; renderUserList(); });
  $('#userOrgFilter').addEventListener('change', () => { userFilters.org = $('#userOrgFilter').value; userPage = 1; renderUserList(); });
  $('#inviteUserBtn').addEventListener('click', openInviteDrawer);
  $('#inviteDrawerClose').addEventListener('click', closeInviteDrawer);
  $('#inviteDrawerOverlay').addEventListener('click', closeInviteDrawer);
  $('#userLogRefreshBtn').addEventListener('click', loadUserLog);
  $('#userLogTypeFilter').addEventListener('change', loadUserLog);

  const roleFilter = $('#userRoleFilter');
  roleFilter.innerHTML = '<option value="">Kaikki roolit</option>' +
    Object.keys(ROLE_LABELS).map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('');
}

// Yksinkertainen debounce hakukentälle - vähentää turhia re-renderöintejä
// nopean kirjoituksen aikana.
function debounce(fn, delay = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function closeInviteDrawer() {
  $('#inviteDrawer').classList.add('hidden');
  $('#inviteDrawerOverlay').classList.add('hidden');
}

async function switchUserTab(tab) {
  $$('[data-user-tab]').forEach((b) => b.classList.toggle('active', b.dataset.userTab === tab));
  $('#userTabUsers').classList.toggle('hidden', tab !== 'users');
  $('#userTabInvitations').classList.toggle('hidden', tab !== 'invitations');
  $('#userTabRoles').classList.toggle('hidden', tab !== 'roles');
  $('#userTabLog').classList.toggle('hidden', tab !== 'log');

  if (tab === 'users') await loadUserList();
  if (tab === 'invitations') await loadInvitationsList();
  if (tab === 'roles') renderRolesMatrix();
  if (tab === 'log') await loadUserLog();
}

async function loadUserList() {
  const resultsEl = $('#userListResults');
  resultsEl.innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton skeleton-line"></div>').join('');

  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, role, active, removed_at, organization_id, organizations(name), created_at')
    .order('name');

  if (error) {
    resultsEl.innerHTML = `<div class="empty-state"><div class="es-title">Käyttäjien haku epäonnistui</div>${escapeHtml(error.message)} <button class="btn-ghost small" id="userListRetryBtn">Yritä uudelleen</button></div>`;
    $('#userListRetryBtn', resultsEl)?.addEventListener('click', loadUserList);
    return;
  }
  userListCache = data || [];
  renderUserList();
}

function userStatusOf(u) {
  if (u.removed_at) return { key: 'removed', label: 'Ei aktiivinen', cls: 'lost' };
  if (!u.active) return { key: 'suspended', label: 'Käyttö estetty', cls: 'lost' };
  return { key: 'active', label: 'Aktiivinen', cls: 'won' };
}

function renderUserList() {
  const resultsEl = $('#userListResults');
  let rows = userListCache.filter((u) => {
    const status = userStatusOf(u).key;
    if (userFilters.status && status !== userFilters.status) return false;
    if (userFilters.role && u.role !== userFilters.role) return false;
    if (userFilters.org && u.organization_id !== userFilters.org) return false;
    if (userFilters.search && !`${u.name} ${u.email}`.toLowerCase().includes(userFilters.search)) return false;
    return true;
  });

  if (!rows.length) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Ei käyttäjiä hakuehdoilla</div>Kokeile toista hakusanaa tai tyhjennä suodattimet.</div>';
    $('#userListPagination').innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / USER_PAGE_SIZE));
  userPage = Math.min(userPage, totalPages);
  const pageRows = rows.slice((userPage - 1) * USER_PAGE_SIZE, userPage * USER_PAGE_SIZE);

  resultsEl.innerHTML = `
    <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Nimi</th><th>Sähköposti</th><th>Rooli</th><th>Organisaatio</th><th>Tila</th><th>Viimeisin kirjautuminen</th><th></th></tr></thead>
      <tbody>${pageRows.map((u) => {
        const status = userStatusOf(u);
        return `<tr>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${roleLabel(u.role)}</td>
          <td>${escapeHtml(u.organizations ? u.organizations.name : '—')}</td>
          <td><span class="status-pill ${status.cls}">${status.label}</span></td>
          <td class="muted small">Ei tietoa</td>
          <td>
            <div class="dropdown">
              <button class="btn-ghost small" data-action="toggle-more" data-user-id="${u.id}">⋯</button>
              <div class="dropdown-menu hidden" data-more-menu="${u.id}">
                ${userActionMenuHtml(u, status)}
              </div>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    </div>`;
  $('#userListPagination').innerHTML = totalPages > 1
    ? `<button class="btn-ghost small" id="userPagePrev" ${userPage === 1 ? 'disabled' : ''}>‹ Edellinen</button>
       <span class="muted small">Sivu ${userPage} / ${totalPages}</span>
       <button class="btn-ghost small" id="userPageNext" ${userPage === totalPages ? 'disabled' : ''}>Seuraava ›</button>`
    : '';
  $('#userPagePrev')?.addEventListener('click', () => { userPage--; renderUserList(); });
  $('#userPageNext')?.addEventListener('click', () => { userPage++; renderUserList(); });

  wireUserRowActions(resultsEl);
}

// Vain toiminnot joihin kutsuja saattaa oikeasti olla oikeutettu näytetään -
// palvelin tarkistaa aina vielä uudelleen (frontend ei ole ainoa portti,
// kohta 12: "käyttöliittymän piilotetut painikkeet eivät yksin riitä").
function userActionMenuHtml(u, status) {
  const manageable = rolesManageableBy(profile.role, isOwner).includes(u.role);
  const isSelf = u.id === profile.id;
  const items = [];
  items.push(`<button data-action="view-log" data-user-id="${u.id}">Näytä käyttäjän loki</button>`);
  if (manageable && !isSelf) {
    items.push(`<button data-action="change-role" data-user-id="${u.id}">Muokkaa roolia</button>`);
    if (canSeeMultipleOrgs()) items.push(`<button data-action="transfer-org" data-user-id="${u.id}">Siirrä toiseen organisaatioon</button>`);
    if (status.key === 'active') items.push(`<button data-action="suspend" data-user-id="${u.id}" class="danger-item">Estä pääsy</button>`);
    if (status.key !== 'active') items.push(`<button data-action="reactivate" data-user-id="${u.id}">Palauta pääsy</button>`);
    if (status.key !== 'removed') items.push(`<button data-action="remove" data-user-id="${u.id}" class="danger-item">Poista organisaatiosta</button>`);
  }
  return items.join('');
}

function wireUserRowActions(root) {
  $$('[data-action="toggle-more"]', root).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = root.querySelector(`[data-more-menu="${btn.dataset.userId}"]`);
      const wasHidden = menu.classList.contains('hidden');
      $$('.dropdown-menu', root).forEach((m) => m.classList.add('hidden'));
      if (wasHidden) menu.classList.remove('hidden');
    });
  });
  document.addEventListener('click', () => $$('.dropdown-menu', root).forEach((m) => m.classList.add('hidden')), { once: true });

  $$('[data-action="view-log"]', root).forEach((btn) => btn.addEventListener('click', () => { switchUserTab('log'); }));
  $$('[data-action="change-role"]', root).forEach((btn) => btn.addEventListener('click', () => openChangeRoleModal(btn.dataset.userId)));
  $$('[data-action="transfer-org"]', root).forEach((btn) => btn.addEventListener('click', () => openTransferOrgModal(btn.dataset.userId)));
  $$('[data-action="suspend"]', root).forEach((btn) => btn.addEventListener('click', () => doUserAction(btn.dataset.userId, 'suspend', {
    title: 'Estä käyttäjän pääsy', confirmLabel: 'Estä pääsy',
    body: bodyFor(btn.dataset.userId, 'Käyttäjän kaikki pääsy CRM:ään katkeaa välittömästi. Voit palauttaa pääsyn myöhemmin.')
  })));
  $$('[data-action="reactivate"]', root).forEach((btn) => btn.addEventListener('click', () => doUserAction(btn.dataset.userId, 'reactivate', {
    title: 'Palauta käyttäjän pääsy', confirmLabel: 'Palauta pääsy',
    body: bodyFor(btn.dataset.userId, 'Käyttäjä pääsee taas kirjautumaan ja käyttämään CRM:ää normaalisti.')
  })));
  $$('[data-action="remove"]', root).forEach((btn) => btn.addEventListener('click', () => doUserAction(btn.dataset.userId, 'remove', {
    title: 'Poista käyttäjä organisaatiosta', confirmLabel: 'Poista organisaatiosta',
    body: bodyFor(btn.dataset.userId, 'Käyttäjän pääsy katkeaa eikä hän enää näy aktiivisten käyttäjien listassa. Historia- ja lokitiedot säilyvät.'),
    needsReason: true
  })));
}

function bodyFor(userId, impact) {
  const u = userListCache.find((x) => x.id === userId);
  return `<strong>${escapeHtml(u ? u.name : '')}</strong> (${escapeHtml(u ? u.email : '')})<br/>${impact}`;
}

async function doUserAction(userId, action, confirmOpts) {
  const reason = await confirmDangerousAction(confirmOpts);
  if (reason === null) return;
  const resp = await fetch('/.netlify/functions/crm-user-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, user_id: userId, reason: reason || undefined })
  });
  const result = await resp.json();
  if (!resp.ok) { showToast(result.error || 'Toiminto epäonnistui.', 'error'); return; }
  showToast('Toiminto onnistui.', 'success');
  await loadUserStats();
  await loadUserList();
}

function openChangeRoleModal(userId) {
  const u = userListCache.find((x) => x.id === userId);
  if (!u) return;
  const options = rolesManageableBy(profile.role, isOwner);
  const body = $('#genericModalBody');
  body.innerHTML = `
    <h3>Muokkaa roolia</h3>
    <p class="muted">${escapeHtml(u.name)} (${escapeHtml(u.email)})</p>
    <form id="changeRoleForm" class="form-grid">
      <label class="full">Uusi rooli
        <select name="new_role">${options.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select>
      </label>
      <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Tallenna</button></div>
    </form>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));
  $('#changeRoleForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const resp = await fetch('/.netlify/functions/crm-user-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: 'change_role', user_id: userId, new_role: fd.get('new_role') })
    });
    const result = await resp.json();
    if (!resp.ok) { showToast(result.error || 'Roolin vaihto epäonnistui.', 'error'); return; }
    $('#genericModal').classList.add('hidden');
    showToast('Rooli päivitetty.', 'success');
    await loadUserList();
  });
  $('#genericModal').classList.remove('hidden');
}

function openTransferOrgModal(userId) {
  const u = userListCache.find((x) => x.id === userId);
  if (!u) return;
  const body = $('#genericModalBody');
  body.innerHTML = `
    <h3>Siirrä toiseen organisaatioon</h3>
    <p class="muted">${escapeHtml(u.name)} (${escapeHtml(u.email)})</p>
    <form id="transferOrgForm" class="form-grid">
      <label class="full">Uusi organisaatio
        <select name="new_organization_id">${userOrgsCache.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select>
      </label>
      <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Siirrä</button></div>
    </form>`;
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));
  $('#transferOrgForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const resp = await fetch('/.netlify/functions/crm-user-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: 'transfer_org', user_id: userId, new_organization_id: fd.get('new_organization_id') })
    });
    const result = await resp.json();
    if (!resp.ok) { showToast(result.error || 'Siirto epäonnistui.', 'error'); return; }
    $('#genericModal').classList.add('hidden');
    showToast('Käyttäjä siirretty.', 'success');
    await loadUserList();
  });
  $('#genericModal').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Odottavat kutsut
// ---------------------------------------------------------------

async function loadInvitationsList() {
  const resultsEl = $('#invitationsResults');
  resultsEl.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton skeleton-line"></div>').join('');

  const resp = await fetch('/.netlify/functions/crm-invitations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action: 'list' })
  });
  const result = await resp.json();
  if (!resp.ok) {
    resultsEl.innerHTML = `<div class="empty-state"><div class="es-title">Kutsujen haku epäonnistui</div>${escapeHtml(result.error || '')} <button class="btn-ghost small" id="inviteListRetryBtn">Yritä uudelleen</button></div>`;
    $('#inviteListRetryBtn', resultsEl)?.addEventListener('click', loadInvitationsList);
    return;
  }
  const invites = result.invitations || [];
  if (!invites.length) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Ei odottavia kutsuja</div></div>';
    return;
  }

  const STATUS_LABEL = { pending: 'Odottaa', accepted: 'Hyväksytty', expired: 'Vanhentunut', revoked: 'Peruttu' };
  const STATUS_CLS = { pending: '', accepted: 'won', expired: 'lost', revoked: 'lost' };

  resultsEl.innerHTML = `
    <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Nimi</th><th>Sähköposti</th><th>Rooli</th><th>Lähetetty</th><th>Vanhenee</th><th>Tila</th><th>Uudelleenlähetykset</th><th></th></tr></thead>
      <tbody>${invites.map((inv) => `
        <tr>
          <td>${escapeHtml(inv.first_name)} ${escapeHtml(inv.last_name)}</td>
          <td>${escapeHtml(inv.email)}</td>
          <td>${roleLabel(inv.role)}</td>
          <td>${fmtDate(inv.last_sent_at)}</td>
          <td>${fmtDate(inv.expires_at)}</td>
          <td><span class="status-pill ${STATUS_CLS[inv.status] || ''}">${STATUS_LABEL[inv.status] || inv.status}</span>
            ${inv.last_send_error ? `<div class="muted small" style="color:var(--error-600);" title="${escapeHtml(inv.last_send_error)}">Sähköpostivirhe</div>` : ''}</td>
          <td>${inv.resend_count}</td>
          <td>${['pending', 'expired'].includes(inv.status) ? `
            <button class="btn-ghost small" data-invite-action="resend" data-invite-id="${inv.id}">Lähetä uudelleen</button>
            ${inv.status === 'pending' ? `<button class="btn-text small" data-invite-action="revoke" data-invite-id="${inv.id}">Peru</button>` : ''}
          ` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>
    </div>`;

  $$('[data-invite-action="resend"]', resultsEl).forEach((btn) => btn.addEventListener('click', () => doInvitationAction(btn.dataset.inviteId, 'resend')));
  $$('[data-invite-action="revoke"]', resultsEl).forEach((btn) => btn.addEventListener('click', async () => {
    const reason = await confirmDangerousAction({ title: 'Peru kutsu', confirmLabel: 'Peru kutsu', body: 'Kutsulinkki mitätöityy välittömästi eikä sitä voi enää hyväksyä.' });
    if (reason === null) return;
    doInvitationAction(btn.dataset.inviteId, 'revoke');
  }));
}

async function doInvitationAction(invitationId, action) {
  const resp = await fetch('/.netlify/functions/crm-invitations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, invitation_id: invitationId })
  });
  const result = await resp.json();
  if (!resp.ok) { showToast(result.error || 'Toiminto epäonnistui.', 'error'); return; }
  showToast(action === 'resend' ? 'Kutsu lähetetty uudelleen.' : 'Kutsu peruttu.', 'success');
  await loadUserStats();
  await loadInvitationsList();
}

function openInviteDrawer() {
  const body = $('#inviteDrawerBody');
  const roleOptions = rolesManageableBy(profile.role, isOwner);
  body.innerHTML = `
    <form id="inviteForm" class="form-grid">
      <label>Etunimi *<input required name="first_name" /></label>
      <label>Sukunimi *<input required name="last_name" /></label>
      <label class="full">Sähköposti *<input type="email" required name="email" /></label>
      <label class="full">Organisaatio *
        <select name="organization_id" ${canSeeMultipleOrgs() ? '' : 'disabled'}>
          ${canSeeMultipleOrgs()
            ? userOrgsCache.map((o) => `<option value="${o.id}" ${o.id === profile.organization_id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')
            : `<option value="${profile.organization_id}">Oma organisaatio</option>`}
        </select>
      </label>
      <label class="full">Rooli *
        <select required name="role">${roleOptions.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select>
      </label>
      <label>Puhelin<input name="phone" /></label>
      <label>Tiimi<input name="team" /></label>
      <label class="full">Kutsun mukana lähetettävä viesti<textarea name="message" rows="2"></textarea></label>
      <div class="form-actions full">
        <button type="button" class="btn-ghost" id="inviteDrawerCancel">Peruuta</button>
        <button type="submit" class="btn-primary">Lähetä kutsu</button>
      </div>
    </form>`;
  $('#inviteDrawerCancel', body).addEventListener('click', closeInviteDrawer);

  const form = $('#inviteForm', body);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true; // estää kaksoislähetyksen
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    if (!canSeeMultipleOrgs()) payload.organization_id = profile.organization_id;

    try {
      const resp = await fetch('/.netlify/functions/crm-invite-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(payload)
      });
      const result = await resp.json();
      if (!resp.ok) { showToast(result.error || 'Kutsun lähetys epäonnistui.', 'error'); return; }
      closeInviteDrawer();
      showToast('Kutsu lähetetty onnistuneesti.', 'success');
      await loadUserStats();
      await loadUserList();
    } finally {
      submitBtn.disabled = false;
    }
  });

  $('#inviteDrawer').classList.remove('hidden');
  $('#inviteDrawerOverlay').classList.remove('hidden');
}

// ---------------------------------------------------------------
// Roolit ja käyttöoikeudet - lukunäkymä (ei editoitava per-käyttäjä
// permissions-matriisi tässä vaiheessa, ks. "Käyttäjähallinnan
// määrittely" -dokumentti kohta 04: rajattu tietoisesti myöhempään
// vaiheeseen ison RLS-uudelleenkirjoituksen vuoksi. Tämä näyttää REHELLISESTI
// nykyisen, roolipohjaisen ja jo RLS:ssä todennetun mallin.)
// ---------------------------------------------------------------

const ROLE_MODULE_ACCESS = {
  owner_super_admin: { Dashboard: 'Täysi', Yritykset: 'Täysi', Myyntiputki: 'Täysi', 'Follow-upit': 'Täysi', 'Buyer Intelligence': 'Täysi', 'Partner Management': 'Täysi', Käyttäjähallinta: 'Täysi', Lokikirja: 'Täysi (kaikki)', Asetukset: 'Täysi' },
  super_admin: { Dashboard: 'Täysi', Yritykset: 'Täysi', Myyntiputki: 'Täysi', 'Follow-upit': 'Täysi', 'Buyer Intelligence': 'Ei oikeutta', 'Partner Management': 'Katselu', Käyttäjähallinta: 'Täysi (ei omistajaa)', Lokikirja: 'Täysi (valtuutetut org.)', Asetukset: 'Ei oikeutta' },
  partner_admin: { Dashboard: 'Muokkaus', Yritykset: 'Muokkaus', Myyntiputki: 'Muokkaus', 'Follow-upit': 'Muokkaus', 'Buyer Intelligence': 'Ei oikeutta', 'Partner Management': 'Ei oikeutta', Käyttäjähallinta: 'Muokkaus (oma org.)', Lokikirja: 'Katselu (oma org.)', Asetukset: 'Ei oikeutta' },
  partner_user: { Dashboard: 'Katselu', Yritykset: 'Muokkaus', Myyntiputki: 'Muokkaus', 'Follow-upit': 'Muokkaus', 'Buyer Intelligence': 'Ei oikeutta', 'Partner Management': 'Ei oikeutta', Käyttäjähallinta: 'Ei oikeutta', Lokikirja: 'Ei oikeutta', Asetukset: 'Ei oikeutta' },
  read_only: { Dashboard: 'Katselu', Yritykset: 'Katselu', Myyntiputki: 'Katselu', 'Follow-upit': 'Katselu', 'Buyer Intelligence': 'Ei oikeutta', 'Partner Management': 'Ei oikeutta', Käyttäjähallinta: 'Ei oikeutta', Lokikirja: 'Ei oikeutta', Asetukset: 'Ei oikeutta' }
};
const MODULE_ORDER = ['Dashboard', 'Yritykset', 'Myyntiputki', 'Follow-upit', 'Buyer Intelligence', 'Partner Management', 'Käyttäjähallinta', 'Lokikirja', 'Asetukset'];

function renderRolesMatrix() {
  $('#rolesMatrix').innerHTML = `
    <p class="muted small" style="max-width:64ch;">Nykyinen malli on roolipohjainen (RBAC) - jokainen käyttäjä saa yhden roolin, ja rooli määrää oikeudet alla olevan taulukon mukaisesti. Hienojakoisempi, per-käyttäjä muokattava oikeusmatriisi on suunniteltu mutta rajattu tietoisesti myöhempään vaiheeseen (vaatisi kaikkien tietokannan käyttöoikeussääntöjen uudelleenkirjoituksen).</p>
    <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Moduuli</th>${Object.keys(ROLE_LABELS).map((r) => `<th>${roleLabel(r)}</th>`).join('')}</tr></thead>
      <tbody>${MODULE_ORDER.map((mod) => `<tr><td>${mod}</td>${Object.keys(ROLE_LABELS).map((r) => `<td>${ROLE_MODULE_ACCESS[r][mod]}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    </div>`;
}

// ---------------------------------------------------------------
// Lokikirja (käyttäjähallinnan tapahtumat)
// ---------------------------------------------------------------

const USER_LOG_TABLES = ['profiles', 'invitations'];

async function loadUserLog() {
  const resultsEl = $('#userLogResults');
  resultsEl.innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton skeleton-line"></div>').join('');

  const typeFilter = $('#userLogTypeFilter').value;
  let query = supabase.from('audit_log').select('*').in('table_name', USER_LOG_TABLES).order('changed_at', { ascending: false }).limit(200);
  if (typeFilter) query = query.eq('action', typeFilter);
  if (!isOwner && profile.role !== 'super_admin') query = query.eq('partner_id', profile.organization_id);

  const { data, error } = await query;
  if (error) {
    resultsEl.innerHTML = `<div class="empty-state"><div class="es-title">Lokin haku epäonnistui</div>${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!$('#userLogTypeFilter').options.length || $('#userLogTypeFilter').options.length <= 1) {
    $('#userLogTypeFilter').innerHTML = '<option value="">Kaikki tapahtumat</option>' +
      [...new Set((data || []).map((r) => r.action))].map((a) => `<option value="${a}">${a}</option>`).join('');
  }
  if (!data || !data.length) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Ei lokitapahtumia</div></div>';
    return;
  }
  resultsEl.innerHTML = `
    <div class="table-scroll">
    <table class="data">
      <thead><tr><th>Aika</th><th>Taulu</th><th>Tapahtuma</th><th>Kenttä</th><th>Vanha arvo</th><th>Uusi arvo</th></tr></thead>
      <tbody>${data.map((r) => `<tr>
        <td>${fmtDateTime(r.changed_at)}</td>
        <td>${escapeHtml(r.table_name)}</td>
        <td>${escapeHtml(r.action)}</td>
        <td>${escapeHtml(r.field_name || '—')}</td>
        <td>${escapeHtml(r.old_value || '—')}</td>
        <td>${escapeHtml(r.new_value || '—')}</td>
      </tr>`).join('')}</tbody>
    </table>
    </div>`;
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
    { data: deals }, { data: openJobsHigh }, { data: pendingDMs }, { data: partners }, { data: ledgerRows }
  ] = await Promise.all([
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null)
      .eq('status_id', leadStatuses.find((s) => s.key === 'new_lead')?.id || '00000000-0000-0000-0000-000000000000'),
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null).gte('created_at', weekAgo),
    supabase.from('activities').select('id', { count: 'exact', head: true }).gte('occurred_at', weekAgo),
    supabase.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null).is('last_contacted_at', null),
    supabase.from('followup_tasks').select('id', { count: 'exact', head: true }).eq('status', 'open').lt('due_date', today),
    supabase.from('deals').select('mrr, arr, partner_id').is('archived_at', null),
    supabase.from('job_postings').select('company_id').eq('status', 'open'),
    supabase.from('decision_makers').select('id', { count: 'exact', head: true }).eq('review_status', 'pending'),
    supabase.from('organizations').select('id, name').eq('type', 'certified_partner'),
    // Ks. loadDashboard()/loadOwnerPartnerPerformance() - sama periaate,
    // provisio commission_ledgeristä, ei enää deals.commission_amount:sta.
    supabase.from('commission_ledger').select('commission_amount')
  ]);

  const totalMrr = (deals || []).reduce((s, d) => s + (Number(d.mrr) || 0), 0);
  const totalArr = (deals || []).reduce((s, d) => s + (Number(d.arr) || 0), 0);
  const totalCommission = (ledgerRows || []).reduce((s, r) => s + (Number(r.commission_amount) || 0), 0);
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

  // Kaupunkisuodatin (Advanced Filters) haetaan PRH:n omalla
  // location-parametrilla - tukee useaa kaupunkia pilkulla erotettuna
  // (OR-haku, ks. owner-prh-search.js). Haku voi siis toimia joko
  // nimellä/Y-tunnuksella, kaupungilla, tai molemmilla yhdessä.
  const locations = (ownerSearchFilters.city || '').split(',').map((c) => c.trim()).filter(Boolean);

  if (!input && !locations.length) {
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Anna hakusana tai kaupunki</div>Hae yrityksen nimellä, Y-tunnuksella (esim. 1234567-8), tai valitse kaupunki Lisää suotimet -valikosta.</div>';
    return;
  }
  const isBusinessId = BUSINESS_ID_PATTERN.test(input);

  // Skeleton-lataustila - ei tyhjä sivu haun ajan.
  resultsEl.innerHTML = Array.from({ length: 4 }, () => `
    <div class="search-card"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-card"></div></div>`).join('');

  const body = {};
  if (input) { if (isBusinessId) body.business_id = input; else body.name = input; }
  if (locations.length) body.locations = locations;

  let resp, result;
  try {
    resp = await fetch('/.netlify/functions/owner-prh-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body)
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
    resultsEl.innerHTML = '<div class="empty-state"><div class="es-title">Ei tuloksia</div>Tarkista kirjoitusasu, kokeile Y-tunnuksella (muoto 1234567-8), tai laajenna kaupunkihakua.</div>';
    return;
  }

  lastOwnerSearchResults = result.results;
  lastOwnerSearchMeta = result;
  $('#ownerSearchMetaRow').classList.remove('hidden');
  renderOwnerSearchResults();
}

// Tarkistaa täsmääkö tuloksen JOKIN osoite (ei vain ensimmäinen) johonkin
// halutuista kaupungeista, JONKIN kielisen postOffices-nimen perusteella
// (ei vain suomenkielisen) - maksimoi osumat, koska tätä käytetään
// varmistuksena PRH:n oman location-haun päälle (ks. alla).
function addressMatchesAnyCity(r, wantedLower) {
  const addresses = r.addresses || [];
  return addresses.some((address) => {
    const pos = (address && address.postOffices) || [];
    return pos.some((po) => {
      const city = (po.city || '').toLowerCase();
      return wantedLower.some((w) => city.includes(w));
    });
  });
}

function filteredSortedOwnerSearchResults() {
  const f = ownerSearchFilters;
  // Kaupunki haetaan PRH:sta suoraan location-parametrilla
  // (ks. runOwnerCompanySearch) parhaan kattavuuden vuoksi, MUTTA PRH ei
  // aina suodata luotettavasti yhdistettynä nimihakuun (havaittu käytännössä:
  // nimihaku + location palautti myös muiden kaupunkien osumia). Siksi
  // kaupunki tarkistetaan silti myös tässä varmistukseksi - "trust but verify".
  const wantedCities = (f.city || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  let rows = lastOwnerSearchResults.filter((r) => {
    if (wantedCities.length && !addressMatchesAnyCity(r, wantedCities)) return false;
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
  const city = resolvePrhCity(address);

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
            ${r.business_id ? `<button data-action="open-kauppalehti" data-idx="${idx}">Avaa Kauppalehdessä ↗</button>` : ''}
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
        const city = resolvePrhCity(address) || '—';
        return `<tr>
          <td>${escapeHtml(r.name || '—')}</td>
          <td>${r.business_id
            ? `<a class="source-link" href="https://tietopalvelu.ytj.fi/yritys/${encodeURIComponent(r.business_id)}" target="_blank" rel="noopener" title="Avaa yrityksen tiedot YTJ:n virallisella tietopalvelusivulla">${escapeHtml(r.business_id)} ↗</a>`
            : '—'}</td>
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
  $$('[data-action="open-kauppalehti"]', resultsEl).forEach((btn) => {
    const r = lastOwnerSearchResults[Number(btn.dataset.idx)];
    const url = kauppalehtiCompanyUrl(r.business_id);
    if (url) btn.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
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

  // Duplikaatti-/liidisuojatarkistus AINA ennen lisäystä (kohta 10), 90 päivän
  // liidisuoja huomioiden - ks. supabase/migrations/0009_lead_claim_protection.sql.
  const { data: check } = await supabase.rpc('fn_check_lead_claim', {
    p_name: record.name, p_business_id: record.business_id, p_website: null,
    p_country: 'FI', p_city: resolvePrhCity(address), p_email: null, p_phone: null
  });

  if (check && ['active_elsewhere', 'own_active'].includes(check.result)) {
    const proceed = confirm(`${check.message}\n\nYritystä ei lisätä uudelleen. Avataanko olemassa oleva yritys?`);
    if (proceed && check.company_id) await openCompanyModal(check.company_id);
    return null;
  }
  if (check && check.result === 'expired_reclaimable') {
    const proceed = confirm(`${check.message}\n\nVarataanko yritys nyt AerWorkille?`);
    if (!proceed) return null;
    const { data: reclaimed, error: reclaimErr } = await supabase.rpc('fn_reclaim_expired_company', {
      p_company_id: check.company_id, p_owning_partner_id: AERWORK_ORG_ID, p_created_by: profile.id
    });
    if (reclaimErr || !reclaimed.ok) { showToast((reclaimed && reclaimed.error) || (reclaimErr && reclaimErr.message) || 'Varaus epäonnistui.', 'error'); return null; }
    await openCompanyModal(reclaimed.company.id);
    return reclaimed.company;
  }

  const { data: claimResult, error } = await supabase.rpc('fn_create_company_claim', {
    p_company: {
      owning_partner_id: AERWORK_ORG_ID, // "pitää liidin vain AerWorkin omassa hallinnassa" kunnes osoitetaan partnerille
      name: record.name,
      business_id: record.business_id,
      country: 'FI',
      city: resolvePrhCity(address),
      industry: record.main_business_line || null,
      status_id: leadStatuses.find((s) => s.key === 'new_lead')?.id || null,
      currency: 'EUR',
      lead_source: 'owner_company_search',
      created_by: profile.id
    }
  });

  if (error || !claimResult.ok) {
    showToast((claimResult && claimResult.check && claimResult.check.message) || (error && error.message) || 'Lisäys epäonnistui.', 'error');
    return null;
  }
  const newCompany = claimResult.company;

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
    showToast(`"${record.name}" lisätty CRM:ään.`, 'success');
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

let ownerPartnersCache = [];

async function loadOwnerPartnerPerformance() {
  const el = $('#ownerPartnerPerformance');
  el.innerHTML = '<p class="muted">Ladataan…</p>';

  const [{ data: partners }, { data: companies }, { data: deals }, { data: ledgerRows }] = await Promise.all([
    supabase.from('organizations').select(
      'id, name, created_at, partner_level, partner_level_set_at, partner_custom_subscription_rate, partner_custom_ai_credit_rate, partner_custom_period_months'
    ).eq('type', 'certified_partner'),
    supabase.from('companies').select('id, owning_partner_id, commission_period_ends_at').is('archived_at', null),
    supabase.from('deals').select('partner_id, mrr, arr, status_id').is('archived_at', null),
    // Kumppanuus- ja Revenue Share -sopimuksen mukainen provisio - vain
    // lukitun provisiokauden sisällä, ei enää deals.commission_amount:sta.
    supabase.from('commission_ledger').select('partner_id, commission_amount')
  ]);
  ownerPartnersCache = partners || [];

  const today = todayISO();
  el.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Certified Partner</th><th>Taso</th><th>Yrityksiä</th><th>Aktiivisia sopimuksia</th>
        <th>MRR</th><th>ARR</th><th>Kertynyt provisio</th><th>Päättymässä (&lt;30 pv)</th><th></th>
      </tr></thead>
      <tbody>${(partners || []).map((p) => {
        const partnerCompanies = (companies || []).filter((c) => c.owning_partner_id === p.id);
        const partnerDeals = (deals || []).filter((d) => d.partner_id === p.id);
        const mrr = partnerDeals.reduce((s, d) => s + (Number(d.mrr) || 0), 0);
        const arr = partnerDeals.reduce((s, d) => s + (Number(d.arr) || 0), 0);
        const commission = (ledgerRows || []).filter((r) => r.partner_id === p.id)
          .reduce((s, r) => s + (Number(r.commission_amount) || 0), 0);
        const endingSoon = partnerCompanies.filter((c) => c.commission_period_ends_at
          && c.commission_period_ends_at >= today
          && (new Date(c.commission_period_ends_at) - Date.now()) < 30 * 86400000).length;
        return `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td><span class="badge">${escapeHtml(partnerTierLabel(p.partner_level))}</span></td>
          <td>${partnerCompanies.length}</td><td>${partnerDeals.length}</td>
          <td>${money(mrr)}</td><td>${money(arr)}</td><td>${money(commission)}</td>
          <td>${endingSoon > 0 ? `<span class="badge alert">${endingSoon}</span>` : '0'}</td>
          <td><button type="button" class="btn-ghost small" data-change-tier="${p.id}">Muuta tasoa</button></td>
        </tr>`;
      }).join('') || '<tr><td colspan="9">Ei Certified Partnereita vielä.</td></tr>'}</tbody>
    </table>`;

  $$('[data-change-tier]', el).forEach((b) => b.addEventListener('click', () => openChangePartnerLevelModal(b.dataset.changeTier)));
}

function openChangePartnerLevelModal(partnerId) {
  const p = ownerPartnersCache.find((x) => x.id === partnerId);
  if (!p) return;
  const body = $('#genericModalBody');
  const renderStrategicFields = (show) => `
    <div id="strategicFieldsWrap" class="${show ? '' : 'hidden'}">
      <p class="muted small">Strategic Partner -taso ei anna kiinteää prosenttia automaattisesti (sopimus: "25 %:n revenue share ei synny automaattisesti") - aseta tarkat arvot itse, korkeintaan sopimuksen kattoarvoihin asti.</p>
      <label>Subscription Revenue Share, enint. 25 %
        <input type="number" name="custom_subscription_rate" min="0" max="25" step="0.5" value="${p.partner_custom_subscription_rate ?? ''}" />
      </label>
      <label>AI Credit Revenue Share, enint. 15 %
        <input type="number" name="custom_ai_credit_rate" min="0" max="15" step="0.5" value="${p.partner_custom_ai_credit_rate ?? ''}" />
      </label>
      <label>Provisiokausi kuukausina, enint. 24
        <input type="number" name="custom_period_months" min="1" max="24" step="1" value="${p.partner_custom_period_months ?? ''}" />
      </label>
    </div>`;
  body.innerHTML = `
    <h3>Muuta kumppanitasoa</h3>
    <p class="muted">${escapeHtml(p.name)} — nykyinen taso: ${escapeHtml(partnerTierLabel(p.partner_level))}</p>
    <form id="changeTierForm" class="form-grid">
      <label class="full">Uusi taso
        <select name="new_level" id="newTierSelect">
          ${Object.keys(PARTNER_TIER_LABELS).map((lvl) => `<option value="${lvl}" ${lvl === p.partner_level ? 'selected' : ''}>${PARTNER_TIER_LABELS[lvl]}${PARTNER_TIER_DEFAULTS[lvl] ? ` (${PARTNER_TIER_DEFAULTS[lvl].subscription_rate}% / ${PARTNER_TIER_DEFAULTS[lvl].period_months} kk)` : ''}</option>`).join('')}
        </select>
      </label>
      <div class="full">${renderStrategicFields(p.partner_level === 'strategic')}</div>
      <label class="full">Syy (pakollinen)
        <textarea name="reason" rows="2" required placeholder="Esim. koulutus suoritettu, osoittanut itsenäistä myyntikykyä…"></textarea>
      </label>
      <p class="muted small full">Huom: muutos ei vaikuta jo käynnissä oleviin asiakkaiden provisiokausiin — vain uusiin, tämän jälkeen syntyviin Partner Customereihin.</p>
      <div class="form-actions full"><button type="button" class="btn-ghost" data-close-modal>Peruuta</button><button type="submit" class="btn-primary">Tallenna</button></div>
    </form>`;
  $('#newTierSelect', body).addEventListener('change', (e) => {
    $('#strategicFieldsWrap', body).classList.toggle('hidden', e.target.value !== 'strategic');
  });
  $$('[data-close-modal]', body).forEach((b) => b.addEventListener('click', () => $('#genericModal').classList.add('hidden')));
  $('#changeTierForm', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const newLevel = fd.get('new_level');
    const params = {
      p_partner_id: partnerId,
      p_new_level: newLevel,
      p_reason: (fd.get('reason') || '').trim(),
      p_custom_subscription_rate: newLevel === 'strategic' ? Number(fd.get('custom_subscription_rate')) || null : null,
      p_custom_ai_credit_rate: newLevel === 'strategic' ? Number(fd.get('custom_ai_credit_rate')) || null : null,
      p_custom_period_months: newLevel === 'strategic' ? Number(fd.get('custom_period_months')) || null : null
    };
    const { error } = await supabase.rpc('fn_set_partner_level', params);
    if (error) { showToast(error.message || 'Tason muutos epäonnistui.', 'error'); return; }
    $('#genericModal').classList.add('hidden');
    showToast('Kumppanitaso päivitetty.', 'success');
    await loadOwnerPartnerPerformance();
  });
  $('#genericModal').classList.remove('hidden');
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
