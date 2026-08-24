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
  wireNav();
  wireModals();

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

  if (['super_admin', 'partner_admin'].includes(profile.role)) {
    $$('.admin-only').forEach((el) => el.classList.remove('hidden'));
  }

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
// Navigation
// ---------------------------------------------------------------

function wireNav() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
}

async function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));

  if (view === 'dashboard') await loadDashboard();
  if (view === 'companies') await loadCompanies();
  if (view === 'pipeline') await loadPipeline();
  if (view === 'followups') await loadFollowups();
  if (view === 'users') await loadUsers();
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
  `;

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
      $('#inviteResult').textContent = `Virhe: ${result.error}${result.debug_reason ? ` [${result.debug_reason}]` : ''}`;
      $('#inviteResult').classList.add('error-text');
      return;
    }
    $('#inviteResult').textContent = 'Kutsu lähetetty onnistuneesti.';
    await loadUsers();
  });

  $('#genericModal').classList.remove('hidden');
}

init();
