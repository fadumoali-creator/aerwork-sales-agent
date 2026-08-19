# School of Doers — Tiimiagentit (Sales / Marketing / Social media)

Kolme chat-agenttia School of Doersin kolmelle tiimille. **School of Doers on
oma, itsenäinen yrityksensä — eri yritys kuin AerWork.** Tekninen perusta
(job-polling-malli Netlify Background Functionilla) on lainattu juuriprojektin
AerWork-agentilta, mutta liiketoiminta, kohderyhmä ja system-promptit ovat
täysin omansa. Kaikki kolme tiimiä jakavat yhden taustafunktion kolmen
erillisen tiedoston sijaan.

## School of Doersin liiketoiminta

School of Doers on valmennus- ja mentorointiyritys, jonka tarjonta on
kolmiosainen:

1. **Valmennus**
2. **Mentorointi**
3. **Studiotilan vuokraus** (esim. workshoppeja, kuvauksia, koulutustilaisuuksia ja muita tapahtumia varten)

**Ydinkohderyhmä (ICP):** pienet, tyypillisesti alle 200 000 € liikevaihdon
yritykset — pienet tilitoimistot, asiantuntijayrittäjät (yksinyrittäjät ja
pienet asiantuntijaorganisaatiot), ja pienet henkilöstövuokrausyritykset.
Päättäjä on käytännössä lähes aina yrityksen omistaja itse.

## Rakenne

- `school-of-doers/index.html` — chat-käyttöliittymä. Yläpalkin
  välilehdet (`Sales` / `Marketing` / `Social media`) vaihtavat aktiivista
  tiimiä; jokaisella tiimillä on oma keskusteluhistoria selaimen muistissa.
- `netlify/functions/sod-chat-background.js` — yksi taustafunktio kaikille
  kolmelle tiimille. `TEAMS`-olio sisältää jokaisen tiimin system-promptin,
  käytettävissä olevat työkalut ja pysyvän tallentimen (Blobs-store) nimen.
  Uuden tiimin lisääminen = uusi avain `TEAMS`-oliossa, ei uutta tiedostoa.
- `netlify/functions/sod-chat-status.js` — kevyt pollausfunktio, jota
  frontend kutsuu kunnes taustafunktio on kirjoittanut vastauksen valmiiksi.

Funktiot ovat samassa `netlify/functions/`-kansiossa kuin juuriprojektin
AerWork-funktiot (`sod-`-etuliite erottaa ne), koska koko repo on yhtä
Netlify-sivustoa (`netlify.toml`: `functions = "netlify/functions"`,
`publish = "."`). Sivu on siis tuotannossa osoitteessa `/school-of-doers/`.

## Tiimit ja niiden työkalut

| Tiimi | Tehtävä | Työkalut | Pysyvä tallennin |
|---|---|---|---|
| Sales | Liidipisteytys ICP:n mukaan (tilitoimistot/asiantuntijayrittäjät/henkilöstövuokraus, <200k€ liikevaihto), taustatutkimus, ensiviestit, vastausten tulkinta, tapaamisehdotus | `web_search`, `prh_lookup` (suomalaiset yritykset), `crm_db` | `sod-sales-leads` |
| Marketing | Kampanjabrief (valmennus/mentorointi/studiotila), markkinatutkimus, kampanjasuunnitelma, seuranta | `web_search`, `campaign_db` | `sod-marketing-campaigns` |
| Social media | Postausideat, caption-luonnokset, trendit, sisältökalenteri | `web_search`, `content_calendar_db` | `sod-social-calendar` |

Jokainen tallennin toimii samalla `action: "get"` / `action: "save"`
-periaatteella kuin AerWorkin `leads_db`: `save` korvaa aina koko listan,
joten agentti hakee ensin nykyisen listan ennen päivitystä.

## Ympäristömuuttujat

- `ANTHROPIC_API_KEY` — pakollinen, sama muuttuja kuin juuriprojektin
  agentilla.
- `SOD_BLOBS_SITE_ID` / `SOD_BLOBS_TOKEN` — valinnainen. Jos asetettu,
  käytetään näitä Netlify Blobsin manuaaliseen tunnistukseen (sama korjaus
  kuin `chat-background.js`:ssä, ks. sen kommentit). Jos ei asetettu,
  funktiot käyttävät varalla `AERWORK_BLOBS_SITE_ID` / `AERWORK_BLOBS_TOKEN`
  -arvoja, ja jos niitäkään ei ole, Netlifyn automaattista tunnistusta.

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
