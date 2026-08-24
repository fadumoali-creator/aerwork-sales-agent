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
async function getCallerProfile(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const admin = adminClient();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) return null;

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, organization_id, role, active')
    .eq('id', userData.user.id)
    .single();
  if (profileErr || !profile || !profile.active) return null;

  return profile;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

module.exports = { adminClient, getCallerProfile, json };
