-- Kolmas myytävä tuote: räätälöity kehitystyö. Sama periaate kuin
-- 0006:ssa - oletushinta 0 €, ei keksitä, aina täytetty kauppakohtaisesti.
-- Idempotentti: turvallinen ajaa uudelleen.

insert into products (name, default_monthly_price, default_setup_fee, default_currency, active)
select 'Kehitys', 0, 0, 'EUR', true
where not exists (select 1 from products where name = 'Kehitys');
