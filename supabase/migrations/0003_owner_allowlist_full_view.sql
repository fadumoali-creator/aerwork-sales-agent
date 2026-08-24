-- Pieni korjaus migraatioon 0002: Owner Settings -näkymä tarvitsee nähdä KOKO
-- owner_allowlist-taulun (kaikki hyväksytyt owner-tilit), ei vain oman rivinsä.
-- Tämä on turvallista, koska pääsy tähän tauluun on jo rajattu
-- is_owner_super_admin()-funktiolla (kolmoisportti pitää täyttyä ennen kuin
-- tätä kyselyä voi edes ajaa) — kyse ei ole uudesta oikeuksien laajennuksesta,
-- vaan siitä että jo-vahvistettu owner näkee listan muista owner-tileistä.
--
-- Kirjoitusoikeutta EI silti lisätä UI:sta - allowlistiin lisätään/poistetaan
-- yhä vain SQL Editorista/service-rolella, kuten migraatio 0002 dokumentoi.

drop policy if exists owner_reads_own_allowlist on owner_allowlist;
create policy owner_reads_allowlist on owner_allowlist for select
  using (is_owner_super_admin());
