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
function blobsOpts() {
  const siteID = process.env.AERWORK_BLOBS_SITE_ID;
  const token = process.env.AERWORK_BLOBS_TOKEN;
  return siteID && token ? { siteID, token } : undefined;
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
    const store = getStore('aerwork-chat-jobs', blobsOpts());
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
