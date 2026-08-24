-- AerWork Certified Partner CRM — perusskeema
-- =============================================================
-- Tämä migraatio luo koko CRM:n relaatiorakenteen, partnerikohtaisen
-- tietoeristyksen (Row Level Security) ja audit-lokin. Kaikki oikeudet
-- on toteutettu TIETOKANTATASOLLA (RLS-policyt), ei vain sovelluksessa —
-- vaikka joku kutsuisi Supabasen REST/PostgREST-rajapintaa suoraan
-- toisen käyttäjän tunnuksilla, hän ei voi nähdä toisen partnerin dataa.
--
-- Aja tämä Supabase-projektissasi: Dashboard → SQL Editor → liitä koko
-- tiedosto, TAI `supabase db push` jos käytät Supabase CLI:tä.
-- =============================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------
-- 1. ORGANISAATIOT JA KÄYTTÄJÄT
-- ---------------------------------------------------------------

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('aerwork', 'certified_partner')),
  country text,
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
comment on table organizations is 'AerWork itse (type=aerwork, tyypillisesti yksi rivi) ja jokainen Certified Partner -organisaatio.';

-- profiles laajentaa Supabase Authin auth.users-taulua roolilla ja organisaatiolla.
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id),
  email text not null,
  name text not null,
  role text not null check (role in ('super_admin', 'partner_admin', 'partner_user', 'read_only')),
  active boolean not null default true,
  invited_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
comment on table profiles is 'Käyttäjän rooli + organisaatio. Luodaan aina auth.users-rivin rinnalle (ks. netlify/functions/crm-invite-user.js), ei koskaan suoraan clientistä.';

-- Helper-funktiot RLS-policyihin. SECURITY DEFINER + kiinteä search_path,
-- jotta ne voivat lukea profiles-taulua turvallisesti ilman rekursiivista
-- RLS-tarkistusta ja ilman search_path-hyväksikäyttöä.
create or replace function public.current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from profiles where id = auth.uid();
$$;

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'super_admin' and active
  );
$$;

create or replace function public.is_partner_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'partner_admin' and active
  );
$$;

create or replace function public.is_read_only() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'read_only' and active
  );
$$;

alter table organizations enable row level security;
alter table profiles enable row level security;

create policy organizations_select on organizations for select
  using (is_super_admin() or id = current_org_id());
create policy organizations_write on organizations for all
  using (is_super_admin()) with check (is_super_admin());

create policy profiles_select on profiles for select
  using (is_super_admin() or id = auth.uid() or organization_id = current_org_id());
-- Käyttäjä saa muokata vain omaa nimeään; roolin/organisaation vaihto tehdään
-- aina service-role-funktiolla (crm-invite-user / super admin -toiminnot), ei clientistä.
create policy profiles_update_self on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from profiles p2 where p2.id = auth.uid())
              and organization_id = (select organization_id from profiles p2 where p2.id = auth.uid()));
create policy profiles_admin_write on profiles for update
  using (is_super_admin() or (is_partner_admin() and organization_id = current_org_id()));

-- ---------------------------------------------------------------
-- 2. HALLITTAVAT LOOKUP-TAULUT (ei kovakoodattuja statuksia/tuotteita)
-- ---------------------------------------------------------------

create table lead_statuses (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label_fi text not null,
  sort_order int not null,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  active boolean not null default true
);

create table deal_statuses (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label_fi text not null,
  sort_order int not null,
  active boolean not null default true
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  default_monthly_price numeric(12,2) default 0,
  default_setup_fee numeric(12,2) default 0,
  default_currency text not null default 'EUR',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table commission_rules (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references organizations (id), -- null = oletussääntö kaikille
  product_id uuid references products (id),      -- null = kaikki tuotteet
  rate numeric(5,2) not null check (rate >= 0 and rate <= 100),
  valid_from date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table lead_statuses enable row level security;
alter table deal_statuses enable row level security;
alter table products enable row level security;
alter table commission_rules enable row level security;

-- Lookup-taulut: kaikki kirjautuneet käyttäjät saavat lukea (tarvitaan Kanban-
-- sarakkeisiin, tuotevalintoihin jne.), vain super admin muokkaa.
create policy lookups_select on lead_statuses for select using (auth.role() = 'authenticated');
create policy lookups_write on lead_statuses for all using (is_super_admin()) with check (is_super_admin());
create policy deal_statuses_select on deal_statuses for select using (auth.role() = 'authenticated');
create policy deal_statuses_write on deal_statuses for all using (is_super_admin()) with check (is_super_admin());
create policy products_select on products for select using (auth.role() = 'authenticated');
create policy products_write on products for all using (is_super_admin()) with check (is_super_admin());

-- Komissiosäännöt: partneri näkee vain omat + globaalit (partner_id is null) rivit.
create policy commission_rules_select on commission_rules for select
  using (is_super_admin() or partner_id is null or partner_id = current_org_id());
create policy commission_rules_write on commission_rules for all
  using (is_super_admin()) with check (is_super_admin());

-- ---------------------------------------------------------------
-- 3. YRITYKSET JA KONTAKTIT
-- ---------------------------------------------------------------

create table companies (
  id uuid primary key default gen_random_uuid(),
  owning_partner_id uuid not null references organizations (id),
  responsible_partner_id uuid references organizations (id),
  responsible_user_id uuid references profiles (id),

  name text not null,
  business_id text,
  country text,
  city text,
  website text,
  industry text,
  employee_count int,

  contact_name text,
  contact_title text,
  contact_email text,
  contact_phone text,
  contact_linkedin_url text,
  company_linkedin_url text,

  lead_source text,
  status_id uuid references lead_statuses (id),
  estimated_value numeric(14,2),
  currency text default 'EUR',
  notes text,

  -- normalisoidut sarakkeet duplikaattitarkistukseen (ks. fn_check_company_duplicate)
  name_norm text generated always as (lower(regexp_replace(trim(name), '\s+', ' ', 'g'))) stored,
  business_id_norm text generated always as (nullif(regexp_replace(coalesce(business_id, ''), '[^0-9A-Za-z]', '', 'g'), '')) stored,
  website_norm text generated always as (
    nullif(lower(regexp_replace(regexp_replace(coalesce(website, ''), '^https?://(www\.)?', ''), '/+$', '')), '')
  ) stored,
  contact_email_norm text generated always as (nullif(lower(trim(contact_email)), '')) stored,
  contact_phone_norm text generated always as (nullif(regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g'), '')) stored,

  last_contacted_at timestamptz,
  last_contacted_by uuid references profiles (id),

  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_at timestamptz not null default now()
);

create index companies_owning_partner_idx on companies (owning_partner_id);
create index companies_name_norm_idx on companies (name_norm);
create index companies_business_id_norm_idx on companies (business_id_norm);
create index companies_website_norm_idx on companies (website_norm);
create index companies_email_norm_idx on companies (contact_email_norm);
create index companies_phone_norm_idx on companies (contact_phone_norm);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name text not null,
  title text,
  email text,
  phone text,
  linkedin_url text,
  is_primary boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id)
);
create index contacts_company_idx on contacts (company_id);

alter table companies enable row level security;
alter table contacts enable row level security;

-- Yritysten näkyvyys: super admin näkee kaiken. Partnerin sisällä partner_admin
-- ja read_only näkevät koko oman partnerin yrityskannan. partner_user näkee
-- oman partnerinsa yritykset PAITSI jos yritys on merkitty "vain vastuuhenkilölle"
-- (restricted_visibility) — silloin vain responsible_user_id tai admin näkee sen.
alter table companies add column restricted_visibility boolean not null default false;

create policy companies_select on companies for select
  using (
    is_super_admin()
    or (
      owning_partner_id = current_org_id()
      and (
        current_role() in ('partner_admin', 'read_only')
        or not restricted_visibility
        or responsible_user_id = auth.uid()
      )
    )
  );

create policy companies_insert on companies for insert
  with check (
    is_super_admin()
    or (owning_partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user'))
  );

create policy companies_update on companies for update
  using (
    is_super_admin()
    or (owning_partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user'))
  )
  with check (
    is_super_admin()
    or owning_partner_id = current_org_id() -- estää salakuljettamasta riviä toiselle partnerille update-kautta
  );
-- Ei delete-policya lainkaan: pysyvä poisto ei ole sallittu kenellekään.
-- Poisto tehdään aina asettamalla archived_at (ks. sovelluslogiikka).

create policy contacts_select on contacts for select
  using (
    is_super_admin() or exists (
      select 1 from companies c where c.id = contacts.company_id
      and (
        c.owning_partner_id = current_org_id()
        and (current_role() in ('partner_admin', 'read_only') or not c.restricted_visibility or c.responsible_user_id = auth.uid())
      )
    )
  );
create policy contacts_write on contacts for insert with check (
  is_super_admin() or exists (
    select 1 from companies c where c.id = contacts.company_id
    and c.owning_partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')
  )
);
create policy contacts_update on contacts for update using (
  is_super_admin() or exists (
    select 1 from companies c where c.id = contacts.company_id
    and c.owning_partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')
  )
);

-- ---------------------------------------------------------------
-- 4. AKTIVITEETIT (yhteydenottoaikajana)
-- ---------------------------------------------------------------

create table activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  contact_id uuid references contacts (id),
  partner_id uuid not null references organizations (id), -- denormalisoitu RLS-suorituskykyä varten
  performed_by uuid not null references profiles (id),

  occurred_at timestamptz not null default now(),
  channel text not null check (channel in ('email', 'call', 'linkedin', 'whatsapp', 'meeting', 'video', 'event', 'other')),
  purpose text,
  summary text,
  customer_need text,
  products_presented uuid[] default '{}',
  interest_level text check (interest_level in ('low', 'medium', 'high')),
  outcome text,
  next_steps text,
  next_followup_date date,
  followup_owner_id uuid references profiles (id),
  attachments jsonb default '[]',

  created_at timestamptz not null default now(),
  created_by uuid references profiles (id)
);
create index activities_company_idx on activities (company_id, occurred_at desc);
create index activities_partner_idx on activities (partner_id);
create index activities_followup_idx on activities (next_followup_date) where next_followup_date is not null;

alter table activities enable row level security;

create policy activities_select on activities for select
  using (is_super_admin() or partner_id = current_org_id());
create policy activities_insert on activities for insert
  with check (is_super_admin() or (partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')));
create policy activities_update on activities for update
  using (is_super_admin() or (partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')));

-- Kun aktiviteetti kirjataan, päivitä yrityksen last_contacted_at/-by automaattisesti.
create or replace function public.fn_touch_company_last_contact() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update companies
    set last_contacted_at = new.occurred_at,
        last_contacted_by = new.performed_by,
        updated_at = now()
    where id = new.company_id
      and (last_contacted_at is null or new.occurred_at >= last_contacted_at);
  return new;
end;
$$;
create trigger trg_activities_touch_company
  after insert on activities
  for each row execute function fn_touch_company_last_contact();

-- ---------------------------------------------------------------
-- 5. FOLLOW-UP-TEHTÄVÄT
-- ---------------------------------------------------------------

create table followup_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  partner_id uuid not null references organizations (id),
  owner_id uuid not null references profiles (id),
  due_date date not null,
  description text,
  status text not null default 'open' check (status in ('open', 'done')),
  related_activity_id uuid references activities (id),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  completed_at timestamptz
);
create index followup_tasks_owner_idx on followup_tasks (owner_id, status, due_date);
create index followup_tasks_partner_idx on followup_tasks (partner_id);

alter table followup_tasks enable row level security;

create policy followup_select on followup_tasks for select
  using (is_super_admin() or partner_id = current_org_id());
create policy followup_insert on followup_tasks for insert
  with check (is_super_admin() or (partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')));
create policy followup_update on followup_tasks for update
  using (is_super_admin() or (partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')));

-- Sääntö: "vaadi uuden follow-upin sopimista ennen kuin aktiivinen tehtävä
-- suljetaan, jos myyntiprosessi jatkuu" — toteutettu sovellustasolla (UI pakottaa
-- valitsemaan joko "jatka: uusi follow-up-pvm" tai "sulje: kauppa päättynyt/hävitty"),
-- ja varmistettu tässä kannassa: task ei voi siirtyä 'done'-tilaan companies-rivin
-- ollessa edelleen aktiivisessa myyntivaiheessa PAITSI jos samalla luodaan uusi
-- avoin followup_task samalle yritykselle. Tarkistetaan triggerillä.
create or replace function public.fn_enforce_followup_chain() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_is_closed boolean;
  v_has_open_followup boolean;
begin
  if new.status = 'done' and old.status = 'open' then
    select (ls.is_won or ls.is_lost) into v_is_closed
      from companies c join lead_statuses ls on ls.id = c.status_id
      where c.id = new.company_id;

    if not coalesce(v_is_closed, false) then
      select exists(
        select 1 from followup_tasks ft
        where ft.company_id = new.company_id and ft.status = 'open' and ft.id <> new.id
      ) into v_has_open_followup;

      if not v_has_open_followup then
        raise exception 'Sulkeminen estetty: sovi ensin seuraava follow-up ennen kuin tämä tehtävä voidaan merkitä valmiiksi, ellei kauppa ole päättynyt/hävitty.';
      end if;
    end if;

    new.completed_at = now();
  end if;
  return new;
end;
$$;
create trigger trg_followup_chain
  before update on followup_tasks
  for each row execute function fn_enforce_followup_chain();

-- ---------------------------------------------------------------
-- 6. TUOTTEET, TARJOUKSET, SOPIMUKSET, KOMISSIOT
-- ---------------------------------------------------------------

create table deals (
  id uuid primary key default gen_random_uuid(),
  deal_number text not null unique,
  company_id uuid not null references companies (id),
  partner_id uuid not null references organizations (id),
  responsible_user_id uuid references profiles (id),

  offer_date date,
  offer_valid_until date,
  contract_signed_date date,
  contract_start_date date,
  contract_end_date date,
  contract_length_months int, -- laskettu triggerillä start/end:stä

  billing_interval text check (billing_interval in ('monthly', 'quarterly', 'yearly')) default 'monthly',
  payment_terms text,
  auto_renew boolean not null default false,
  notice_period_days int,
  trial_period_days int,

  status_id uuid references deal_statuses (id),
  discount_percent numeric(5,2) default 0,

  -- Lasketut kentät: EI KOSKAAN kirjoitettu suoraan clientistä, vain trigger
  -- fn_recalc_deal_totals() saa päivittää nämä. RLS-policy tässä alempana
  -- estää clientiä kirjoittamasta niihin muilla kuin service-rolella.
  total_value numeric(14,2) default 0,
  mrr numeric(14,2) default 0,
  arr numeric(14,2) default 0,
  commission_rate numeric(5,2) default 0,
  commission_amount numeric(14,2) default 0,
  commission_status text not null default 'open' check (commission_status in ('open', 'approved', 'paid')),

  currency text default 'EUR',
  contract_document_ref text,
  attachments jsonb default '[]',
  notes text,

  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_at timestamptz not null default now()
);
create index deals_company_idx on deals (company_id);
create index deals_partner_idx on deals (partner_id);
create index deals_end_date_idx on deals (contract_end_date) where contract_end_date is not null;

create table deal_line_items (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals (id) on delete cascade,
  product_id uuid not null references products (id),
  quantity int not null default 1,
  user_count int,
  monthly_price numeric(12,2) not null default 0,
  setup_fee numeric(12,2) not null default 0,
  one_time_fees numeric(12,2) not null default 0,
  discount_percent numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);
create index deal_line_items_deal_idx on deal_line_items (deal_id);

alter table deals enable row level security;
alter table deal_line_items enable row level security;

create policy deals_select on deals for select
  using (is_super_admin() or partner_id = current_org_id());
create policy deals_insert on deals for insert
  with check (is_super_admin() or (partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')));
create policy deals_update on deals for update
  using (is_super_admin() or (partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')));

create policy deal_line_items_select on deal_line_items for select
  using (is_super_admin() or exists (select 1 from deals d where d.id = deal_line_items.deal_id and d.partner_id = current_org_id()));
create policy deal_line_items_write on deal_line_items for all
  using (is_super_admin() or exists (
    select 1 from deals d where d.id = deal_line_items.deal_id
    and d.partner_id = current_org_id() and current_role() in ('partner_admin', 'partner_user')
  ));

-- Laskenta: kesto kuukausina, MRR, ARR, kokonaisarvo ja partnerikomissio.
-- Peilaa tarkalleen crm/lib/calc.js:n testattua kaavaa (ks. tests/calc.test.js) —
-- jos jompaakumpaa muutetaan, päivitä molemmat ja aja testit.
--   mrr            = sum(monthly_price * quantity * (1 - line_discount/100)) * (1 - deal_discount/100)
--   arr            = mrr * 12
--   contract_length_months = round(months between contract_start_date and contract_end_date)
--   total_value    = mrr * contract_length_months + sum(setup_fee*qty) + sum(one_time_fees*qty)
--   commission_amount = total_value * commission_rate / 100
create or replace function public.fn_recalc_deal_totals(p_deal_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_mrr numeric(14,2);
  v_setup numeric(14,2);
  v_onetime numeric(14,2);
  v_deal deals%rowtype;
  v_length int;
  v_total numeric(14,2);
  v_commission numeric(14,2);
begin
  select * into v_deal from deals where id = p_deal_id;
  if not found then return; end if;

  select
    coalesce(sum(monthly_price * quantity * (1 - discount_percent / 100.0)), 0),
    coalesce(sum(setup_fee * quantity), 0),
    coalesce(sum(one_time_fees * quantity), 0)
  into v_mrr, v_setup, v_onetime
  from deal_line_items where deal_id = p_deal_id;

  v_mrr := round(v_mrr * (1 - coalesce(v_deal.discount_percent, 0) / 100.0), 2);

  if v_deal.contract_start_date is not null and v_deal.contract_end_date is not null then
    v_length := greatest(0, (extract(year from age(v_deal.contract_end_date, v_deal.contract_start_date)) * 12
                + extract(month from age(v_deal.contract_end_date, v_deal.contract_start_date)))::int);
  else
    v_length := null;
  end if;

  v_total := round(v_mrr * coalesce(v_length, 0) + v_setup + v_onetime, 2);
  v_commission := round(v_total * coalesce(v_deal.commission_rate, 0) / 100.0, 2);

  update deals set
    mrr = v_mrr,
    arr = round(v_mrr * 12, 2),
    contract_length_months = v_length,
    total_value = v_total,
    commission_amount = v_commission,
    updated_at = now()
  where id = p_deal_id;
end;
$$;

create or replace function public.fn_deal_line_items_recalc_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform fn_recalc_deal_totals(coalesce(new.deal_id, old.deal_id));
  return coalesce(new, old);
end;
$$;
create trigger trg_deal_line_items_recalc
  after insert or update or delete on deal_line_items
  for each row execute function fn_deal_line_items_recalc_trigger();

create or replace function public.fn_deal_header_recalc_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.contract_start_date is distinct from old.contract_start_date
     or new.contract_end_date is distinct from old.contract_end_date
     or new.commission_rate is distinct from old.commission_rate
     or new.discount_percent is distinct from old.discount_percent then
    perform fn_recalc_deal_totals(new.id);
  end if;
  return new;
end;
$$;
create trigger trg_deal_header_recalc
  after update on deals
  for each row execute function fn_deal_header_recalc_trigger();

-- Kun sopimus luodaan, hae oletuskomissioprosentti commission_rules-taulusta
-- (partnerikohtainen sääntö ohittaa yleisen), ellei sitä ole jo asetettu.
create or replace function public.fn_deal_default_commission() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.commission_rate is null or new.commission_rate = 0 then
    select rate into new.commission_rate
      from commission_rules
      where active and valid_from <= current_date
        and (partner_id = new.partner_id or partner_id is null)
      order by partner_id nulls last, valid_from desc
      limit 1;
  end if;
  return new;
end;
$$;
create trigger trg_deal_default_commission
  before insert on deals
  for each row execute function fn_deal_default_commission();

-- ---------------------------------------------------------------
-- 7. DUPLIKAATTITARKISTUS (SECURITY DEFINER — ohittaa RLS:n hallitusti)
-- ---------------------------------------------------------------

-- Palauttaa AINA vain sen verran tietoa kuin kutsujan rooli saa nähdä:
-- ei-super-admin saa vain {duplicate: true/false, message}. Super admin saa
-- lisäksi omistavan partnerin nimen sekä lisäys-/viimeisin yhteydenottopäivän.
create or replace function public.fn_check_company_duplicate(
  p_name text, p_business_id text, p_website text, p_email text, p_phone text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_match companies%rowtype;
  v_name_norm text := lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_bid_norm text := nullif(regexp_replace(coalesce(p_business_id, ''), '[^0-9A-Za-z]', '', 'g'), '');
  v_site_norm text := nullif(lower(regexp_replace(regexp_replace(coalesce(p_website, ''), '^https?://(www\.)?', ''), '/+$', '')), '');
  v_email_norm text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone_norm text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_owner_name text;
begin
  select * into v_match from companies
    where archived_at is null and (
      (v_name_norm <> '' and name_norm = v_name_norm)
      or (v_bid_norm is not null and business_id_norm = v_bid_norm)
      or (v_site_norm is not null and website_norm = v_site_norm)
      or (v_email_norm is not null and contact_email_norm = v_email_norm)
      or (v_phone_norm is not null and contact_phone_norm = v_phone_norm)
    )
    limit 1;

  if not found then
    return jsonb_build_object('duplicate', false);
  end if;

  if is_super_admin() then
    select name into v_owner_name from organizations where id = v_match.owning_partner_id;
    return jsonb_build_object(
      'duplicate', true,
      'message', 'Yritys on jo rekisteröity järjestelmässä.',
      'owner_partner_name', v_owner_name,
      'owner_partner_id', v_match.owning_partner_id,
      'company_id', v_match.id,
      'added_at', v_match.created_at,
      'last_contacted_at', v_match.last_contacted_at
    );
  end if;

  -- Jos duplikaatti on kutsujan OMAN partnerin data, saa nähdä sen normaalisti
  -- (RLS päästää sen läpi joka tapauksessa companies-taulusta) — mutta emme
  -- koskaan paljasta toisen partnerin omistajuutta.
  if v_match.owning_partner_id = current_org_id() then
    return jsonb_build_object(
      'duplicate', true,
      'message', 'Yritys on jo omassa yrityslistassasi.',
      'company_id', v_match.id,
      'own_company', true
    );
  end if;

  return jsonb_build_object(
    'duplicate', true,
    'message', 'Yritys on jo rekisteröity AerWorkin partneriverkostossa. Ota yhteyttä AerWorkin ylläpitoon asiakkuuden omistajuuden tarkistamiseksi.'
  );
end;
$$;

-- ---------------------------------------------------------------
-- 8. OMISTAJUUDEN SIIRTO (Super Admin)
-- ---------------------------------------------------------------

create table ownership_transfer_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  from_partner_id uuid references organizations (id),
  to_partner_id uuid not null references organizations (id),
  moved_by uuid not null references profiles (id),
  moved_at timestamptz not null default now(),
  reason text
);
alter table ownership_transfer_log enable row level security;
create policy ownership_transfer_log_select on ownership_transfer_log for select using (is_super_admin());
create policy ownership_transfer_log_insert on ownership_transfer_log for insert with check (is_super_admin());

-- ---------------------------------------------------------------
-- 9. AUDIT LOG (muuttumaton — ei update/delete-policya kellekään)
-- ---------------------------------------------------------------

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid not null,
  action text not null check (action in ('create', 'update', 'archive', 'restore')),
  field_name text,
  old_value text,
  new_value text,
  changed_by uuid references profiles (id),
  changed_at timestamptz not null default now(),
  partner_id uuid references organizations (id)
);
create index audit_log_record_idx on audit_log (table_name, record_id, changed_at desc);
create index audit_log_partner_idx on audit_log (partner_id);

alter table audit_log enable row level security;
create policy audit_log_select on audit_log for select
  using (is_super_admin() or partner_id = current_org_id());
-- Tarkoituksella EI insert-policya suoraan clientille — audit-rivit syntyvät
-- ainoastaan alla olevan trigger-funktion kautta (SECURITY DEFINER), joten
-- kukaan ei voi kirjoittaa tai väärentää audit-lokia suoralla API-kutsulla.

create or replace function public.fn_generic_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_partner_id uuid;
  v_key text;
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_partner_id := coalesce(v_new->>'owning_partner_id', v_new->>'partner_id');
    insert into audit_log (table_name, record_id, action, changed_by, partner_id)
      values (tg_table_name, new.id, 'create', auth.uid(), v_partner_id::uuid);
    return new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_partner_id := coalesce(v_new->>'owning_partner_id', v_new->>'partner_id');
    v_action := case when (new.archived_at is not null and old.archived_at is null) then 'archive'
                     when (new.archived_at is null and old.archived_at is not null) then 'restore'
                     else 'update' end;
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key not in ('updated_at') and v_old->v_key is distinct from v_new->v_key then
        insert into audit_log (table_name, record_id, action, field_name, old_value, new_value, changed_by, partner_id)
          values (tg_table_name, new.id, v_action, v_key, v_old->>v_key, v_new->>v_key, auth.uid(), v_partner_id::uuid);
      end if;
    end loop;
    return new;
  end if;
  return null;
end;
$$;

create trigger trg_audit_companies after insert or update on companies for each row execute function fn_generic_audit();
create trigger trg_audit_contacts after insert or update on contacts for each row execute function fn_generic_audit();
create trigger trg_audit_activities after insert or update on activities for each row execute function fn_generic_audit();
create trigger trg_audit_deals after insert or update on deals for each row execute function fn_generic_audit();
create trigger trg_audit_followup_tasks after insert or update on followup_tasks for each row execute function fn_generic_audit();

-- ---------------------------------------------------------------
-- 10. SIEMENDATA — hallittavat lookup-taulut esitäytettynä pyydetyillä arvoilla
-- ---------------------------------------------------------------

insert into lead_statuses (key, label_fi, sort_order, is_won, is_lost) values
  ('new_lead', 'Uusi liidi', 10, false, false),
  ('not_contacted', 'Ei vielä kontaktoitu', 20, false, false),
  ('first_contact', 'Ensimmäinen yhteydenotto tehty', 30, false, false),
  ('customer_replied', 'Asiakas vastannut', 40, false, false),
  ('meeting_scheduled', 'Tapaaminen sovittu', 50, false, false),
  ('meeting_held', 'Tapaaminen pidetty', 60, false, false),
  ('needs_mapped', 'Tarve kartoitettu', 70, false, false),
  ('demo_held', 'Demo pidetty', 80, false, false),
  ('offer_sent', 'Tarjous lähetetty', 90, false, false),
  ('negotiation', 'Neuvottelu käynnissä', 100, false, false),
  ('contract_sent', 'Sopimus lähetetty', 110, false, false),
  ('contract_signed', 'Sopimus allekirjoitettu', 120, true, false),
  ('onboarding', 'Käyttöönotto', 130, true, false),
  ('active_customer', 'Aktiivinen asiakas', 140, true, false),
  ('renewal_upcoming', 'Uusiminen tulossa', 150, true, false),
  ('contract_ended', 'Sopimus päättynyt', 160, false, false),
  ('not_interested', 'Ei kiinnostunut', 170, false, true),
  ('lost_deal', 'Hävitty kauppa', 180, false, true),
  ('followup_later', 'Follow-up myöhemmin', 190, false, false);

insert into deal_statuses (key, label_fi, sort_order) values
  ('draft', 'Luonnos', 10),
  ('sent', 'Lähetetty', 20),
  ('accepted', 'Hyväksytty', 30),
  ('signed', 'Allekirjoitettu', 40),
  ('active', 'Aktiivinen', 50),
  ('ending', 'Päättymässä', 60),
  ('renewed', 'Uusittu', 70),
  ('cancelled', 'Peruttu', 80),
  ('ended', 'Päättynyt', 90);

-- AerWork-organisaatio (super adminit sidotaan tähän). Vaihda nimi tarvittaessa.
insert into organizations (id, name, type, country) values
  ('00000000-0000-0000-0000-000000000001', 'AerWork', 'aerwork', 'FI');
