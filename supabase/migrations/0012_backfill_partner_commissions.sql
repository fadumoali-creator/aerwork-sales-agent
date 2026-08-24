-- Taannehtiva täydennys migraatiolle 0011 - sama periaate kuin 0010:ssä.
-- Kaksi asiaa eivät voineet syntyä pelkillä triggereillä, koska ne
-- reagoivat vain UUSIIN kirjoituksiin eivätkä koskeneet olemassa olevaan
-- dataan:
--   1) partnerien kumppanitaso (uusi sarake, ei kenelläkään vielä arvoa)
--   2) jo voitettujen sopimusten companies-rivin provisiokauden lukitus
--      (trg_lock_company_commission_period ei laukea takautuvasti)
--
-- PÄÄTÖS (käyttäjän hyväksymä "tee miten näet parhaaksi" -valtuutuksella,
-- ks. Partnerikomissioiden Määrittely -dokumentin kysymys 9.3): koska
-- todellista kumppanitasoa ei ole tallennettu CRM:ään mihinkään, EI ARVATA
-- ketään korkeammalle tasolle. Kaikki nykyiset Certified Partner
-- -organisaatiot saavat matalimman, turvallisimman oletustason
-- (Introduction Partner, 10 % / 12 kk / 5 % AI). Tämä on tarkoituksella
-- konservatiivinen: se EI KOSKAAN ylimaksa ketään, ja Owner voi korjata
-- minkä tahansa partnerin oikean tason milloin tahansa valmiiksi
-- rakennetulla "Muuta kumppanitasoa" -toiminnolla (fn_set_partner_level) -
-- muutos näkyy vain UUSILLE Partner Customereille (spec 3.5), joten tämä
-- oletus ei vahingoita jo lukittuja kausia korjauksen jälkeenkään.

-- ---------------------------------------------------------------
-- 1. Kumppanitason oletusarvo kaikille certified_partner-organisaatioille
-- ---------------------------------------------------------------

update organizations
set partner_level = 'introduction', partner_level_set_at = now()
where type = 'certified_partner' and partner_level is null;

insert into partner_level_history (partner_id, previous_level, new_level, reason, performed_by)
select id, null, 'introduction',
  'Migraatio 0012: MVP-käyttöönoton konservatiivinen oletustaso (ei vahvistettu Ownerin toimesta - korjaa "Muuta kumppanitasoa" -toiminnolla oikeaksi)',
  null
from organizations
where type = 'certified_partner' and partner_level_set_at = now();

-- ---------------------------------------------------------------
-- 2. Jo voitettujen sopimusten provisiokauden taannehtiva lukitus
--    (yrityksen VARHAISIN contract_start_date määrää kauden alun, koska
--    sama sääntö pätisi eteenpäinkin - spec 3.1).
-- ---------------------------------------------------------------

with earliest_deal as (
  select distinct on (d.company_id) d.company_id, d.contract_start_date, d.partner_id
  from deals d
  where d.contract_start_date is not null and d.archived_at is null
  order by d.company_id, d.contract_start_date asc
)
update companies c
set
  commission_period_started_at = ed.contract_start_date,
  commission_period_ends_at = (ed.contract_start_date + (ptd.period_months || ' months')::interval)::date,
  commission_rate_locked = ptd.subscription_rate,
  ai_credit_rate_locked = ptd.ai_credit_rate,
  partner_level_locked = coalesce(o.partner_level, 'introduction')
from earliest_deal ed
join organizations o on o.id = ed.partner_id
join partner_tier_defaults ptd on ptd.tier = coalesce(o.partner_level, 'introduction')
where c.id = ed.company_id
  and c.commission_period_started_at is null;

-- ---------------------------------------------------------------
-- 3. Ensimmäinen ledger-generointi heti, jotta olemassa oleva data näkyy
--    Dashboardissa/partnerinäkymässä ilman että pitää odottaa seuraavaa
--    ajastettua ajoa.
-- ---------------------------------------------------------------

select fn_generate_commission_ledger();
