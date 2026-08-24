-- Partnerikomissioiden laskentamoottori AerWorkin Kumppanuus- ja Revenue
-- Share -sopimuksen (Suomi) mukaan. Ks. hyväksytty "Partnerikomissioiden
-- Määrittely" -dokumentti. Kevyt laajennus olemassa oleviin tauluihin, sama
-- periaate kuin 0009/0010:ssä (ei suurta uudelleenrakennusta).
--
-- YDINSÄÄNTÖ (spec 3.1): provisiokausi on ASIAKASKOHTAINEN (companies-rivi =
-- Partner Customer), ei sopimuskohtainen (deals-rivi). Siksi kauden
-- alku/loppu ja lukitut prosentit tallennetaan companies-riville, EI
-- deals-riville - yhdellä yrityksellä voi olla useita deals-rivejä
-- (lisämyynti) jotka kaikki jakavat saman kauden.

-- ---------------------------------------------------------------
-- 1. KUMPPANITASOT (organizations + oma oletustaulukko)
-- ---------------------------------------------------------------

alter table organizations add column partner_level text
  check (partner_level in ('introduction', 'sales', 'certified', 'strategic'));
alter table organizations add column partner_level_set_at timestamptz;

-- Strategic-tason tarkat prosentit/kesto eivät synny automaattisesti
-- (sopimus: "25 %:n revenue share ei synny automaattisesti") - Owner asettaa
-- ne tapauskohtaisesti fn_set_partner_level:in kautta. Kattoarvot (25 % / 24 kk
-- / 15 % AI) ovat kiinteitä sopimusarvoja Liite A:sta, siksi kovakoodattu
-- check-rajoitteeksi.
alter table organizations add column partner_custom_subscription_rate numeric(5,2)
  check (partner_custom_subscription_rate is null or (partner_custom_subscription_rate >= 0 and partner_custom_subscription_rate <= 25));
alter table organizations add column partner_custom_ai_credit_rate numeric(5,2)
  check (partner_custom_ai_credit_rate is null or (partner_custom_ai_credit_rate >= 0 and partner_custom_ai_credit_rate <= 15));
alter table organizations add column partner_custom_period_months int
  check (partner_custom_period_months is null or (partner_custom_period_months >= 1 and partner_custom_period_months <= 24));

-- Kolmen ensimmäisen tason (Liite A) kiinteät oletusarvot. Strategic-riviä ei
-- käytetä koskaan suoraan (ks. fn_lock_company_commission_period alla) -
-- sille EI ole rivikohtaista oletusta, koska sopimus ei anna sille kiinteää
-- prosenttia/kestoa.
create table partner_tier_defaults (
  tier text primary key check (tier in ('introduction', 'sales', 'certified', 'strategic')),
  subscription_rate numeric(5,2),
  ai_credit_rate numeric(5,2),
  period_months int,
  label_fi text not null
);
insert into partner_tier_defaults (tier, subscription_rate, ai_credit_rate, period_months, label_fi) values
  ('introduction', 10, 5, 12, 'Introduction Partner'),
  ('sales', 15, 7.5, 18, 'Sales Partner'),
  ('certified', 20, 10, 24, 'Certified AerWork Partner'),
  ('strategic', null, null, null, 'Strategic Partner');

alter table partner_tier_defaults enable row level security;
create policy partner_tier_defaults_select on partner_tier_defaults for select
  using (auth.role() = 'authenticated');
create policy partner_tier_defaults_write on partner_tier_defaults for all
  using (is_super_admin()) with check (is_super_admin());

-- Erillinen, muuttumaton audit-loki tasonmuutoksille - sama periaate kuin
-- lead_claim_audit_log:ssa. Ei client-kirjoitusta, vain fn_set_partner_level.
create table partner_level_history (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references organizations (id),
  previous_level text,
  new_level text not null,
  previous_custom_subscription_rate numeric(5,2),
  new_custom_subscription_rate numeric(5,2),
  reason text not null,
  performed_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
create index partner_level_history_partner_idx on partner_level_history (partner_id);

alter table partner_level_history enable row level security;
create policy partner_level_history_select on partner_level_history for select
  using (is_super_admin() or partner_id = current_org_id());

-- Owner-only, pakollinen syy (spec: kaikki admin-toiminnot vaativat syyn +
-- audit-lokin). Tarkistaa is_super_admin() sisäisesti auth.uid():sta - ei
-- luota kutsujan väitteeseen (SECURITY DEFINER ohittaa RLS:n).
create or replace function public.fn_set_partner_level(
  p_partner_id uuid,
  p_new_level text,
  p_reason text,
  p_custom_subscription_rate numeric default null,
  p_custom_ai_credit_rate numeric default null,
  p_custom_period_months int default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old_level text;
  v_old_custom numeric;
begin
  if not is_super_admin() then
    raise exception 'Vain Owner voi muuttaa kumppanitasoa';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Tason muutokselle on annettava syy';
  end if;
  if p_new_level not in ('introduction', 'sales', 'certified', 'strategic') then
    raise exception 'Tuntematon kumppanitaso: %', p_new_level;
  end if;
  if p_new_level = 'strategic' and (
    p_custom_subscription_rate is null or p_custom_ai_credit_rate is null or p_custom_period_months is null
  ) then
    raise exception 'Strategic Partner -tasolle on asetettava tarkat prosentit ja kesto - ne eivät synny automaattisesti';
  end if;

  select partner_level, partner_custom_subscription_rate into v_old_level, v_old_custom
    from organizations where id = p_partner_id;

  update organizations set
    partner_level = p_new_level,
    partner_level_set_at = now(),
    -- Muille kuin strategic-tasolle nollataan aina räätälöidyt arvot, jotta
    -- vanha custom-% ei jää "haamuksi" vaikuttamaan myöhemmin.
    partner_custom_subscription_rate = case when p_new_level = 'strategic' then p_custom_subscription_rate else null end,
    partner_custom_ai_credit_rate = case when p_new_level = 'strategic' then p_custom_ai_credit_rate else null end,
    partner_custom_period_months = case when p_new_level = 'strategic' then p_custom_period_months else null end
  where id = p_partner_id;

  insert into partner_level_history (
    partner_id, previous_level, new_level, previous_custom_subscription_rate, new_custom_subscription_rate, reason, performed_by
  ) values (
    p_partner_id, v_old_level, p_new_level, v_old_custom, p_custom_subscription_rate, p_reason, auth.uid()
  );
end;
$$;

-- ---------------------------------------------------------------
-- 2. ASIAKASKOHTAINEN PROVISIOKAUSI (companies-riville, ks. yllä oleva
--    perustelu). Lukitaan KERRAN ensimmäisen contract_start_date:n
--    asettamisella - EI koskaan muuteta jälkikäteen (spec 3.5: tason
--    muutos ei ole retroaktiivinen jo lukituille kausille).
-- ---------------------------------------------------------------

alter table companies add column commission_period_started_at date;
alter table companies add column commission_period_ends_at date;
alter table companies add column commission_rate_locked numeric(5,2);
alter table companies add column ai_credit_rate_locked numeric(5,2);
alter table companies add column partner_level_locked text;

create index companies_commission_ends_idx on companies (commission_period_ends_at)
  where commission_period_started_at is not null;

create or replace function public.fn_lock_company_commission_period() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_company companies%rowtype;
  v_org organizations%rowtype;
  v_level text;
  v_sub_rate numeric(5,2);
  v_ai_rate numeric(5,2);
  v_period_months int;
begin
  if new.contract_start_date is null then
    return new;
  end if;
  -- Jo asetettu aiemmin (esim. muu kentän päivitys) - ei koskea uudelleen.
  if tg_op = 'UPDATE' and old.contract_start_date is not null then
    return new;
  end if;

  select * into v_company from companies where id = new.company_id;
  if not found or v_company.commission_period_started_at is not null then
    return new; -- kausi jo lukittu tälle yritykselle (toinen deal, lisämyynti) - ei kosketa
  end if;

  select * into v_org from organizations where id = new.partner_id;
  v_level := coalesce(v_org.partner_level, 'introduction');

  if v_level = 'strategic' then
    if v_org.partner_custom_subscription_rate is null then
      raise exception 'Partnerin % Strategic-komissio ei ole asetettu (Owner ei ole vielä määrittänyt tarkkaa prosenttia) - provisiokautta ei voi lukita', new.partner_id;
    end if;
    v_sub_rate := v_org.partner_custom_subscription_rate;
    v_ai_rate := v_org.partner_custom_ai_credit_rate;
    v_period_months := v_org.partner_custom_period_months;
  else
    select subscription_rate, ai_credit_rate, period_months into v_sub_rate, v_ai_rate, v_period_months
      from partner_tier_defaults where tier = v_level;
  end if;

  update companies set
    commission_period_started_at = new.contract_start_date,
    commission_period_ends_at = (new.contract_start_date + (v_period_months || ' months')::interval)::date,
    commission_rate_locked = v_sub_rate,
    ai_credit_rate_locked = v_ai_rate,
    partner_level_locked = v_level
  where id = new.company_id;

  return new;
end;
$$;

create trigger trg_lock_company_commission_period
  after insert or update on deals
  for each row execute function fn_lock_company_commission_period();

-- ---------------------------------------------------------------
-- 3. TUOTERIVIN KATEGORIA (spec 3.3/3.4: mikä tuottaa provisiota ja millä
--    prosentilla). "Kehitys" on jo olemassa oleva 0 %:n tuote (Liite C:n
--    development/custom-kehitys) - AI Credit -tuotetta ei ole vielä olemassa,
--    kategoria on valmiina kun sellainen lisätään.
-- ---------------------------------------------------------------

alter table deal_line_items add column revenue_category text not null default 'subscription'
  check (revenue_category in ('subscription', 'ai_credit', 'zero_share'));

-- TÄRKEÄ: kategoria EI luota clientin lähettämään arvoon - se johdetaan aina
-- palvelinpuolella tuotenimestä, samalla periaatteella kuin muutkin lasketut
-- kentät tässä skeemassa (esim. deals.commission_amount) eivät koskaan tule
-- suoraan clientiltä. Ilman tätä varmistusta client voisi (vahingossa tai
-- tahallaan) jättää revenue_category-kentän oletusarvoon 'subscription' myös
-- Kehitys-riveille, jotka eivät saa KOSKAAN tuottaa provisiota (Liite C).
create or replace function public.fn_deal_line_item_derive_category() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_product_name text;
begin
  select name into v_product_name from products where id = new.product_id;
  new.revenue_category := case
    when v_product_name = 'Kehitys' then 'zero_share'
    when v_product_name ilike '%ai credit%' or v_product_name ilike '%ai-credit%' then 'ai_credit'
    else 'subscription'
  end;
  return new;
end;
$$;
create trigger trg_deal_line_item_derive_category
  before insert or update of product_id on deal_line_items
  for each row execute function fn_deal_line_item_derive_category();

-- Taannehtiva korjaus: olemassa olevat Kehitys-tuoterivit eivät saa koskaan
-- olla tuottaneet eivätkä tuota jatkossa provisiota.
update deal_line_items set revenue_category = 'zero_share'
  where product_id in (select id from products where name = 'Kehitys');

-- ---------------------------------------------------------------
-- 4. KUUKAUSITTAINEN PROVISIOLASKELMA (commission_ledger) - laskettu, ei
--    käsin kirjoitettava. Ainoa kirjoitustapa on fn_generate_commission_ledger
--    (SECURITY DEFINER), ajetaan päivittäin Netlify Scheduled Functionilla
--    (idempotentti unique-rajoitteen ansiosta - turvallinen ajaa uudelleen).
-- ---------------------------------------------------------------

create table commission_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  partner_id uuid not null references organizations (id),
  deal_id uuid not null references deals (id),
  deal_line_item_id uuid not null references deal_line_items (id),
  period_month date not null, -- kuukauden 1. päivä
  revenue_category text not null check (revenue_category in ('subscription', 'ai_credit')),
  base_amount numeric(14,2) not null,
  rate_applied numeric(5,2) not null,
  commission_amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  unique (deal_line_item_id, period_month)
);
create index commission_ledger_partner_idx on commission_ledger (partner_id);
create index commission_ledger_company_idx on commission_ledger (company_id);
create index commission_ledger_month_idx on commission_ledger (period_month);

alter table commission_ledger enable row level security;
create policy commission_ledger_select on commission_ledger for select
  using (is_super_admin() or partner_id = current_org_id());
-- Ei insert/update/delete-policya kenellekään - vain SECURITY DEFINER-funktio kirjoittaa.

create or replace function public.fn_generate_commission_ledger() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_inserted int;
begin
  insert into commission_ledger (
    company_id, partner_id, deal_id, deal_line_item_id, period_month, revenue_category,
    base_amount, rate_applied, commission_amount
  )
  select
    c.id, d.partner_id, d.id, li.id, gm.period_month, li.revenue_category,
    round(v.line_mrr, 2),
    v.rate,
    round(v.line_mrr * v.rate / 100.0, 2)
  from companies c
  join deals d on d.company_id = c.id and d.archived_at is null
  join deal_line_items li on li.deal_id = d.id and li.revenue_category in ('subscription', 'ai_credit')
  cross join lateral (
    select
      li.monthly_price * li.quantity * (1 - li.discount_percent / 100.0) * (1 - coalesce(d.discount_percent, 0) / 100.0) as line_mrr,
      case when li.revenue_category = 'ai_credit' then c.ai_credit_rate_locked else c.commission_rate_locked end as rate
  ) v
  cross join lateral (
    select generate_series(
      date_trunc('month', c.commission_period_started_at)::date,
      least(date_trunc('month', current_date)::date, date_trunc('month', c.commission_period_ends_at)::date),
      interval '1 month'
    )::date as period_month
  ) gm
  where c.archived_at is null
    and c.commission_period_started_at is not null
    and c.commission_period_ends_at is not null
  on conflict (deal_line_item_id, period_month) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
