-- KRIITTINEN KORJAUS: Owner Super Adminin PITÄÄ nähdä kaikki mitä Super Admin
-- näkee (companies, contacts, activities, deals, followup_tasks, audit_log,
-- profiles, organizations, ownership_transfer_log, lookups) - spesifikaation
-- mukaan Owner on "korkeampi kuin tavallinen Super Admin".
--
-- Kaikki nämä taulut käyttävät RLS-policyissaan is_super_admin()-funktiota
-- "näe kaikki partnerit" -ohituksena. Koska owner_super_admin on ERI
-- rooliarvo kuin super_admin, is_super_admin() palautti ownerille false eikä
-- owner nähnyt mitään näistä tauluista partnerinsa (AerWork) ulkopuolelta.
--
-- Korjaus: is_super_admin() palauttaa nyt TOSI myös silloin kun kutsuja on
-- vahvistettu Owner Super Admin (kolmoisportti: rooli + allowlist + sessio,
-- ks. is_owner_super_admin() migraatiossa 0002). Tämä yksi muutos periytyy
-- automaattisesti kaikkiin policy-lausekkeisiin jotka jo käyttävät
-- is_super_admin()-funktiota - ei tarvitse muokata jokaista policya erikseen.

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from profiles where id = auth.uid() and role = 'super_admin' and active)
    or is_owner_super_admin();
$$;
