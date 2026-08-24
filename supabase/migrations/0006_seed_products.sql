-- AerWorkin todelliset myytävät tuotteet myyntiputken "Tuote"-valikkoon.
-- Oletushinnaksi jätetty 0 € tarkoituksella (ei keksitä hintaa) - myyjä
-- täyttää oikean kuukausihinnan aina kauppakohtaisesti "Voitettu"-lomakkeella.
-- Idempotentti: ajettavissa turvallisesti uudelleen (ei luo duplikaatteja).

insert into products (name, default_monthly_price, default_setup_fee, default_currency, active)
select 'AerWork', 0, 0, 'EUR', true
where not exists (select 1 from products where name = 'AerWork');

insert into products (name, default_monthly_price, default_setup_fee, default_currency, active)
select 'Henkilöstövuokraus', 0, 0, 'EUR', true
where not exists (select 1 from products where name = 'Henkilöstövuokraus');
