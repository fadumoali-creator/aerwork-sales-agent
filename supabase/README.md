# AerWork Certified Partner CRM — Supabase-käyttöönotto

Tämä hakemisto sisältää CRM:n koko tietokantaskeeman (relaatiotaulut, roolipohjainen
pääsynhallinta Row Level Securityllä, audit log, laskentafunktiot). CRM on oma
moduuli olemassa olevan AerWork LinkedIn-agentin rinnalla — se ei muuta agentin
toimintaa (`index.html`, `netlify/functions/chat*.js`).

## 1. Luo Supabase-projekti

1. Mene [supabase.com](https://supabase.com) → New project.
2. Kun projekti on valmis: **Project Settings → API** — kopioi talteen:
   - `Project URL` → tästä tulee `SUPABASE_URL`
   - `anon public` -avain → tästä tulee `SUPABASE_ANON_KEY` (turvallinen paljastaa selaimelle, RLS suojaa)
   - `service_role` -avain → tästä tulee `SUPABASE_SERVICE_ROLE_KEY` (**salainen**, vain Netlify-funktioihin, ei koskaan frontendiin)

## 2. Aja migraatio

**Dashboard → SQL Editor** → liitä koko `supabase/migrations/0001_crm_schema.sql` → Run.

(Vaihtoehtoisesti Supabase CLI:llä: `supabase db push` jos projekti on linkitetty.)

Migraatio luo:
- kaikki taulut (organizations, profiles, companies, contacts, activities, deals, ...)
- kaikki RLS-policyt partnerieristykseen
- audit_log + triggerit jotka kirjaavat muutokset automaattisesti
- MRR/ARR/kesto/komissio-laskentafunktiot ja triggerit
- siemendatana kaikki 19 asiakkuuden tilaa ja 9 sopimuksen tilaa

## 3. Aseta Netlifyn ympäristömuuttujat

**Netlify → Site configuration → Environment variables**, lisää:

| Muuttuja | Arvo | Kenelle näkyy |
|---|---|---|
| `SUPABASE_URL` | Project URL | Julkinen (frontend saa tämän `crm-config`-funktion kautta) |
| `SUPABASE_ANON_KEY` | anon public -avain | Julkinen (RLS suojaa datan, ei salaisuus) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role-avain | **VAIN palvelinpuoli** — käytetään ainoastaan `crm-invite-user.js`- ja `crm-transfer-ownership.js`-funktioissa |

Tee uusi deploy asettamisen jälkeen.

## 4. Luo ensimmäinen AerWork Super Admin -käyttäjä

Migraatio luo valmiiksi yhden `organizations`-rivin AerWorkille
(`id = 00000000-0000-0000-0000-000000000001`). Luo ensimmäinen kirjautuja
manuaalisesti (myöhemmät käyttäjät kutsutaan sovelluksesta "Käyttäjät"-näkymän kautta):

1. **Supabase Dashboard → Authentication → Users → Add user** — luo tili sähköpostilla + salasanalla (tai lähetä kutsu).
2. **SQL Editor**, aja (korvaa arvot):
   ```sql
   insert into profiles (id, organization_id, email, name, role)
   values (
     '<auth.users.id juuri luodulta käyttäjältä>',
     '00000000-0000-0000-0000-000000000001',
     'sinun@aerwork.fi',
     'Etunimi Sukunimi',
     'super_admin'
   );
   ```
3. Kirjaudu osoitteessa `/crm/` näillä tunnuksilla.

Certified Partner -organisaatiot luodaan `organizations`-tauluun (`type = 'certified_partner'`)
Super Adminin toimesta — tähän voidaan myöhemmin lisätä oma UI-lomake; MVP-vaiheessa
tehdään SQL Editorista tai jatkokehityksessä "Certified Partnerit"-näkymästä.

## 5. Testaa käyttöoikeudet ENNEN tuotantoa

Aja RLS-eristystesti (ks. `tests/rls-smoke-test.js`) kahdella eri partnerin testitunnuksella:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... \
TEST_PARTNER_A_EMAIL=... TEST_PARTNER_A_PASSWORD=... \
TEST_PARTNER_B_EMAIL=... TEST_PARTNER_B_PASSWORD=... \
npm run test:rls
```

Tämä yrittää nimenomaan MURTAA partnerieristyksen suoralla API-kutsulla (ei sovelluksen
kautta) — testin pitää epäonnistua jokaisessa yrityksessä (eli eristys pitää).

## Mitä tämä MVP kattaa nyt

- Organisaatiot, käyttäjät, roolit (super_admin / partner_admin / partner_user / read_only)
- Yritykset + kontaktit + duplikaattitarkistus partnerirajojen yli (ei tietovuotoa)
- Aktiviteetit/yhteydenottoaikajana per yritys
- Myyntiputki (19 hallittavaa tilaa) + Kanban + audit log jokaisesta statusmuutoksesta
- Follow-up-tehtävät (myöhässä/tänään/tulossa) + sääntö "ei sulkemista ilman uutta follow-upia"
- Dashboard (KPI:t + partnerikohtainen jakauma Super Adminille)
- Sopimukset/tarjoukset/tuotteet/komissiot: **tietokantarakenne ja laskenta on jo tässä
  migraatiossa** (`deals`, `deal_line_items`, `products`, `commission_rules`,
  `fn_recalc_deal_totals`), mutta niiden UI-näkymät (Tarjoukset/Sopimukset/Komissiot-
  välilehdet) rakennetaan vaiheessa 2 alkuperäisen suunnitelman mukaisesti.

## Ei vielä toteutettu (myöhemmät vaiheet, ks. hyväksytty suunnitelma)

- Tarjous-/Sopimus-/Komissiot-näkymät UI:ssa (data-malli on jo valmis)
- Excel-vienti (CSV-vienti on jo Yritykset-näkymässä)
- Raportit-näkymä (konversiosuppilo, myydyimmät tuotteet)
- Certified Partnerit -hallintanäkymä UI:ssa (siirto-API on jo valmis: `crm-transfer-ownership.js`)
- Sähköposti-/kalenteri-/allekirjoitus-/laskutusintegraatiot (skeema jättää niille tilaa: `contract_document_ref`, `attachments jsonb`)
