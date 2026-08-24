-- Myyntiputken uudistus (myyntitiimin + IT-tiimin yhteinen määrittely,
-- ks. "Myyntiputken määrittely" -dokumentti, hyväksytty 2026-08-24).
--
-- ISOIN MUUTOS: kauppa (opportunity) irrotetaan yrityksestä (company) omaksi
-- tietueeksi. Aiemmin Kanban luki/kirjoitti suoraan companies.status_id +
-- companies.estimated_value, mikä tarkoitti että yhdellä yrityksellä saattoi
-- olla vain yksi aktiivinen myyntimahdollisuus kerrallaan. Nyt yritys voi
-- omistaa useita rinnakkaisia opportunities-rivejä.
--
-- companies.status_id / companies.estimated_value JÄTETÄÄN ENNALLEEN taakse-
-- päin yhteensopivuuden vuoksi (mm. Owner Company Search kirjoittaa niihin
-- yritystä lisätessä) mutta Kanban ei enää lue niitä.

-- ---------------------------------------------------------------
-- 1. PUTKEN VAIHEET (korvaa Kanbanissa aiemmin käytetyn lead_statuses:in)
-- ---------------------------------------------------------------

create table pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label_fi text not null,
  sort_order int not null,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  default_probability int not null default 0 check (default_probability between 0 and 100),
  -- Suositeltu enimmäiskesto vaiheessa ennen "pysähtynyt"-varoitusta.
  -- null = ei aikarajaa (Voitettu/Hävitty ovat päätetiloja).
  max_duration_days int,
  active boolean not null default true
);

insert into pipeline_stages (key, label_fi, sort_order, is_won, is_lost, default_probability, max_duration_days) values
  ('new_lead',        'Uusi liidi',           10, false, false, 10, 2),
  ('contacting',      'Kontaktointi',         20, false, false, 20, 5),
  ('needs_identified','Tarve tunnistettu',    30, false, false, 35, 7),
  ('meeting_demo',    'Tapaaminen / demo',    40, false, false, 50, 10),
  ('offer',           'Tarjous',              50, false, false, 65, 3),
  ('negotiation',     'Neuvottelu',           60, false, false, 75, 7),
  ('contract',        'Sopimus',              70, false, false, 90, 5),
  ('won',             'Voitettu',             80, true,  false, 100, null),
  ('lost',            'Hävitty',              90, false, true,  0,  null);

alter table pipeline_stages enable row level security;
create policy pipeline_stages_select on pipeline_stages for select using (auth.role() = 'authenticated');
create policy pipeline_stages_write on pipeline_stages for all using (is_super_admin()) with check (is_super_admin());

-- ---------------------------------------------------------------
-- 2. MAHDOLLISUUDET (OPPORTUNITIES) — itsenäinen tietue, ei sama kuin yritys
-- ---------------------------------------------------------------

create table opportunities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  partner_id uuid not null references organizations (id),
  responsible_user_id uuid references profiles (id),
  product_id uuid references products (id),
  stage_id uuid not null references pipeline_stages (id),

  title text, -- vapaaehtoinen lyhyt kuvaus, hyödyllinen kun yrityksellä >1 mahdollisuus
  probability int not null default 0 check (probability between 0 and 100),
  -- Merkitään kun myyjä on käsin ohittanut vaiheen oletustodennäköisyyden —
  -- itse muutos näkyy joka tapauksessa audit_logissa (fn_generic_audit),
  -- tämä lippu helpottaa vain raportointia ("kuinka moni on käsin säädetty").
  probability_overridden boolean not null default false,
  estimated_value numeric(14,2),
  currency text not null default 'EUR',
  expected_close_date date,
  lead_source text,

  stage_entered_at timestamptz not null default now(),

  lost_reason text,
  lost_competitor text,
  lost_can_revisit boolean,
  lost_revisit_date date,

  -- Kun mahdollisuus voitetaan, syntyy oikea deals-rivi (olemassa oleva
  -- sopimus-/laskutuslogiikka) — tämä linkittää ne yhteen.
  won_deal_id uuid references deals (id),

  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_at timestamptz not null default now()
);

create index opportunities_company_idx on opportunities (company_id);
create index opportunities_partner_idx on opportunities (partner_id);
create index opportunities_stage_idx on opportunities (stage_id);
create index opportunities_responsible_idx on opportunities (responsible_user_id);
create index opportunities_active_idx on opportunities (partner_id) where archived_at is null;

alter table opportunities enable row level security;

create policy opportunities_select on opportunities for select
  using (is_super_admin() or partner_id = current_org_id());
create policy opportunities_insert on opportunities for insert
  with check (is_super_admin() or (partner_id = current_org_id() and app_current_role() in ('partner_admin', 'partner_user')));
create policy opportunities_update on opportunities for update
  using (is_super_admin() or (partner_id = current_org_id() and app_current_role() in ('partner_admin', 'partner_user')));

-- stage_entered_at nollautuu automaattisesti kun vaihe vaihtuu — käytetään
-- "pysähtynyt kauppa" -laskennassa (max_duration_days). Sama trigger asettaa
-- probability-oletuksen vaiheen mukaan JOS myyjä ei ole itse muuttanut sitä
-- tämän siirron yhteydessä (probability_overridden vertaa uutta vanhaan).
create or replace function public.fn_opportunity_stage_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    new.stage_entered_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger trg_opportunity_stage_touch
  before insert or update on opportunities
  for each row execute function fn_opportunity_stage_touch();

create trigger trg_audit_opportunities after insert or update on opportunities
  for each row execute function fn_generic_audit();

-- ---------------------------------------------------------------
-- 3. FOLLOW-UPIT LINKITETÄÄN MAHDOLLISUUTEEN (nullable, ei riko vanhaa dataa)
-- ---------------------------------------------------------------

alter table followup_tasks add column opportunity_id uuid references opportunities (id) on delete set null;
create index followup_tasks_opportunity_idx on followup_tasks (opportunity_id) where opportunity_id is not null;

-- ---------------------------------------------------------------
-- 4. deal_number generoidaan automaattisesti (ei ollut aiemmin generaattoria —
--    deals-taulua ei käytetty UI:sta lainkaan ennen tätä, vain dashboard-
--    yhteenvedoissa). Muoto: DEAL-VUOSI-00001.
-- ---------------------------------------------------------------

create sequence deal_number_seq;

create or replace function public.fn_generate_deal_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deal_number is null or new.deal_number = '' then
    new.deal_number := 'DEAL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('deal_number_seq')::text, 5, '0');
  end if;
  return new;
end;
$$;
create trigger trg_generate_deal_number
  before insert on deals
  for each row execute function fn_generate_deal_number();
