-- Täydentää 90 päivän liidisuojan aikaleimat yrityksille jotka luotiin ENNEN
-- migraatiota 0009 (trg_set_lead_protection ei voinut koskea niihin, koska
-- se laukeaa vain INSERTissä). Ilman tätä nämä yritykset eivät koskaan
-- laskeudu Dashboardin suojaus-KPI-kortteihin eivätkä koskaan vanhene
-- automaattisesti, vaikka niiden claim_status on 'active'.
--
-- Käyttäjän päätös (kysytty erikseen): anna vanhoille active-yrityksille
-- 90 vrk suoja TÄSTÄ HETKESTÄ (ei taannehtivasti niiden alkuperäisestä
-- luontiajasta) - ei kosketa mitään muuta dataa, täyttää vain puuttuvat
-- kentät. Archived-yrityksiä ei kosketa (ei ole enää aktiivisia liidejä).

update companies
set protection_started_at = now(),
    protection_expires_at = now() + interval '90 days'
where claim_status = 'active'
  and protection_started_at is null
  and archived_at is null;
