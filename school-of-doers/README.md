# School of Doers — Tiimiagentit (Sales / Marketing / Social media)

Kolme chat-agenttia School of Doersin kolmelle tiimille. **School of Doers on
oma, itsenäinen yrityksensä — eri yritys kuin AerWork, mutta samalla
omistajalla** (ks. RISTIINMYYNTI-kohta alla). Tämä kansio on **oma, erillinen
Netlify-sivusto** — eri deploy, eri domain, eri ympäristömuuttujat kuin
juuriprojektin AerWork-agentilla, vaikka koodimalli (job-polling-malli
Netlify Background Functionilla) on samalla periaatteella rakennettu. Kaikki
kolme tiimiä jakavat yhden taustafunktion kolmen erillisen tiedoston sijaan.

## School of Doersin liiketoiminta

School of Doers on valmennus- ja mentorointiyritys, jonka tarjonta on
kolmiosainen:

1. **Valmennus**
2. **Mentorointi**
3. **Studiotilan vuokraus** (esim. workshoppeja, kuvauksia, koulutustilaisuuksia ja muita tapahtumia varten)

**Ydinkohderyhmä (ICP):** pienet mutta taloudellisesti terveet yritykset —
liikevaihto **vähintään** noin 200 000 € (alaraja, ei kattoraja — "hyvä
liikevaihto" on osa ICP:tä) ja **korkeintaan** noin 10 työntekijää. Tyypillisiä
esimerkkejä: pienet tilitoimistot, asiantuntijayrittäjät (usein alkujaan
yksinyrittäjiä jotka ovat kasvaneet muutaman hengen tiimiksi), ja pienet
henkilöstövuokrausyritykset. Päättäjä on käytännössä lähes aina yrityksen
omistaja itse.

## Ristiinmyynti AerWorkin kanssa

School of Doers ja AerWork ovat eri yritykset/brändit — Sales-agentti ei
koskaan sekoita niitä. Niillä on kuitenkin sama omistaja, joten olemassa
oleva AerWork-yhteys/-kiinnostus liidillä on hyödyllinen lämmin avaus
School of Doersin ensiviestiin (mutta ei suora pisteytyksen kiinnostus-
signaali). Tämä sääntö on kirjattu pysyvästi Sales-tiimin system-promptiin.

## Rakenne (oma Netlify-sivusto)

Tämä `school-of-doers/`-kansio on **itsenäinen Netlify-sivusto**, jolla on
oma `netlify.toml` ja `package.json` — sitä EI enää deployata osana
juuriprojektin (AerWork:in) sivustoa.

- `school-of-doers/index.html` — chat-käyttöliittymä. Yläpalkin
  välilehdet (`Sales` / `Marketing` / `Social media`) vaihtavat aktiivista
  tiimiä; jokaisella tiimillä on oma keskusteluhistoria selaimen muistissa.
- `school-of-doers/netlify.toml` — tämän sivuston oma build-konfiguraatio
  (`functions = "netlify/functions"`, `publish = "."`, molemmat suhteessa
  tähän kansioon).
- `school-of-doers/package.json` — tämän sivuston omat riippuvuudet
  (`@netlify/blobs`).
- `school-of-doers/netlify/functions/chat-background.js` — yksi
  taustafunktio kaikille kolmelle tiimille. `TEAMS`-olio sisältää jokaisen
  tiimin system-promptin, käytettävissä olevat työkalut ja pysyvän
  tallentimen (Blobs-store) nimen. Uuden tiimin lisääminen = uusi avain
  `TEAMS`-oliossa, ei uutta tiedostoa.
- `school-of-doers/netlify/functions/chat-status.js` — kevyt pollausfunktio,
  jota frontend kutsuu kunnes taustafunktio on kirjoittanut vastauksen
  valmiiksi.

## Julkaisu Netlifyyn

Netlify-sivusto luodaan tämän repon `school-of-doers/`-kansiosta base
directorynä (Site settings → Build & deploy → "Base directory":
`school-of-doers`, tai jos deployataan CLI:llä, `netlify deploy` ajetaan
tästä kansiosta käsin).

## Tiimit ja niiden työkalut

| Tiimi | Tehtävä | Työkalut | Pysyvä tallennin |
|---|---|---|---|
| Sales | Liidipisteytys ICP:n mukaan (tilitoimistot/asiantuntijayrittäjät/henkilöstövuokraus, liikevaihto ≥~200k€ ja korkeintaan ~10 työntekijää), taustatutkimus, ensiviestit, vastausten tulkinta, tapaamisehdotus | `web_search`, `prh_lookup` (suomalaiset yritykset), `crm_db` | `sod-sales-leads` |
| Marketing | Kampanjabrief (valmennus/mentorointi/studiotila), markkinatutkimus, kampanjasuunnitelma, seuranta | `web_search`, `campaign_db` | `sod-marketing-campaigns` |
| Social media | Postausideat, caption-luonnokset, trendit, sisältökalenteri | `web_search`, `content_calendar_db` | `sod-social-calendar` |

Jokainen tallennin toimii samalla `action: "get"` / `action: "save"`
-periaatteella kuin AerWorkin `leads_db`: `save` korvaa aina koko listan,
joten agentti hakee ensin nykyisen listan ennen päivitystä.

## Ympäristömuuttujat

Nämä asetetaan **tämän uuden School of Doers -sivuston** omiin Netlify-
ympäristömuuttujiin (Project configuration → Environment variables), ei
AerWork-sivuston muuttujiin:

- `ANTHROPIC_API_KEY` — pakollinen.
- `SOD_BLOBS_SITE_ID` / `SOD_BLOBS_TOKEN` — valinnainen, tarvitaan vain jos
  Netlify Blobsin automaattinen kontekstin tunnistus ei toimisi tuotannossa
  (sama korjaus kuin AerWork-agentin funktioissa, ks. koodikommentit).

## Jatkokehitys / testaus tehty

- Kolmen tiimin system-prompti + työkalusetti on testattu erikseen
  (jokainen reitittyy oikeaan tiimikonfiguraatioon, tuntematon `team`-arvo
  ei kaadu vaan palautuu turvallisesti `sales`-tiimiin).
- `tool_use`-kierros (esim. `crm_db` `get`/`save`) on testattu päästä
  päähän taustafunktion ja pollausfunktion läpi.
- System-promptit ovat ensimmäinen versio (v1) — samaan tapaan kuin
  AerWork-agentin promptissa on kertynyt ajan myötä opittuja poikkeuksia
  ja tarkennuksia, näitäkin kannattaa täsmentää käytön perusteella (esim.
  School of Doersin todelliset kohderyhmät, tunnetut liidit/kampanjat,
  brändin äänensävy).
