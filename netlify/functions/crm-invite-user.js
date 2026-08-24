// Kutsuu uuden käyttäjän CRM:ään (luo Supabase Auth -tunnuksen + profiles-rivin).
// Tämä TÄYTYY tehdä service-rolella koska Supabasen tavallinen client-API ei
// voi luoda toisen käyttäjän auth-tiliä. Oikeustarkistus tehdään manuaalisesti
// tässä funktiossa ennen mitään kirjoitusta:
//   - super_admin saa kutsua kenet tahansa mihin organisaatioon tahansa,
//     millä roolilla tahansa.
//   - partner_admin saa kutsua VAIN omaan organisaatioonsa, VAIN rooleilla
//     partner_user tai read_only (ei partner_admin/super_admin-eskalaatiota).
//   - kaikki muut: evätty.

const { adminClient, getCallerProfile, json } = require('./_crm-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Vain POST-pyynnöt sallittu.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Virheellinen pyyntö.' });
  }

  const { email, name, role, organization_id } = payload;
  if (!email || !name || !role) {
    return json(400, { error: 'email, name ja role ovat pakollisia.' });
  }
  if (!['super_admin', 'partner_admin', 'partner_user', 'read_only'].includes(role)) {
    return json(400, { error: 'Tuntematon rooli.' });
  }

  let caller;
  try {
    caller = await getCallerProfile(event);
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
  if (!caller) {
    // VÄLIAIKAINEN: sisältää tarkan syyn diagnostiikkaa varten, ks. _crm-shared.js.
    return json(401, {
      error: 'Kirjautuminen vaaditaan (virheellinen tai puuttuva Authorization-header).',
      debug_reason: getCallerProfile.lastReason || 'tuntematon (lastReason ei asettunut)'
    });
  }

  const targetOrgId = organization_id || caller.organization_id;

  if (caller.role === 'super_admin') {
    // sallittu mihin tahansa organisaatioon, millä tahansa roolilla
  } else if (caller.role === 'partner_admin') {
    if (targetOrgId !== caller.organization_id) {
      return json(403, { error: 'Et voi kutsua käyttäjiä toiseen organisaatioon.' });
    }
    if (['super_admin', 'partner_admin'].includes(role)) {
      return json(403, { error: 'Et voi myöntää partner_admin- tai super_admin-roolia. Pyydä AerWorkin ylläpitoa.' });
    }
  } else {
    return json(403, { error: 'Sinulla ei ole oikeutta kutsua käyttäjiä.' });
  }

  const admin = adminClient();

  try {
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { name }
    });
    if (inviteErr) {
      return json(400, { error: `Kutsun lähetys epäonnistui: ${inviteErr.message}` });
    }

    const newUserId = invited.user.id;
    const { error: profileErr } = await admin.from('profiles').insert({
      id: newUserId,
      organization_id: targetOrgId,
      email,
      name,
      role,
      invited_by: caller.id
    });
    if (profileErr) {
      return json(500, { error: `Käyttäjätili luotiin, mutta profiilirivin tallennus epäonnistui: ${profileErr.message}` });
    }

    return json(200, { ok: true, user_id: newUserId, email, role, organization_id: targetOrgId });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};
