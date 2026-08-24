// Kutsuu uuden käyttäjän CRM:ään. Seuraavaa mallia noudatetaan:
//  1. Luodaan invitations-rivi (status='pending', vanhenee 7 vrk) - seurantaa
//     ja kaksoiskutsujen estoa varten.
//  2. Lähetetään OIKEA sähköposti Supabase Authin inviteUserByEmail-
//     rajapinnalla (turvallinen, kertakäyttöinen, vanheneva linkki - EI
//     rakenneta omaa rinnakkaista token-järjestelmää, Auth hoitaa sen jo).
//  3. Luodaan profiles-rivi HETI (nykyinen arkkitehtuuri vaatii tämän: koko
//     sovellus - afterLogin() - olettaa profiles-rivin olevan olemassa heti
//     kun käyttäjä kirjautuu, eikä meillä ole webhookkia joka loisi sen vasta
//     kutsun hyväksynnän yhteydessä). "Hyväksytty"-tila (kohta invitations.
//     status='accepted') päätellään JÄLKIKÄTEEN tarkistamalla onko käyttäjä
//     oikeasti kirjautunut sisään (ks. crm-invitations.js: action=list).
//
// Jos sähköpostin lähetys epäonnistuu, EI näytetä onnistumista eikä luoda
// profiles-riviä - invitations-rivi jää talteen last_send_error-kentän kanssa
// jotta ylläpitäjä näkee mikä meni pieleen ja voi yrittää uudelleen.

const { adminClient, getCallerProfile, json, isOwnerAllowlisted, canManageRole } = require('./_crm-shared');

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

  const first_name = String(payload.first_name || '').trim();
  const last_name = String(payload.last_name || '').trim();
  const email = String(payload.email || '').trim();
  const emailNorm = email.toLowerCase();
  const role = payload.role;
  const organization_id = payload.organization_id;
  const phone = payload.phone ? String(payload.phone).trim() : null;
  const team = payload.team ? String(payload.team).trim() : null;
  const message = payload.message ? String(payload.message).trim() : null;

  if (!first_name || !last_name || !email || !role || !organization_id) {
    return json(400, { error: 'Etunimi, sukunimi, sähköposti, organisaatio ja rooli ovat pakollisia.' });
  }
  if (!['super_admin', 'partner_admin', 'partner_user', 'read_only'].includes(role)) {
    return json(400, {
      error: role === 'owner_super_admin'
        ? 'Omistaja/pääylläpitäjä-roolia ei voi myöntää kutsulla - se vaatii erillisen manuaalisen lisäyksen owner_allowlist-tauluun.'
        : 'Tuntematon rooli.'
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Virheellinen sähköpostiosoite.' });
  }

  let caller;
  try {
    caller = await getCallerProfile(event);
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
  if (!caller) return json(401, { error: 'Kirjautuminen vaaditaan.' });

  const admin = adminClient();
  const callerIsOwner = caller.role === 'owner_super_admin' && (await isOwnerAllowlisted(admin, caller.id));

  if (!canManageRole(caller.role, callerIsOwner, role)) {
    return json(403, { error: 'Et voi myöntää tätä roolia - se on omaa rooliasi korkeampi tai muuten rajoitettu.' });
  }
  if (!callerIsOwner && caller.role !== 'super_admin' && organization_id !== caller.organization_id) {
    return json(403, { error: 'Et voi kutsua käyttäjiä toiseen organisaatioon.' });
  }

  // Duplikaattitarkistus: normalisoitu sähköposti (kohta 9 - "sähköpostiosoite
  // normalisoidaan ennen duplikaattitarkistusta").
  const { data: existingProfile } = await admin.from('profiles').select('id').ilike('email', emailNorm).maybeSingle();
  if (existingProfile) {
    return json(409, { error: 'Tällä sähköpostiosoitteella on jo käyttäjätili.' });
  }
  const { data: existingInvite } = await admin
    .from('invitations').select('id').eq('email_norm', emailNorm).eq('organization_id', organization_id).eq('status', 'pending').maybeSingle();
  if (existingInvite) {
    return json(409, { error: 'Tälle sähköpostiosoitteelle on jo avoin kutsu tähän organisaatioon. Lähetä se uudelleen sen sijaan että luot uuden.' });
  }

  const { data: invitation, error: inviteRowErr } = await admin.from('invitations').insert({
    email, first_name, last_name, organization_id, role, phone, team, message, invited_by: caller.id
  }).select().single();
  if (inviteRowErr) {
    return json(500, { error: `Kutsun luonti epäonnistui: ${inviteRowErr.message}` });
  }

  const { data: invited, error: sendErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { name: `${first_name} ${last_name}`, first_name, last_name }
  });

  if (sendErr) {
    // EI merkitä onnistuneeksi eikä luoda profiilia - kutsu jää nähtäväksi
    // virheineen "Odottavat kutsut" -välilehdelle, ylläpitäjä voi yrittää uudelleen.
    await admin.from('invitations').update({ last_send_error: sendErr.message }).eq('id', invitation.id);
    return json(502, { error: `Kutsusähköpostin lähetys epäonnistui: ${sendErr.message}. Kutsua ei merkitty lähetetyksi.` });
  }

  const newUserId = invited.user.id;
  const { error: profileErr } = await admin.from('profiles').insert({
    id: newUserId, organization_id, email, name: `${first_name} ${last_name}`, role, invited_by: caller.id
  });
  if (profileErr) {
    return json(500, { error: `Sähköposti lähti, mutta käyttäjäprofiilin luonti epäonnistui: ${profileErr.message}. Ota yhteyttä ylläpitoon.` });
  }

  await admin.from('invitations').update({ auth_user_id: newUserId, last_send_error: null }).eq('id', invitation.id);

  return json(200, { ok: true, invitation_id: invitation.id, user_id: newUserId, email, role, organization_id });
};
