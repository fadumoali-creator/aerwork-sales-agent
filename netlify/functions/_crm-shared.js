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

// Roolihierarkia käyttäjähallinnan palvelinpuolen tarkistuksiin (peilaa
// supabase/migrations/0008_user_management.sql:n profiles_admin_write-RLS-
// policyn logiikkaa - TÄMÄ EI KORVAA RLS:ää, vain antaa ystävällisemmän
// virheilmoituksen ennen kuin kutsu edes yrittää tietokantaan asti).
const ROLE_RANK = { owner_super_admin: 100, super_admin: 80, partner_admin: 60, partner_user: 40, read_only: 20 };

async function isOwnerAllowlisted(admin, callerId) {
  const { data, error } = await admin.from('owner_allowlist').select('id').eq('user_id', callerId).eq('active', true).maybeSingle();
  return !error && !!data;
}

// Palauttaa true jos "caller" saa hallinnoida (kutsua/muokata roolia/estää/
// poistaa) "targetRole"-roolista käyttäjää. Owner saa kaiken paitsi ei voi
// koskea toiseen omistajaan ilman erillistä varmistusta (käsitellään
// kutsuvassa funktiossa erikseen viimeisen omistajan suojaksi).
function canManageRole(callerRole, callerIsOwner, targetRole) {
  if (callerIsOwner) return true;
  if (targetRole === 'owner_super_admin') return false; // vain omistaja koskee omistajiin
  if (callerRole === 'super_admin') return targetRole !== 'owner_super_admin';
  if (callerRole === 'partner_admin') return ['partner_user', 'read_only'].includes(targetRole);
  return false;
}

module.exports = { adminClient, getCallerProfile, json, ROLE_RANK, isOwnerAllowlisted, canManageRole };
