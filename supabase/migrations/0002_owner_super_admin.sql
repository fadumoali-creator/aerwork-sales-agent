-- AerWork Certified Partner CRM — Owner Super Admin -laajennus
-- =============================================================
-- Lisää Fadumo Alille henkilökohtaisen "Owner Super Admin" -tason ja
-- B2B-prospektointi-/johtamisnäkymän. EI muuta olemassa olevaa
-- companies/contacts/activities/deals-rakennetta — kaikki uusi on
-- lisäys, linkittyy company_id:llä.
--
-- PÄÄSYN KOLMOISPORTTI (ks. is_owner_super_admin()):
--   1) voimassa oleva Supabase-sessio (auth.uid())
--   2) profiles.role = 'owner_super_admin'
--   3) owner_allowlist-rivi user_id:lle, active = true
-- KAIKKI KOLME tarkistetaan RLS:ssä JA jokaisessa Netlify-funktiossa erikseen.
--
-- Aja Supabase SQL Editorissa migraation 0001 PÄÄLLE (ei korvaa sitä).
-- =============================================================

-- ---------------------------------------------------------------
-- 1. ROOLI + OWNER ALLOWLIST
-- ---------------------------------------------------------------

alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('owner_super_admin', 'super_admin', 'partner_admin', 'partner_user', 'read_only'));

-- Erillinen, tietoisesti pieni ja käsin ylläpidetty taulu. EI kirjoitusoikeutta
-- sovelluksesta ilman service-rolea (ks. netlify/functions/owner-*.js) — rivit
-- lisätään aina SQL Editorista tai service-role-funktiolla, EI koskaan pelkän
-- roolivalinnan perusteella UI:ssa.
create table owner_allowlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id),
  email text not null unique,
  approved_by uuid references profiles (id),
  approved_at timestamptz not null default now(),
  active boolean not null default true,
  notes text
);
comment on table owner_allowlist is 'Käsin ylläpidetty hyväksyntälista Owner Super Admin -roolille. Rooli profiles-taulussa EI YKSIN riitä pääsyyn - ks. is_owner_super_admin().';

alter table owner_allowlist enable row level security;
-- Ei policyja tavalliselle roolille lainkaan (paitsi lukuoikeus ownerille itselleen
-- alla) — kirjoitus tehdään aina service-rolella funktioista.
create or replace function public.is_owner_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    join owner_allowlist oa on oa.user_id = p.id and oa.active
    where p.id = auth.uid() and p.role = 'owner_super_admin' and p.active
  );
$$;
create policy owner_reads_own_allowlist on owner_allowlist for select
  using (user_id = auth.uid() and is_owner_super_admin());

-- ---------------------------------------------------------------
-- 2. ULKOISET YRITYSTIEDOT (lähdetieto, EI koskaan ylikirjoiteta)
-- ---------------------------------------------------------------

create table external_company_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id),
  business_id text,
  name text,
  source text not null,           -- 'prh_ytj' | 'web_search' | ...
  source_url text,
  raw_payload jsonb not null,
  confidence text not null check (confidence in
    ('virallinen_rekisteri', 'yrityksen_oma_julkaisu', 'vahvistettu_lisenssi', 'muu_julkinen', 'ai_paattely', 'vahvistamaton')),
  fetched_at timestamptz not null default now(),
  last_verified_at timestamptz,
  expires_at timestamptz,
  created_by uuid references profiles (id)
);
create index external_company_records_company_idx on external_company_records (company_id);
create index external_company_records_business_id_idx on external_company_records (business_id);

-- ---------------------------------------------------------------
-- 3. PÄÄTTÄJÄT
-- ---------------------------------------------------------------

create table decision_makers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id),
  name text not null,
  title text,
  linkedin_url text,
  source text not null,
  source_url text,
  email text,
  phone text,
  confidence text not null check (confidence in
    ('virallinen_rekisteri', 'yrityksen_oma_julkaisu', 'vahvistettu_lisenssi', 'muu_julkinen', 'ai_paattely', 'vahvistamaton')),
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  contact_id uuid references contacts (id),
  found_at timestamptz not null default now(),
  last_verified_at timestamptz,
  notes text,
  contact_status text,
  last_contacted_at date,
  next_followup_date date,
  created_by uuid references profiles (id)
);
create index decision_makers_company_idx on decision_makers (company_id);

-- ---------------------------------------------------------------
-- 4. AVOIMET TYÖPAIKAT
-- ---------------------------------------------------------------

create table job_postings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id),
  title text not null,
  location text,
  category text,
  is_shift_work boolean default false,
  is_hr_related boolean default false,
  is_payroll_related boolean default false,
  is_recruiting_related boolean default false,
  employment_type text,
  remote_option text,
  source text not null,
  source_url text not null,
  posting_key text not null unique, -- normalisoitu duplikaattien estoon (yritys+titteli+sijainti+lähde)
  status text not null default 'open' check (status in ('open', 'closed', 'unknown')),
  published_at date,
  application_deadline date,
  contact_person text,
  opportunity_note text,
  first_seen_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now()
);
create index job_postings_company_idx on job_postings (company_id);

-- ---------------------------------------------------------------
-- 5. AERWORK OPPORTUNITY SCORE
-- ---------------------------------------------------------------

create table opportunity_scores (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) unique,
  score int not null check (score between 0 and 100),
  tier text not null check (tier in ('matala', 'keskitaso', 'korkea')),
  signals jsonb not null,      -- [{signal, points, evidence}]
  missing_data jsonb not null default '[]',
  recommended_product text,
  recommended_action text,
  rationale text,
  calculated_by uuid references profiles (id),
  calculated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 6. TALLENNETUT HAUT (rakenne valmiina, EI automaattiajastusta MVP:ssä)
-- ---------------------------------------------------------------

create table saved_searches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  filters jsonb not null,
  data_sources text[] default '{}',
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_run_new_count int,
  notify_on_new boolean not null default false,
  schedule_cron text  -- valmiina tulevaa varten; ei ajastinta MVP:ssä
);

-- ---------------------------------------------------------------
-- 7. LIIDIEN JAKAMINEN CERTIFIED PARTNEREILLE
-- ---------------------------------------------------------------

create table lead_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  assigned_to_partner_id uuid references organizations (id),
  assigned_to_user_id uuid references profiles (id),
  assigned_product text,
  priority text check (priority in ('A', 'B', 'C')),
  instructions text,
  ownership_expires_at date,
  visibility_scope text not null default 'assigned_partner'
    check (visibility_scope in ('owner_only', 'aerwork_internal', 'assigned_partner', 'shared_with_selected_users')),
  status text not null default 'active' check (status in ('active', 'returned', 'completed')),
  assigned_by uuid not null references profiles (id),
  assigned_at timestamptz not null default now(),
  returned_at timestamptz,
  return_reason text
);
create index lead_assignments_company_idx on lead_assignments (company_id);
create index lead_assignments_partner_idx on lead_assignments (assigned_to_partner_id);

-- ---------------------------------------------------------------
-- 8. TIETOLÄHTEET JA INTEGRAATIOKÄYTTÖ
-- ---------------------------------------------------------------

create table data_sources (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  label text not null,
  status text not null default 'not_configured'
    check (status in ('available', 'not_available', 'requires_integration', 'requires_paid_source', 'check_failed', 'not_configured')),
  requires_license boolean not null default false,
  config jsonb default '{}',
  notes text
);

create table integration_usage_log (
  id uuid primary key default gen_random_uuid(),
  data_source_key text not null,
  action text not null,
  company_id uuid references companies (id),
  requested_by uuid references profiles (id),
  request_summary text,
  result_count int,
  estimated_cost numeric(10, 4),
  currency text default 'EUR',
  succeeded boolean not null,
  error_message text,
  created_at timestamptz not null default now()
);
create index integration_usage_log_source_idx on integration_usage_log (data_source_key, created_at desc);

-- ---------------------------------------------------------------
-- 9. RLS — kaikki yllä olevat taulut vain Owner Super Adminille,
--    paitsi lead_assignments joka näkyy myös osoitetulle partnerille rajatusti.
-- ---------------------------------------------------------------

alter table external_company_records enable row level security;
alter table decision_makers enable row level security;
alter table job_postings enable row level security;
alter table opportunity_scores enable row level security;
alter table saved_searches enable row level security;
alter table lead_assignments enable row level security;
alter table data_sources enable row level security;
alter table integration_usage_log enable row level security;

create policy owner_only on external_company_records for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy owner_only on decision_makers for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy owner_only on job_postings for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy owner_only on opportunity_scores for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy owner_only on saved_searches for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy owner_only on data_sources for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy owner_only on integration_usage_log for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());

create policy owner_write on lead_assignments for all
  using (is_owner_super_admin()) with check (is_owner_super_admin());
create policy partner_reads_own_assignment on lead_assignments for select
  using (
    not is_owner_super_admin()
    and assigned_to_partner_id = current_org_id()
    and visibility_scope in ('assigned_partner', 'shared_with_selected_users')
    and status = 'active'
  );

-- ---------------------------------------------------------------
-- 10. AUDIT LOG — laajenna sallitut action-tyypit
-- ---------------------------------------------------------------

alter table audit_log drop constraint audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in ('create', 'update', 'archive', 'restore', 'search', 'assign', 'enrich', 'export'));

-- ---------------------------------------------------------------
-- 11. SIEMENDATA: data_sources — rehellinen tila jokaiselle lähteelle
-- ---------------------------------------------------------------

insert into data_sources (key, label, status, requires_license, notes) values
  ('prh_ytj', 'PRH/YTJ avoindata (Y-tunnus, nimi, yritysmuoto, toimiala, rekisterit)', 'available', false,
    'Käytössä jo LinkedIn-agentissa, uudelleenkäytetty. Ei sisällä liikevaihtoa/tulosta/henkilöstömäärää.'),
  ('web_search', 'Yleinen web-haku (uutiset, toimialasignaalit, julkiset maininnat)', 'available', false,
    'Anthropicin web_search-työkalu, rajattu hakumäärä per pyyntö.'),
  ('financial_data', 'Taloustiedot (liikevaihto, tulos, henkilöstömäärän kasvu)', 'requires_paid_source', true,
    'Vaatii maksullisen sopimuksen (esim. Asiakastieto, Vainu, Bisnode). Ei käytössä.'),
  ('linkedin_api', 'LinkedIn viralliset rajapinnat', 'not_available', true,
    'Ei AerWorkilla käyttöoikeutta. Ei scrapata - vain käyttäjän liittämät julkiset URL:t.'),
  ('job_board_feed', 'Työpaikkasyötteet (esim. Duunitori)', 'requires_integration', true,
    'Vaatii oman API-sopimuksen/integraation valitun palvelun kanssa. Ei käytössä MVP:ssä.');
