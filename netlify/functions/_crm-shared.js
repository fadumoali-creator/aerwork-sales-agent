// Jaettu apuri CRM:n etuoikeutetuille (service-role) Netlify-funktioille.
// Näitä funktioita tarvitaan VAIN toimintoihin joita ei voi/pidä tehdä
// suoraan clientistä RLS:n läpi — esim. käyttäjätilin luonti (Supabase Auth
// admin-rajapinta) tai omistajuuden siirto partnerilta toiselle (koskee
// riviä jonka kirjoitusoikeus ei RLS:ssä ulotu toiseen partneriin asti).
//
// TÄRKEÄÄ: service role -avain ohittaa KAIKKI RLS-policyt. Siksi jokainen
// tätä käyttävä funktio TARKISTAA ensin kutsujan identiteetin ja roolin
// hänen omalla access tokenillaan ennen kuin tekee mitään service-rolella.

const { createClient } = require('@supabase/supabase-js');

function getEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL tai SUPABASE_SERVICE_ROLE_KEY puuttuu Netlifyn ympäristömuuttujista. Lisää ne Project configuration → Environment variables.'
    );
  }
  return { url, serviceKey };
}

function adminClient() {
  const { url, serviceKey } = getEnv();
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

// Palauttaa kutsujan profiilin (id, organization_id, role) hänen omasta
// Authorization: Bearer <token> -headeristaan, TAI null jos token on
// virheellinen/vanhentunut. Tämä on ainoa tapa selvittää "kuka soittaa",
// service role -avain itsessään EI kerro mitään kutsujasta.
//
// VÄLIAIKAINEN DIAGNOSTIIKKA (poista kun crm-invite-user-bugi on jäljitetty):
// getCallerProfile.lastReason kertoo TARKALLEEN missä kohtaa tunnistus
// kaatui, jotta 401-vastauksessa voidaan näyttää syy sen sijaan että
// arvaillaan. Ei sisällä tokenia eikä muuta salaista.
async function getCallerProfile(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    getCallerProfile.lastReason = 'Authorization-header puuttuu kokonaan tai on tyhjä.';
    return null;
  }

  let admin;
  try {
    admin = adminClient();
  } catch (err) {
    getCallerProfile.lastReason = `adminClient()-alustus epäonnistui: ${String((err && err.message) || err)}`;
    return null;
  }

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    getCallerProfile.lastReason = `admin.auth.getUser(token) epäonnistui: ${userErr ? userErr.message : 'ei käyttäjää palautettu'}`;
    return null;
  }

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, organization_id, role, active')
    .eq('id', userData.user.id)
    .single();
  if (profileErr || !profile) {
    getCallerProfile.lastReason = `profiles-haku epäonnistui käyttäjälle ${userData.user.id}: ${profileErr ? profileErr.message : 'ei riviä'}`;
    return null;
  }
  if (!profile.active) {
    getCallerProfile.lastReason = `profiili löytyi (${profile.email || profile.id}) mutta active=false.`;
    return null;
  }

  return profile;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

module.exports = { adminClient, getCallerProfile, json };
