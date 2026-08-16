// AerWork LinkedIn Sales Agent — pollausfunktio.
// Kevyt, nopea funktio (ei taustafunktio) jota frontend kutsuu toistuvasti
// ("pollaa") kunnes chat-background.js on kirjoittanut vastauksen valmiiksi
// Netlify Blobsiin. Tämä ratkaisee Netlifyn 10 sekunnin synkronisen
// funktioaikarajan: raskas Anthropic-kutsu (web-haut, PRH-haku ym.) tehdään
// chat-background.js:ssä jolla on aikaa jopa 15 minuuttia, ja tämä funktio
// vain kurkkaa onko tulos jo valmis.

const { getStore } = require('@netlify/blobs');

// Ks. tarkempi selitys chat-background.js:stä: automaattinen Blobs-kontekstin
// tunnistus ei toimi tällä sivustolla tuotannossa, joten käytetään manuaalisia
// tunnisteita jos ne on asetettu ympäristömuuttujina.
//
// KORJAUS (16.8.2026): getStore() @netlify/blobs-paketissa (v8) hyväksyy VAIN
// YHDEN argumentin - joko pelkän nimen (merkkijono) tai yhden olio-argumentin
// { name, siteID, token }. Aiempi kutsutapa getStore(name, {siteID, token})
// välitti toisen argumentin hiljaa huomiotta, joten manuaaliset tunnisteet
// eivät koskaan päätyneet käyttöön - tästä syystä virhe "environment has not
// been configured" jatkui vaikka ympäristömuuttujat olivat oikein asetettu.
function getBlobsStore(name) {
  const siteID = process.env.AERWORK_BLOBS_SITE_ID;
  const token = process.env.AERWORK_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Vain GET-pyynnöt sallittu.' }) };
  }

  const jobId = event.queryStringParameters && event.queryStringParameters.id;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id-parametri puuttuu.' }) };
  }

  try {
    const store = getBlobsStore('aerwork-chat-jobs');
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
      // Taustafunktio ei ole vielä ehtinyt kirjoittaa edes alustavaa "pending"-tilaa
      // (esim. juuri käynnistynyt) — kerrotaan frontendille että odotetaan yhä.
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'pending' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String((err && err.message) || err) })
    };
  }
};
