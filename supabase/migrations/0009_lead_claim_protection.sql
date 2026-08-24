-- 90 päivän liidisuoja ja päällekkäisyyksien esto (ks. hyväksytty "90 päivän
-- liidisuoja" -dokumentti). KEVYEMPI arkkitehtuuri kuin alkuperäisen speksin
-- kirjaimellinen master-yritys/partner-claim-taulujako - companies-taulu
-- pysyy ennallaan (yksi rivi = yhden partnerin oma näkymä, kuten nytkin),
-- lisätään vain suojaustila samalle riville + oma audit-taulu. Tämä täyttää
-- KAIKKI vaaditut erottelut (partnerikohtainen data ei koskaan sekoitu)
-- koskematta yhteenkään olemassa olevaan tauluun/RLS-sääntöön joka jo
-- viittaa companies.id:hen (opportunities, activities, followup_tasks,
-- contacts, deals, jne).

-- ---------------------------------------------------------------
-- 1. SUOJAUSTILAN SARAKKEET
-- ---------------------------------------------------------------

alter table companies add column protection_started_at timestamptz;
alter table companies add column protection_expires_at timestamptz;
alter table companies add column claim_status text not null default 'active'
  check (claim_status in ('active', 'expired', 'released', 'converted_to_customer', 'under_review'));
alter table companies add column converted_to_customer_at timestamptz;
alter table companies add column converted_to_customer_by uuid references profiles (id);
alter table companies add column released_at timestamptz;
alter table companies add column released_by uuid references profiles (id);
alter table companies add column release_reason text;

create index companies_claim_status_idx on companies (claim_status);
create index companies_protection_expires_idx on companies (protection_expires_at) where claim_status = 'active';

-- Uusi yritys saa AINA 90 vrk suojan tallennushetkestä (tarkka UTC-aikaleima,
-- ei kalenterikuukausia). Suoja EI koskaan pitene automaattisesti - vain
-- fn_convert_lead_to_customer/fn_release_lead_claim (alla) saavat muuttaa
-- claim_status/protection_expires_at INSERTin jälkeen.
create or replace function public.fn_set_lead_protection() returns trigger
language plpgsql as $$
begin
  if new.protection_started_at is null then
    new.protection_started_at := now();
  end if;
  if new.protection_expires_at is null then
    new.protection_expires_at := new.protection_started_at + interval '90 days';
  end if;
  return new;
end;
$$;
create trigger trg_set_lead_protection before insert on companies
  for each row execute function fn_set_lead_protection();

-- ---------------------------------------------------------------
-- 2. TIETOKANTATASON ATOMISUUS (kohta 8: "frontend-tarkistus ei yksin
--    riitä", "käytä yksilöllistä indeksiä"). Käytetään olemassa olevia
--    normalisoituja generoituja sarakkeita (business_id_norm, website_norm)
--    - EI rakenneta erillistä company_identifiers-taulua, se olisi
--    turha kaksoiskirjanpito samasta tiedosta.
--
--    HUOM Postgres-rajoite: indeksin WHERE-lauseke ei voi sisältää now():a
--    (ei-immutable). Siksi ehto on "claim_status = 'active'", EI
--    "protection_expires_at > now()". Tämä tarkoittaa: vanhentuneen (mutta
--    vielä 'active'-leimaisen) rivin claim_status TÄYTYY vaihtua 'expired':ksi
--    ENNEN kuin uusi kilpaileva kirjaus sallitaan - fn_create_company_claim
--    (alla) tekee tämän AINA saman transaktion sisällä ennen INSERTiä, joten
--    oikeellisuus ei riipu ajastimen tilasta turvallisuuskriittisellä polulla
--    (ajastin on vain kohta 6:n "siisti tila myös silloin kun kukaan ei yritä
--    kirjata" -mukavuus, ei tietoturvan perusta).
-- ---------------------------------------------------------------

create unique index companies_active_business_id_unique_idx
  on companies (business_id_norm) where claim_status = 'active' and business_id_norm is not null;
create unique index companies_active_website_unique_idx
  on companies (website_norm) where claim_status = 'active' and website_norm is not null;

-- ---------------------------------------------------------------
-- 3. LOKIKIRJA - erillinen, muuttumaton taulu vain liidisuojatapahtumille
--    (kohta 14: tarkat vaaditut kentät, ei sekoiteta yleiseen audit_logiin).
-- ---------------------------------------------------------------

create table lead_claim_audit_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'company_created', 'duplicate_check_performed', 'possible_duplicate_detected',
    'claim_created', 'claim_conflict_blocked', 'claim_activated', 'claim_expired',
    'claim_released', 'claim_transferred', 'companies_merged',
    'converted_to_customer', 'suspicious_activity_flagged', 'admin_override'
  )),
  company_id uuid references companies (id),
  partner_organization_id uuid references organizations (id),
  performed_by uuid references profiles (id),
  previous_status text,
  new_status text,
  started_at timestamptz,
  expires_at timestamptz,
  reason text,
  details jsonb default '{}',
  created_at timestamptz not null default now()
);
create index lead_claim_audit_company_idx on lead_claim_audit_log (company_id, created_at desc);
create index lead_claim_audit_partner_idx on lead_claim_audit_log (partner_organization_id);

alter table lead_claim_audit_log enable row level security;
-- Ei INSERT-policya clientille - vain SECURITY DEFINER -funktiot kirjoittavat
-- (sama malli kuin audit_log: rivit eivät voi syntyä eivätkä väärentyä
-- suoralla API-kutsulla).
create policy lead_claim_audit_select on lead_claim_audit_log for select
  using (is_super_admin() or partner_organization_id = current_org_id());

create or replace function public.fn_log_claim_event(
  p_event_type text, p_company_id uuid, p_partner_id uuid, p_performed_by uuid,
  p_previous_status text, p_new_status text, p_started_at timestamptz, p_expires_at timestamptz,
  p_reason text, p_details jsonb default '{}'
) returns void
language sql security definer set search_path = public as $$
  insert into lead_claim_audit_log (
    event_type, company_id, partner_organization_id, performed_by,
    previous_status, new_status, started_at, expires_at, reason, details
  ) values (
    p_event_type, p_company_id, p_partner_id, p_performed_by,
    p_previous_status, p_new_status, p_started_at, p_expires_at, p_reason, p_details
  );
$$;

-- Ei erillistä fn_generic_audit-triggeriä tälle taululle - lead_claim_audit_log
-- ON ITSE lokitaulu (fn_log_claim_event kirjoittaa siihen suoraan), audit_log-
-- kaksoiskirjaus olisi tarpeeton eikä sen owning_partner_id/partner_id-
-- sarakeoletus edes täsmää tämän taulun rakenteeseen.

-- ---------------------------------------------------------------
-- 4. DUPLIKAATTI-/SUOJAUSTARKISTUS (5 tulostyyppiä, priorisoidut
--    tunnisteet). Korvaa fn_check_company_duplicate:n kutsupaikat -
--    vanha funktio JÄTETÄÄN ENNALLEEN taaksepäin yhteensopivuuden vuoksi
--    (ei poisteta olemassa olevaa toimivaa koodia), mutta uudet kutsupaikat
--    käyttävät tätä.
--
--    Tulostyypit (result-kenttä):
--      'none'               - ei osumaa, voi kirjata uutena
--      'active_elsewhere'   - AKTIIVISESTI suojattu toisen partnerin
--                             toimesta - EI paljasteta omistajaa/tietoja
--      'own_active'         - kutsujan OMA aktiivinen liidi - avaa se
--      'expired_reclaimable'- vanhentunut/vapautettu suoja - voi varata
--                             UUDELLEEN SAMALLE riville (ei uutta duplikaattia)
--      'uncertain'          - heikompi osuma (nimi/kaupunki/sähköpostin
--                             verkkotunnus/puhelin) - EI koskaan automaattinen
--                             esto, ohjataan tarkistettavaksi
-- ---------------------------------------------------------------

create or replace function public.fn_check_lead_claim(
  p_name text, p_business_id text, p_website text, p_country text, p_city text,
  p_email text, p_phone text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name_norm text := lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_bid_norm text := nullif(regexp_replace(coalesce(p_business_id, ''), '[^0-9A-Za-z]', '', 'g'), '');
  v_site_norm text := nullif(lower(regexp_replace(regexp_replace(coalesce(p_website, ''), '^https?://(www\.)?', ''), '/+$', '')), '');
  v_email_norm text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_email_domain text := nullif(split_part(coalesce(v_email_norm, ''), '@', 2), '');
  v_phone_norm text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_country_norm text := lower(trim(coalesce(p_country, '')));
  v_city_norm text := lower(trim(coalesce(p_city, '')));
  v_match companies%rowtype;
  v_owner_name text;
  v_days_used int;
  v_uncertain jsonb;
begin
  -- Lazy-vanhennus SAMASSA transaktiossa ennen tarkistusta - ks. kohta 2:n
  -- kommentti siitä miksi tämä tehdään tässä eikä vain ajastimessa.
  update companies set claim_status = 'expired'
    where claim_status = 'active' and protection_expires_at < now()
      and ((v_bid_norm is not null and business_id_norm = v_bid_norm)
        or (v_site_norm is not null and website_norm = v_site_norm));

  -- 1) VAHVA: Y-tunnus / rekisterinumero.
  --    HUOM: samalla tunnisteella voi olla USEITA rivejä (reclaim/transfer
  --    arkistoi vanhan ja luo uuden - ks. kohta 6B) - siksi valitaan AINA
  --    "vahvin" osuma prioriteettijärjestyksessä eikä vain vanhin rivi:
  --    asiakas > aktiivinen suoja > (uusin muu, esim. vanhentunut/vapautettu).
  if v_bid_norm is not null then
    select * into v_match from companies where business_id_norm = v_bid_norm
      order by (claim_status = 'converted_to_customer') desc, (claim_status = 'active') desc, created_at desc
      limit 1;
    if found then return fn_claim_result_for_match(v_match); end if;
  end if;

  -- 2) VAHVA: verkkotunnus (sama prioriteettiperiaate kuin yllä).
  if v_site_norm is not null then
    select * into v_match from companies where website_norm = v_site_norm
      order by (claim_status = 'converted_to_customer') desc, (claim_status = 'active') desc, created_at desc
      limit 1;
    if found then return fn_claim_result_for_match(v_match); end if;
  end if;

  -- 3) EPÄVARMA: nimi+maa, nimi+kaupunki, sähköpostin verkkotunnus, puhelin -
  --    EI KOSKAAN automaattinen esto, vain merkitään "uncertain" ja näytetään
  --    turvallisesti tunnistettavat kentät (ei koskaan omistajaa/muistiinpanoja).
  select jsonb_agg(jsonb_build_object(
    'company_id', c.id, 'name', c.name, 'country', c.country, 'city', c.city,
    'website', c.website_norm, 'business_id', case when is_super_admin() or c.owning_partner_id = current_org_id() then c.business_id else null end
  )) into v_uncertain
  from companies c
  where (v_name_norm <> '' and c.name_norm = v_name_norm and (v_country_norm = '' or lower(coalesce(c.country, '')) = v_country_norm))
     or (v_name_norm <> '' and c.name_norm = v_name_norm and v_city_norm <> '' and lower(coalesce(c.city, '')) = v_city_norm)
     or (v_email_domain is not null and split_part(coalesce(c.contact_email_norm, ''), '@', 2) = v_email_domain)
     or (v_phone_norm is not null and c.contact_phone_norm = v_phone_norm)
  limit 5;

  if v_uncertain is not null and jsonb_array_length(v_uncertain) > 0 then
    return jsonb_build_object('result', 'uncertain', 'candidates', v_uncertain);
  end if;

  return jsonb_build_object('result', 'none');
end;
$$;

-- Apufunktio: muodostaa turvallisen vastauksen VAHVALLE (Y-tunnus/verkkotunnus)
-- osumalle riippuen suojaustilasta ja siitä onko osuma oma vai toisen partnerin.
create or replace function public.fn_claim_result_for_match(v_match companies) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner_name text;
  v_is_own boolean := v_match.owning_partner_id = current_org_id();
begin
  if v_match.claim_status <> 'active' then
    -- Vanhentunut/vapautettu/asiakkaaksi muutettu EI OLE varattavissa jos
    -- kyseessä on 'converted_to_customer' - se ei koskaan vapaudu automaattisesti.
    if v_match.claim_status = 'converted_to_customer' then
      if v_is_own then
        return jsonb_build_object('result', 'own_active', 'company_id', v_match.id, 'message', 'Yritys on jo asiakkaanasi.');
      end if;
      return jsonb_build_object('result', 'active_elsewhere', 'message', 'Yritys on jo AerWork-verkoston asiakas, eikä sitä voi varata liidiksi.');
    end if;
    return jsonb_build_object(
      'result', 'expired_reclaimable', 'company_id', v_match.id,
      'message', 'Yrityksen aikaisempi liidisuoja on päättynyt. Voit varata yrityksen uutena liidinä.'
    );
  end if;

  if v_is_own then
    return jsonb_build_object('result', 'own_active', 'company_id', v_match.id, 'message', 'Yritys on jo sinun liidilistallasi.');
  end if;

  if is_super_admin() then
    select name into v_owner_name from organizations where id = v_match.owning_partner_id;
    return jsonb_build_object(
      'result', 'active_elsewhere', 'company_id', v_match.id, 'owner_partner_name', v_owner_name,
      'owner_partner_id', v_match.owning_partner_id, 'protection_expires_at', v_match.protection_expires_at,
      'message', 'Yritys on aktiivisesti suojattu.'
    );
  end if;

  -- Toiselle partnerille: EI omistajaa, EI päättymisaikaa, EI mitään
  -- luottamuksellista - vain kohdan 3 sallima yleinen viesti.
  return jsonb_build_object(
    'result', 'active_elsewhere',
    'message', 'Yritys on jo aktiivisena liidinä Certified Partner -verkostossa, eikä sitä voi tällä hetkellä varata.'
  );
end;
$$;

-- ---------------------------------------------------------------
-- 5. ATOMINEN VARAUS - kutsutaan tallennushetkellä. Yksi transaktio:
--    vanhenna vanhat rivit -> tarkista uudelleen -> INSERT. Jos kaksi
--    partneria yrittää samaa Y-tunnusta/verkkotunnusta SAMANAIKAISESTI,
--    companies_active_business_id_unique_idx / _website_unique_idx
--    (kohta 2) takaa että vain toinen INSERT onnistuu - tämä EI ole pelkkä
--    sovellustason tarkistus.
-- ---------------------------------------------------------------

create or replace function public.fn_create_company_claim(p_company jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_check jsonb;
  v_new companies%rowtype;
  v_owning_partner_id uuid := (p_company->>'owning_partner_id')::uuid;
  v_created_by uuid := (p_company->>'created_by')::uuid;
begin
  v_check := fn_check_lead_claim(
    p_company->>'name', p_company->>'business_id', p_company->>'website',
    p_company->>'country', p_company->>'city', p_company->>'contact_email', p_company->>'contact_phone'
  );

  if v_check->>'result' = 'active_elsewhere' then
    return jsonb_build_object('ok', false, 'conflict', true, 'check', v_check);
  end if;
  if v_check->>'result' = 'own_active' then
    return jsonb_build_object('ok', false, 'conflict', true, 'check', v_check);
  end if;
  -- 'uncertain' ohjataan aina käyttäjän vahvistettavaksi frontendissä ennen
  -- tätä kutsua (kohta 3: "Tämä on eri yritys" -valinta) - jos tänne asti
  -- päästään uncertain-tuloksella, kutsuja on jo vahvistanut sen eri yritykseksi.

  begin
    insert into companies (
      owning_partner_id, name, business_id, country, city, website, industry, employee_count,
      contact_name, contact_title, contact_email, contact_phone, lead_source, status_id,
      currency, notes, created_by, claim_status
    ) values (
      v_owning_partner_id, p_company->>'name', p_company->>'business_id', p_company->>'country',
      p_company->>'city', p_company->>'website', p_company->>'industry',
      nullif(p_company->>'employee_count', '')::int,
      p_company->>'contact_name', p_company->>'contact_title', p_company->>'contact_email',
      p_company->>'contact_phone', p_company->>'lead_source', (p_company->>'status_id')::uuid,
      coalesce(p_company->>'currency', 'EUR'), p_company->>'notes', v_created_by, 'active'
    ) returning * into v_new;
  exception when unique_violation then
    -- Race hävitty - toinen ehti juuri ennen meitä samassa millisekunnissa.
    perform fn_log_claim_event('claim_conflict_blocked', null, v_owning_partner_id, v_created_by,
      null, null, null, null, 'Tietokantatason yksilöllisyysrajoitus esti samanaikaisen varauksen', jsonb_build_object('attempted_name', p_company->>'name'));
    return jsonb_build_object(
      'ok', false, 'conflict', true,
      'check', jsonb_build_object('result', 'active_elsewhere', 'message', 'Toinen Certified Partner ehti juuri varata tämän yrityksen. Yritystä ei lisätty uudelleen.')
    );
  end;

  perform fn_log_claim_event('company_created', v_new.id, v_owning_partner_id, v_created_by,
    null, 'active', v_new.protection_started_at, v_new.protection_expires_at, 'Uusi yritys kirjattu', '{}');
  perform fn_log_claim_event('claim_activated', v_new.id, v_owning_partner_id, v_created_by,
    null, 'active', v_new.protection_started_at, v_new.protection_expires_at, '90 päivän liidisuoja aktivoitu', '{}');

  return jsonb_build_object('ok', true, 'company', to_jsonb(v_new));
end;
$$;

-- ---------------------------------------------------------------
-- 6A. TIETOTURVAKORJAUS ENNEN UUDELLEENVARAUSTA: contacts-taululla EI ollut
--    omaa partner_id-saraketta - sen RLS päättelee näkyvyyden JOIN:lla
--    companies.owning_partner_id:hen DYNAAMISESTI. Tämä tarkoittaisi että
--    jos company-rivin owning_partner_id vaihdetaan uudelleenvarauksessa
--    toiselle partnerille (kohta 6B), UUSI partneri näkisi HETI vanhan
--    partnerin kaikki yhteyshenkilöt - suora tietovuoto joka rikkoisi
--    kohdan 6/10 vaatimuksen ("aikaisemman partnerin luottamuksellisia
--    tietoja ei siirretä uudelle partnerille"). activities/followup_tasks/
--    deals/opportunities eivät kärsi tästä, niillä on jo oma denormalisoitu
--    partner_id (asetettu kertaalleen luontihetkellä, ei muutu vaikka
--    companies.owning_partner_id muuttuisi myöhemmin) - sama korjaus
--    yhtenäistää contacts saman mallin mukaiseksi.
-- ---------------------------------------------------------------

alter table contacts add column partner_id uuid references organizations (id);
update contacts set partner_id = (select owning_partner_id from companies where companies.id = contacts.company_id);
alter table contacts alter column partner_id set not null;
create index contacts_partner_idx on contacts (partner_id);

create or replace function public.fn_set_contact_partner_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.partner_id is null then
    select owning_partner_id into new.partner_id from companies where id = new.company_id;
  end if;
  return new;
end;
$$;
create trigger trg_set_contact_partner_id before insert on contacts
  for each row execute function fn_set_contact_partner_id();

-- SELECT nojaa nyt AINA contacts.partner_id:hen (kiinteä luontihetkellä) EI
-- companies.owning_partner_id:hen (voi muuttua kohdan 6B uudelleenvarauksessa).
drop policy if exists contacts_select on contacts;
create policy contacts_select on contacts for select
  using (
    is_super_admin()
    or (
      partner_id = current_org_id()
      and exists (
        select 1 from companies c where c.id = contacts.company_id
        and (app_current_role() in ('partner_admin', 'read_only') or not c.restricted_visibility or c.responsible_user_id = auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------
-- 6B. VANHENTUNEEN SUOJAN UUDELLEENVARAUS.
--    SAMA partneri varaa oman vanhentuneen liidinsä uudelleen -> turvallista
--    käyttää samaa riviä sellaisenaan (mikään ei "vuoda" itselleen).
--    ERI partneri varaa -> VANHA rivi ARKISTOIDAAN sellaisenaan (kaikki sen
--    contact/activity/followup/opportunity/deal-historia pysyy ikuisesti
--    vain alkuperäisen partnerin + valtuutetun ylläpidon nähtävissä, koska
--    ne kaikki on sidottu KIINTEÄÄN partner_id:hen eivätkä companies-rivin
--    owning_partner_id:hen), ja UUSI rivi luodaan UUDELLE partnerille vain
--    "master"-identiteettitiedoilla (nimi/Y-tunnus/maa/kaupunki/verkkotunnus/
--    toimiala) - EI vanhan partnerin yhteyshenkilöä/muistiinpanoja/arvoa.
--    reclaimed_from_company_id linkittää historian Ownerin nähtäväksi.
-- ---------------------------------------------------------------

alter table companies add column reclaimed_from_company_id uuid references companies (id);

create or replace function public.fn_reclaim_expired_company(p_company_id uuid, p_owning_partner_id uuid, p_created_by uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row companies%rowtype;
  v_new companies%rowtype;
  v_prev_status text;
begin
  select * into v_row from companies where id = p_company_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Yritystä ei löytynyt.'); end if;
  if v_row.claim_status = 'active' then
    return jsonb_build_object('ok', false, 'conflict', true, 'error', 'Yritys on jo varattu - päivitä sivu ja tarkista tilanne.');
  end if;
  if v_row.claim_status = 'converted_to_customer' then
    return jsonb_build_object('ok', false, 'error', 'Yritys on jo AerWork-verkoston asiakas, ei voida varata uudelleen liidiksi.');
  end if;
  v_prev_status := v_row.claim_status;

  if v_row.owning_partner_id = p_owning_partner_id then
    -- Sama partneri: turvallista jatkaa samalla rivillä.
    update companies set
      claim_status = 'active', protection_started_at = now(), protection_expires_at = now() + interval '90 days',
      converted_to_customer_at = null, converted_to_customer_by = null,
      released_at = null, released_by = null, release_reason = null, created_by = p_created_by
    where id = p_company_id
    returning * into v_new;
  else
    -- Eri partneri: arkistoidaan vanha rivi koskematta, luodaan uusi rivi
    -- vain master-identiteettitiedoilla.
    update companies set archived_at = now() where id = p_company_id;
    insert into companies (
      owning_partner_id, name, business_id, country, city, website, industry, employee_count,
      created_by, claim_status, reclaimed_from_company_id
    ) values (
      p_owning_partner_id, v_row.name, v_row.business_id, v_row.country, v_row.city, v_row.website,
      v_row.industry, v_row.employee_count, p_created_by, 'active', v_row.id
    ) returning * into v_new;
  end if;

  perform fn_log_claim_event('claim_activated', v_new.id, p_owning_partner_id, p_created_by,
    v_prev_status, 'active', v_new.protection_started_at, v_new.protection_expires_at,
    'Vanhentunut/vapautettu liidi varattu uudelleen', jsonb_build_object('previous_company_row', v_row.id));

  return jsonb_build_object('ok', true, 'company', to_jsonb(v_new));
end;
$$;

-- ---------------------------------------------------------------
-- 7. LIIDI ASIAKKAAKSI - EI vapaudu enää koskaan automaattisesti
--    90 päivän jälkeen. Kuka tahansa jolla on kirjoitusoikeus omaan
--    yritykseensä saa tehdä tämän (sama oikeustaso kuin muutkin yritys-
--    päivitykset, companies_update-policy jo rajaa organisaatioon).
-- ---------------------------------------------------------------

create or replace function public.fn_convert_lead_to_customer(p_company_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row companies%rowtype;
begin
  select * into v_row from companies where id = p_company_id
    and (is_super_admin() or owning_partner_id = current_org_id())
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Yritystä ei löytynyt tai ei oikeutta.'); end if;
  if v_row.claim_status = 'converted_to_customer' then
    return jsonb_build_object('ok', false, 'error', 'Yritys on jo merkitty asiakkaaksi.');
  end if;

  update companies set
    claim_status = 'converted_to_customer', converted_to_customer_at = now(), converted_to_customer_by = auth.uid()
  where id = p_company_id returning * into v_row;

  perform fn_log_claim_event('converted_to_customer', v_row.id, v_row.owning_partner_id, auth.uid(),
    'active', 'converted_to_customer', v_row.protection_started_at, v_row.protection_expires_at, p_reason, '{}');

  return jsonb_build_object('ok', true, 'company', to_jsonb(v_row));
end;
$$;

-- ---------------------------------------------------------------
-- 8. YLLÄPIDON HALLINTATOIMINNOT (kohta 11) - vain Owner/AerWork-ylläpito.
--    Kaikissa: syy pakollinen, vanha+uusi arvo lokiin, muutoksen tekijä lokiin.
--    HUOM: nämä ovat SECURITY DEFINER ja ohittavat RLS:n kokonaan - siksi
--    is_super_admin()-tarkistus AUTH.UID():n perusteella on pakollinen SISÄLLÄ
--    funktiota, ei riitä että kutsuva Netlify-funktio "luottaa" parametriin.
-- ---------------------------------------------------------------

create or replace function public.fn_release_lead_claim(p_company_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row companies%rowtype;
begin
  if not is_super_admin() then return jsonb_build_object('ok', false, 'error', 'Vain AerWork-ylläpito voi vapauttaa liidin.'); end if;
  if p_reason is null or trim(p_reason) = '' then return jsonb_build_object('ok', false, 'error', 'Syy on pakollinen.'); end if;

  select * into v_row from companies where id = p_company_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Yritystä ei löytynyt.'); end if;

  update companies set claim_status = 'released', released_at = now(), released_by = auth.uid(), release_reason = p_reason
  where id = p_company_id returning * into v_row;

  perform fn_log_claim_event('claim_released', v_row.id, v_row.owning_partner_id, auth.uid(),
    'active', 'released', v_row.protection_started_at, v_row.protection_expires_at, p_reason, '{}');
  return jsonb_build_object('ok', true, 'company', to_jsonb(v_row));
end;
$$;

create or replace function public.fn_transfer_lead_claim(p_company_id uuid, p_new_partner_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row companies%rowtype; v_prev_partner uuid;
begin
  if not is_super_admin() then return jsonb_build_object('ok', false, 'error', 'Vain AerWork-ylläpito voi siirtää liidin.'); end if;
  if p_reason is null or trim(p_reason) = '' then return jsonb_build_object('ok', false, 'error', 'Syy on pakollinen.'); end if;

  select * into v_row from companies where id = p_company_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Yritystä ei löytynyt.'); end if;
  v_prev_partner := v_row.owning_partner_id;

  -- Sama tietoturvaperiaate kuin fn_reclaim_expired_company: siirto TOISELLE
  -- partnerille ei saa siirtää vanhan partnerin luottamuksellisia kenttiä,
  -- joten myös tämä arkistoi vanhan ja luo uuden master-identiteettitiedoilla.
  update companies set archived_at = now() where id = p_company_id;
  insert into companies (
    owning_partner_id, name, business_id, country, city, website, industry, employee_count,
    created_by, claim_status, protection_started_at, protection_expires_at, reclaimed_from_company_id
  ) values (
    p_new_partner_id, v_row.name, v_row.business_id, v_row.country, v_row.city, v_row.website,
    v_row.industry, v_row.employee_count, auth.uid(), 'active', now(), now() + interval '90 days', v_row.id
  ) returning * into v_row;

  perform fn_log_claim_event('claim_transferred', v_row.id, p_new_partner_id, auth.uid(),
    v_prev_partner::text, p_new_partner_id::text, v_row.protection_started_at, v_row.protection_expires_at, p_reason, '{}');
  return jsonb_build_object('ok', true, 'company', to_jsonb(v_row));
end;
$$;

-- Virheellisesti luotu duplikaatti SAMAN partnerin sisällä - yhdistää
-- lapsitaulujen viittaukset "keep"-riville, arkistoi "remove"-rivin.
-- KIELTÄYTYY yhdistämästä kahden ERI partnerin rivejä (se ei ole tämän
-- funktion tehtävä - ks. kohta 6B/fn_transfer_lead_claim eri tapauksille).
create or replace function public.fn_merge_duplicate_companies(p_keep_id uuid, p_remove_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_keep companies%rowtype; v_remove companies%rowtype;
begin
  if not is_super_admin() then return jsonb_build_object('ok', false, 'error', 'Vain AerWork-ylläpito voi yhdistää yritystietueita.'); end if;
  if p_reason is null or trim(p_reason) = '' then return jsonb_build_object('ok', false, 'error', 'Syy on pakollinen.'); end if;
  if p_keep_id = p_remove_id then return jsonb_build_object('ok', false, 'error', 'Ei voi yhdistää riviä itsensä kanssa.'); end if;

  select * into v_keep from companies where id = p_keep_id for update;
  select * into v_remove from companies where id = p_remove_id for update;
  if not found or v_keep.id is null or v_remove.id is null then return jsonb_build_object('ok', false, 'error', 'Yritystä ei löytynyt.'); end if;
  if v_keep.owning_partner_id <> v_remove.owning_partner_id then
    return jsonb_build_object('ok', false, 'error', 'Rivit kuuluvat eri partnereille - käytä liidin siirtoa, ei yhdistämistä.');
  end if;

  update contacts set company_id = p_keep_id where company_id = p_remove_id;
  update activities set company_id = p_keep_id where company_id = p_remove_id;
  update followup_tasks set company_id = p_keep_id where company_id = p_remove_id;
  update deals set company_id = p_keep_id where company_id = p_remove_id;
  update opportunities set company_id = p_keep_id where company_id = p_remove_id;
  update external_company_records set company_id = p_keep_id where company_id = p_remove_id;
  update decision_makers set company_id = p_keep_id where company_id = p_remove_id;
  update job_postings set company_id = p_keep_id where company_id = p_remove_id;
  -- opportunity_scores.company_id on UNIQUE - jos "keep"-rivillä on jo pisteet,
  -- "remove"-rivin pisteet vain poistetaan (ei kahta pistettä samalle yritykselle).
  delete from opportunity_scores where company_id = p_remove_id and exists (select 1 from opportunity_scores where company_id = p_keep_id);
  update opportunity_scores set company_id = p_keep_id where company_id = p_remove_id;

  update companies set archived_at = now() where id = p_remove_id;

  perform fn_log_claim_event('companies_merged', p_keep_id, v_keep.owning_partner_id, auth.uid(),
    null, null, null, null, p_reason, jsonb_build_object('merged_from_company_id', p_remove_id));

  return jsonb_build_object('ok', true, 'company_id', p_keep_id);
end;
$$;

-- ---------------------------------------------------------------
-- 9. AJASTETTU VANHENEMINEN (kohta 6: "älä luota pelkästään frontend-
--    ajastimeen"). Kutsutaan Netlify Scheduled Functionista määräajoin -
--    tämä on VARMISTUS/siisteys koko kannalle, ei tietoturvan perusta
--    (se on kohdan 2/5 lazy-vanhennus samassa transaktiossa kuin kirjaus).
-- ---------------------------------------------------------------

create or replace function public.fn_expire_stale_lead_claims() returns int
language plpgsql security definer set search_path = public as $$
declare v_count int := 0; v_row record;
begin
  for v_row in select id, owning_partner_id, protection_started_at, protection_expires_at from companies
    where claim_status = 'active' and protection_expires_at < now()
  loop
    update companies set claim_status = 'expired' where id = v_row.id;
    perform fn_log_claim_event('claim_expired', v_row.id, v_row.owning_partner_id, null,
      'active', 'expired', v_row.protection_started_at, v_row.protection_expires_at, 'Automaattinen vanheneminen (90 vrk)', '{}');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------
-- 10. "Lähetä ylläpidon tarkistettavaksi" (kohta 3: epävarma osuma ->
--     yksi kolmesta vaihtoehdosta). Vain oman yrityksen omistaja (tai
--     Owner) saa merkitä sen tarkistukseen.
-- ---------------------------------------------------------------

create or replace function public.fn_flag_lead_for_review(p_company_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row companies%rowtype;
begin
  select * into v_row from companies where id = p_company_id
    and (is_super_admin() or owning_partner_id = current_org_id())
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Yritystä ei löytynyt tai ei oikeutta.'); end if;

  update companies set claim_status = 'under_review' where id = p_company_id returning * into v_row;

  perform fn_log_claim_event('suspicious_activity_flagged', v_row.id, v_row.owning_partner_id, auth.uid(),
    'active', 'under_review', v_row.protection_started_at, v_row.protection_expires_at, p_reason, '{}');
  return jsonb_build_object('ok', true, 'company', to_jsonb(v_row));
end;
$$;
