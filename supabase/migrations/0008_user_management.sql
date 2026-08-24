-- Käyttäjät ja käyttöoikeudet -uudistus (ks. hyväksytty "Käyttäjähallinnan
-- määrittely" -dokumentti). Rooleja EI nimetä uudelleen tietokannassa -
-- vain käyttöliittymässä (roleLabel() crm/app.js:ssä) - koska roolistringit
-- on kirjoitettu suoraan kymmeniin RLS-policyihin ja funktioihin.

-- ---------------------------------------------------------------
-- 1. TIETOTURVAKORJAUS: estetyn (active=false) käyttäjän DB-pääsy ei
--    tosiasiassa katkennut kokonaan aiemmin.
--
--    current_org_id() ja app_current_role() eivät tarkistaneet active-
--    saraketta. Monet RLS-policyt (esim. companies_select) sallivat pääsyn
--    OR-ehdolla joka ei vaadi tiettyä roolia (esim. "or not restricted_visibility")
--    - näissä haaroissa active-tila EI estänyt mitään, koska ainoa mitä
--    tarkistettiin oli current_org_id()-osuma. Korjataan yhdestä paikasta:
--    kun nämä palauttavat NULL estetylle käyttäjälle, KAIKKI niitä käyttävät
--    "= current_org_id()" / "in (app_current_role())" -vertailut epäonnistuvat
--    automaattisesti SQL:n NULL-semantiikan ansiosta.
-- ---------------------------------------------------------------

create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from profiles where id = auth.uid() and active;
$$;

create or replace function public.app_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active;
$$;

-- ---------------------------------------------------------------
-- 2. TIETOTURVAKORJAUS: profiles_admin_write ei rajoittanut MITÄ roolia
--    saa myöntää (vain KENEN riviä saa muokata). partner_admin pystyi
--    tosiasiassa nostamaan kenet tahansa omassa organisaatiossaan vaikka
--    super_adminiksi suoralla PostgREST-kutsulla, koska policyssä ei ollut
--    with check -lauseketta. Korjataan speksin vaatimus "käyttäjä ei voi
--    myöntää roolia joka on hänen omaa rooliaan korkeampi".
-- ---------------------------------------------------------------

drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for update
  using (
    is_owner_super_admin()
    or (is_super_admin() and role <> 'owner_super_admin') -- super_admin ei koskaan koske omistajarooliin
    or (is_partner_admin() and organization_id = current_org_id() and role in ('partner_user', 'read_only'))
  )
  with check (
    is_owner_super_admin()
    or (is_super_admin() and role <> 'owner_super_admin') -- eikä voi MYÖSKÄÄN nostaa ketään omistajaksi
    or (is_partner_admin() and organization_id = current_org_id() and role in ('partner_user', 'read_only'))
  );

-- ---------------------------------------------------------------
-- 3. Viimeistä aktiivista Owner Super Adminia ei voi alentaa/estää.
--    "Aktiivinen omistaja" = role='owner_super_admin' JA active JA
--    hyväksytty owner_allowlist-rivi (kolmoisportin mukainen, ei pelkkä
--    roolimerkintä).
-- ---------------------------------------------------------------

create or replace function public.fn_protect_last_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_other_active_owners int;
begin
  if old.role = 'owner_super_admin'
     and exists (select 1 from owner_allowlist where user_id = old.id and active)
     and (new.role is distinct from 'owner_super_admin' or new.active = false) then
    select count(*) into v_other_active_owners
      from profiles p
      join owner_allowlist oa on oa.user_id = p.id and oa.active
      where p.role = 'owner_super_admin' and p.active and p.id <> old.id;
    if v_other_active_owners = 0 then
      raise exception 'Viimeistä aktiivista Owner Super Adminia ei voi alentaa tai estää.';
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_protect_last_owner before update on profiles
  for each row execute function fn_protect_last_owner();

-- ---------------------------------------------------------------
-- 4. "Poistettu organisaatiosta" eri tila kuin "estetty" (jälkimmäinen on
--    palautettavissa, kumpikin soft-delete - profiilia ei koskaan poisteta
--    fyysisesti jotta audit_log ja historiatiedot säilyvät).
-- ---------------------------------------------------------------

alter table profiles add column removed_at timestamptz;
alter table profiles add column removed_by uuid references profiles (id);

-- ---------------------------------------------------------------
-- 5. Audit-triggeri myös profiles-tauluun - kutsut/roolinvaihdot/estot
--    eivät kirjautuneet lokiin lainkaan aiemmin. fn_generic_audit tunnistaa
--    partnerin owning_partner_id/partner_id-sarakkeista - lisätään
--    organization_id kolmanneksi vaihtoehdoksi (profiles-taulun oma nimi),
--    ei vaikuta olemassa oleviin tauluihin koska niillä ei ole tätä saraketta.
-- ---------------------------------------------------------------

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
    v_partner_id := coalesce(v_new->>'owning_partner_id', v_new->>'partner_id', v_new->>'organization_id');
    insert into audit_log (table_name, record_id, action, changed_by, partner_id)
      values (tg_table_name, new.id, 'create', auth.uid(), v_partner_id::uuid);
    return new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_partner_id := coalesce(v_new->>'owning_partner_id', v_new->>'partner_id', v_new->>'organization_id');
    -- Käytetään jsonb-hakua suoran new.archived_at-viittauksen sijaan, koska
    -- tämä sama triggerifunktio kytketään nyt myös profiles/invitations-
    -- tauluihin joilla EI ole archived_at-saraketta lainkaan - suora
    -- kenttäviittaus kaataisi koko UPDATE-triggerin niillä tauluilla.
    v_action := case when ((v_new->>'archived_at') is not null and (v_old->>'archived_at') is null) then 'archive'
                     when ((v_new->>'archived_at') is null and (v_old->>'archived_at') is not null) then 'restore'
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

create trigger trg_audit_profiles after insert or update on profiles
  for each row execute function fn_generic_audit();

-- ---------------------------------------------------------------
-- 6. INVITATIONS - seurantataulu kutsuille. Itse kutsutunniste (turvallinen,
--    kertakäyttöinen, vanheneva) on Supabase Authin oma inviteUserByEmail-
--    mekanismi (ei keksitä omaa salaista token-toteutusta rinnalle - Auth
--    hoitaa sen jo oikein). Tämä taulu seuraa kutsun TILAA (pending/accepted/
--    expired/revoked) UI:ta, kaksoiskutsujen estoa, uudelleenlähetystä ja
--    lokitusta varten.
-- ---------------------------------------------------------------

create table invitations (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid, -- Supabase Authin luoma tunniste (asetetaan kun kutsu lähtee)
  email text not null,
  email_norm text generated always as (lower(trim(email))) stored,
  first_name text not null,
  last_name text not null,
  organization_id uuid not null references organizations (id),
  role text not null check (role in ('super_admin', 'partner_admin', 'partner_user', 'read_only')),
  -- owner_super_admin EI ole kutsuttavissa tämän kautta - vaatii aina erillisen
  -- manuaalisen owner_allowlist-lisäyksen (kolmoisportin toinen puoli).
  phone text,
  team text,
  message text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  invited_by uuid not null references profiles (id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references profiles (id),
  resend_count int not null default 0,
  last_sent_at timestamptz not null default now(),
  last_send_error text,
  created_at timestamptz not null default now()
);

-- Vain yksi avoin (pending) kutsu samalle sähköpostille samaan organisaatioon
-- kerrallaan - estää vahingossa tapahtuvat kaksoiskutsut tietokantatasolla,
-- ei vain sovelluslogiikassa.
create unique index invitations_pending_unique_idx on invitations (email_norm, organization_id) where status = 'pending';
create index invitations_org_idx on invitations (organization_id);
create index invitations_status_idx on invitations (status);

alter table invitations enable row level security;

-- Ei INSERT/UPDATE-policya tavallisille käyttäjille - kaikki kirjoitukset
-- kulkevat service-role Netlify-funktioiden kautta (sama malli kuin
-- audit_log: rivit syntyvät vain palvelinpuolelta, ei suoraan clientistä).
create policy invitations_select on invitations for select
  using (
    is_super_admin()
    or (is_partner_admin() and organization_id = current_org_id())
  );

create trigger trg_audit_invitations after insert or update on invitations
  for each row execute function fn_generic_audit();
