// School of Doers — Tiimiagentit — pollausfunktio.
// Kevyt, nopea funktio (ei taustafunktio) jota frontend kutsuu toistuvasti
// ("pollaa") kunnes sod-chat-background.js on kirjoittanut vastauksen
// valmiiksi Netlify Blobsiin. Yhteinen kaikille kolmelle tiimille — jobId on
// satunnainen UUID per pyyntö, joten tiimien välillä ei voi tulla törmäystä.
// Sama malli kuin netlify/functions/chat-status.js.

const { getStore } = require('@netlify/blobs');

function getBlobsStore(name) {
  const siteID = process.env.SOD_BLOBS_SITE_ID || process.env.AERWORK_BLOBS_SITE_ID;
  const token = process.env.SOD_BLOBS_TOKEN || process.env.AERWORK_BLOBS_TOKEN;
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
    const store = getBlobsStore('sod-chat-jobs');
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
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
