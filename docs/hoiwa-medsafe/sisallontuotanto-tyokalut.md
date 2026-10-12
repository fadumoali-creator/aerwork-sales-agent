# Sisällöntuotannon työkalut — MedSafe

Versio 0.1 · 2026-10-12 · Liittyy: [`tuotesuunnitelma.md`](./tuotesuunnitelma.md) · [`lovable-toteutus.md`](./lovable-toteutus.md)

Suositus työkaluista opetusvideoihin ja materiaalien visuaaliseen laatuun, kun alusta
rakennetaan Lovablella. Hinnat ja ominaisuudet muuttuvat nopeasti — tarkista vendorin omalta
sivulta ennen sitoutumista (§7 lähteet ja epävarmuudet).

---

## 1. Tärkein sääntö ensin: kolme sisältöluokkaa

MedSafen sisältö ei ole markkinointivideota. Se on lääkehoidon ohjeistusta, jonka mukaan joku
antaa lääkkeen oikealle potilaalle. Siksi työkaluvalinta **riippuu sisältöluokasta**, ei
mieltymyksestä.

| Luokka | Esimerkki | AI-generointi | Peruste |
| --- | --- | --- | --- |
| **A. Kerronta ja teoria** | Vastuut ja roolit, turvallisuuskulttuuri, dokumentoinnin periaatteet, poikkeamailmoituksen prosessi | ✅ Sopii hyvin | Puhuva pää tai kertojaääni + grafiikka; ei näytä kliinistä suoritusta |
| **B. Grafiikka ja havainnollistus** | Prosessikaaviot, lääkelaskun välivaiheet, tarkistuslistat, vuokaaviot, moduulikalvot | ✅ Sopii, ja tänne kannattaa laittaa suurin panos | Tästä tulee suurin visuaalinen parannus — ei videosta |
| **C. Kliininen suoritus** | Kädet jakavat lääkettä, ampullin tunnistus, aseptinen järjestys, antotapa, potilaan tunnistus | ❌ **Ei generatiivista videota** | Malli hallusinoi: väärä ampulli, keksitty lääkkeen nimi, väärä aseptinen järjestys, väärä määrä sormia. Oppija, joka kopioi hallusinoidun tekniikan, on potilasturvallisuusriski |

**Luokka C kuvataan oikealla hoitajalla**, kliinisen tarkastajan läsnä ollessa, tai esitetään
tarkastettuna kuvituksena (piirros/3D), jossa jokainen yksityiskohta on hyväksytty. Tämä on sama
vaatimus kuin tuotesuunnitelman kohdat K1 ja K3 — AI ei ohita kliinistä tarkastusta.

### 1.1 Kaksi teknistä sääntöä, jotka säästävät rahaa ja virheitä

**Sääntö 1: numerot eivät koskaan kuulu generoituun kuvaan.**
Annokset, pitoisuudet, infuusionopeudet, aikarajat ja lääkkeiden nimet renderöidään tekstikerroksena
(alusta tai videon overlay), ei generoituina pikseleinä. Generatiiviset mallit kirjoittavat numeroita
epäluotettavasti, ja väärä annos videossa on vakavin mahdollinen sisältövirhe.

**Sääntö 2: kliiniset faktat eivät kuulu polttamalla videoon.**
Kliininen sisältö tarkastetaan ja päivitetään säännöllisin välein (tuotesuunnitelma, K6). Video on
kallis editoida uudelleen. Pidä videossa pysyvä aines (periaatteet, miksi, prosessin logiikka) ja
muuttuva aines (ohjearvot, organisaation käytännöt, lomakkeet) alustan tekstisisällössä, joka
versioidaan `content_versions`issa. Tämä pitää uusintakustannuksen kurissa.

---

## 2. Työkalusuositus tehtävittäin

### 2.1 Opetusvideo, puhuva pää (luokka A)

| Työkalu | Milloin tämä | Huomio |
| --- | --- | --- |
| **Colossyan** (suositus aloitukseen) | Verkkokoulutuskäyttö: haarautuvat skenaariot ja videon sisäiset kysymykset, hinnoittelu valmiina minuutteina | Useimmin mainittu e-learning-sopivuudesta |
| **Synthesia** | Jos asiakas vaatii enterprise-tason compliance-dokumentaatiota ja laajaa avatar-valikoimaa | Kallein volyymissa |
| **HeyGen** | Jos kustannus per minuutti ratkaisee ja tarvitset lokalisointia paljon | Krediittipohjainen; realistiset avatarit kuluttavat enemmän |

**Huomio, joka muuttaa vertailun:** lähes kaikki vertailuartikkelit painottavat SCORM-vientiä.
**MedSafe ei tarvitse SCORMia** — te rakennatte oman alustan, joten tarvitsette vain MP4 + VTT-
tekstitykset ja mahdollisuuden ladata tiedosto ulos. Valitse siis avatarin laadun, kielten ja
minuuttihinnan perusteella, älä SCORMin.

Käyttötapa, joka pitää kustannuksen kurissa: **avatar vain moduulin 1–3 minuutin johdantoon ja
yhteenvetoon.** Varsinainen asia kuljetetaan grafiikalla + kertojaäänellä, joka on halvempi tuottaa
ja paljon halvempi päivittää.

### 2.2 Kertojaääni ja monikielisyys

**ElevenLabs** on käytännössä oletus: tukee sekä malaijia että indonesiaa, ja Dubbing v2 säilyttää
puhujan sävyn ja ajoituksen.

Varaukset, jotka pitää tarkistaa ennen tuotantoa:
- Itsepalvelusivujen latausrajat ovat pieniä (luokkaa 1 min / 50 MB) — moduulipituiset tiedostot
  vaativat oikean suunnitelman; tarkista rajat omalta tililtä.
- Dubbing v2:n API-pääsy oli ilmoitettu tulevaksi, ei heti saatavaksi — jos automatisoit
  lokalisoinnin, varmista API-tilanne.
- **Kliinisten termien käännös tarkastetaan ihmisellä** kohdemaan kliinisen katselmoijan kanssa
  (tuotesuunnitelma K7, M6). Dubbaus ei ole käännöksen hyväksyntä.

### 2.3 Yleinen AI-video (b-roll, abstrakti, intro)

| Työkalu | Rooli |
| --- | --- |
| **Veo 3.1** | Paras oletus: natiivi audio, hyvä promptin noudattaminen, 4K |
| **Kling** | Volyymi ja budjetti |
| **Runway** | Editointi ja kontrolli, ei laatukärki |

**Sora ei ole enää vaihtoehto** — OpenAI ilmoitti maaliskuussa 2026 lopettavansa Soran web- ja
sovelluskokemuksen 26.4.2026 ja API:n 24.9.2026. Älä suunnittele sen varaan.

Käytä näitä vain luokkaan A ja ei-kliiniseen kuvitukseen (sairaalakäytävä, tiimityö, abstrakti
siirtymä). Ei kliiniseen suoritukseen.

### 2.4 Grafiikka, kuvitus ja kalvot (luokka B — tänne suurin panos)

| Työkalu | Rooli |
| --- | --- |
| **Figma** | Sisällön designsysteemi: oppituntipohjat, väri- ja typografiatokenit, ikonit. Sama tokenisto kuin Lovable-sovelluksessa → materiaali ja alusta näyttävät samalta tuotteelta |
| **Canva** | Nopea tuotanto ei-suunnittelijoille (sisältökumppani, kouluttaja) brändipohjien päälle |
| **Adobe Express / Firefly** | Kuvitus ja kuvankäsittely, kun tarvitaan kommersiaalisesti selkeät käyttöoikeudet |
| **Gamma** | Moduulikalvot nopeasti rakenteisesta tekstistä |
| **Unsplash** | Ei-kliiniset valokuvat (ympäristö, ihmiset, tunnelma) |

Visuaalisen laadun suurin yksittäinen tekijä ei ole työkalu vaan **viisi vakiopohjaa**, joita
käytetään joka moduulissa:

1. **Oppituntipohja** — otsikko, yksi pääviesti, kuva/kaavio, tiivistys
2. **Laskuesimerkkipohja** — tehtävä, välivaiheet numeroituna, vastaus yksikköineen, tyyppivirhe
3. **Tarkistuslistapohja** — toiminnot järjestyksessä, kriittiset korostettuna
4. **Prosessikaaviopohja** — vuokaavio yhdellä selkeällä polulla ja poikkeamahaaralla
5. **Poikkeamatapauspohja** — tilanne, havainto, oikea toiminta, kirjaus

Kun nämä viisi ovat olemassa tokeneilla, kaikki uusi sisältö näyttää hyvältä ilman
suunnittelijaa. Ilman niitä mikään AI-työkalu ei pelasta lopputulosta.

**Luottamussignaali:** näytä jokaisessa materiaalissa sisällön versio ja tarkastuspäivä. Se on
terveydenhuollon ammattilaiselle visuaalista laatua tärkeämpi uskottavuustekijä — ja se on jo
tietomallissa (`content_versions.reviewed_at`).

### 2.5 Videon hosting ja tekstitykset

Tämä ei ole tekninen sivuseikka vaan **liiketoimintaehto**: sisältölisenssi on erillinen
ansaintakomponentti (tuotesuunnitelma §9.1, komponentti 3). Jos videot ovat julkisia linkkejä,
lisensointi ei ole valvottavissa.

Vaatimukset: allekirjoitetut, lyhytikäiset katselu-URL:t · ei julkista jakolinkkiä · VTT-tekstitykset
useilla kielillä · adaptiivinen bitrate (heikot yhteydet, tuotesuunnitelma Liite C.1) · katselun
edistymä takaisin alustalle.

| Palvelu | Hinnoittelumalli | Huomio |
| --- | --- | --- |
| **Mux** (suositus) | Per minuutti: tallennus ~$0,0024/min/kk, toimitus ~$0,0008/min, ensimmäiset 100 000 toimitusminuuttia/kk ilmaisia | Ennustettava kustannus per oppija; hyvä API |
| **Cloudflare Stream** | ~$5 / 1 000 tallennettua min/kk, ~$1 / 1 000 toimitettua min | Laskuttaa lähetetyistä segmenteistä — puskuroitu mutta katsomaton video maksaa |
| **Bunny Stream** | Datapohjainen: tallennus ~$0,01/GB/kk, siirto ~$0,005/GB | Halvin volyymissa, mutta kustannus riippuu bitratesta |

**Älä käytä** julkista YouTubea tai Vimeota lisensoituun koulutussisältöön. Tekstitystuesta ei
löytynyt vertailukelpoista tietoa — tarkista kunkin palvelun caption-dokumentaatio itse.

### 2.6 Interaktiiviset potilastapaukset

**Rakenna Lovablella, älä videotyökalulla.** Te omistatte alustan, joten haarautuva tapaus on
React-komponentti, jonka valinnat kirjautuvat `exercise_attempts`iin ja näkyvät oppijan
palautteessa ja kouluttajan näkymässä. Videotyökalun sisäinen interaktiivisuus jää työkalun sisään
eikä tuota arviointidataa.

Videotyökalun interaktiivisuus on silti hyödyllinen matalan kynnyksen kertaukseen moduulin sisällä.

---

## 3. Mitä tämä tarkoittaa tietomallille

Lisää `content_assets`-tauluun jäljitettävyys AI-tuotannosta (promptti P0:n laajennus):

```sql
alter table content_assets
  add column ai_generated boolean not null default false,
  add column generation_tool text,          -- esim. 'colossyan', 'veo-3.1', 'elevenlabs-dubbing-v2'
  add column generation_prompt_ref text,    -- viite tallennettuun promptiin
  add column human_reviewed_by uuid references app_users(id),
  add column human_reviewed_at timestamptz;
```

Sääntö: **`ai_generated = true` -asset ei voi siirtyä julkaistuun sisältöversioon ilman
`human_reviewed_by` ja `human_reviewed_at` -arvoja.** Toteuta triggerillä, samalla periaatteella
kuin muu kliinisen sisällön tarkastus (HK-3).

Tämä on myös myyntiargumentti: asiakas voi kysyä auditoinnissa, mikä sisältö on AI-tuotettua ja
kuka sen on tarkastanut. Vastaus löytyy järjestelmästä.

---

## 4. Suositeltu polku ensimmäiseen moduuliin

| # | Vaihe | Työkalu | Tulos |
| --- | --- | --- | --- |
| 1 | Sisältöskripti moduulille M1–M5 | teksti, kliininen tarkastaja mukana | Hyväksytty käsikirjoitus |
| 2 | Viisi vakiopohjaa tokeneilla | Figma | Designsysteemi, sama kuin Lovable-sovelluksessa |
| 3 | Moduulin kalvot ja kaaviot | Gamma / Canva pohjien päälle | Luokan B sisältö |
| 4 | Kertojaääni englanniksi | ElevenLabs | Audio + VTT |
| 5 | Johdanto- ja yhteenvetovideo (1–3 min) | Colossyan | MP4 + VTT |
| 6 | Kliininen suoritus (näyttöön valmistava) | **kuvaus oikealla hoitajalla** | MP4, kliinisesti tarkastettu |
| 7 | Lokalisointi (malaiji / indonesia) | ElevenLabs dubbing + ihmistarkastus | Kieliversiot |
| 8 | Vienti alustalle | Mux + alustan content studio | Julkaistu sisältöversio |

Vaihe 2 kannattaa tehdä ennen vaihetta 3 — muuten tuotat sisältöä, joka pitää tehdä uudelleen.

---

## 5. Ennen sitoutumista tarkistettavat asiat

| # | Tarkistettava | Miksi |
| --- | --- | --- |
| 1 | Kaupallinen käyttöoikeus myytävässä tuotteessa jokaisen työkalun ehdoista | Myytte sisältöä edelleen asiakkaille; "commercial use" ei aina kata sitä |
| 2 | Avatarin henkilökuvaoikeudet | Stock-avatar, joka esittää hoitajaa, ei saa olla tunnistettavissa oikeaksi henkilöksi ilman oikeuksia |
| 3 | Sisältääkö työkalu syötteesi mallin koulutukseen | Käsikirjoitukset ovat liikesalaisuutta; opt-out tarvitaan |
| 4 | **Ei oikeita potilastietoja mihinkään työkaluun** | Tuotesuunnitelma §1.4: vain kuvitteelliset tiedot |
| 5 | Sisältökumppanin (Metropolia) oikeudet AI-tuotettuun johdannaiseen | Tuotesuunnitelma C1 on vielä avoin |
| 6 | Dubbauksen laadun hyväksyntä kliinisillä termeillä | K7 |
| 7 | Videopalvelun datan sijainti | Sama M1-kysymys kuin Supabasen alue |

---

## 6. Mitä EI kannata ostaa vielä

| Älä | Miksi |
| --- | --- |
| Täyttä LMS-videoalustaa (esim. valmis kurssialusta) | Rakennatte oman alustan; päällekkäinen investointi |
| Enterprise-tason avatar-sopimusta | Volyymi on tuntematon ennen pilottia; aloita pienellä suunnitelmalla |
| Erillistä interaktiivisen videon työkalua | Tapaukset Lovableen (§2.6) |
| SCORM-ominaisuuksia | Ette tarvitse niitä (§2.1) |
| Käännöksiä kolmelle kielelle heti | Julkaise EN ensin, toinen kieli pilottiasiakkaan mukaan |

---

## 7. Lähteet ja epävarmuudet

Luettu 2026-10-12. **Kaikki hinnat ja ominaisuustiedot ovat kolmansien osapuolten
vertailusivuilta ja keskenään osin ristiriitaisia** — tarkista vendorin oma hinnoittelusivu ennen
päätöstä. Erityisesti avatar-työkalujen hinnat esitetään epäyhtenäisesti (vuosi- vs. kuukausilaskutus,
minuutit vs. krediitit).

Avatar- ja videotyökalut:
- [VentureHarbour — AI avatar -vertailu](https://ventureharbour.com/best-ai-avatar-software/)
- [HeyGen vs Synthesia vs Colossyan](https://www.aimagicx.com/blog/heygen-vs-synthesia-vs-colossyan-avatar-comparison-2026)
- [AI avatar -videon kustannusvertailu 2026](https://rinzara.com/articles/ai-avatar-video-cost-comparison-2026)
- [Top 5 avatar-generaattorit 2026](https://guptadeepak.com/tools/top-5-ai-avatar-generators-2026/)

Videogenerointi:
- [AI Video Generation in 2026 — Veo, Kling, Runway ja Soran loppu](https://ocdevel.com/mlg/mla-26)
- [Best AI video generation tools 2026](https://guptadeepak.com/tools/top-5-ai-video-generation-tools-2026/)

Ääni ja dubbaus:
- [ElevenLabs — englanti→malaiji](https://elevenlabs.io/translate-audio/english-to-malay) · [englanti→indonesia](https://elevenlabs.io/translate-audio/english-to-indonesian)
- [ElevenLabs Dubbing v2 -julkaisutieto](https://www.createwith.com/tool/elevenlabs/updates/elevenlabs-launches-dubbing-v2-preserving-tone-and-emotion-across-90-languages)

Videon hosting:
- [Mux vs Cloudflare Stream vs Bunny Stream -kustannuslaskuri](https://apicostcalc.com/mux-vs-cloudflare-stream-vs-bunny-stream-cost-calculator.html)
- [Mux — vertailu Cloudflare Streamiin](https://mux.com/compare/cloudflare-stream)
- [Video CDN -palveluntarjoajat 2026](https://kinescope.com/blog/best-video-cdn-providers-2026)
