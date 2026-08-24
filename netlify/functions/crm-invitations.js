// Kutsujen hallinta: listaus (+ tilan lazy-synkronointi), uudelleenlähetys,
// peruminen. action-parametrilla ohjattu yhteen funktioon (vähentää
// Netlify-funktioiden määrää, sama kokonaisuus loogisesti).

const { adminClient, getCallerProfile, json } = require('./_crm-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Vain POST-pyynnöt sallittu.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Virheellinen pyyntö.' }); }
  const { action } = payload;

  let caller;
  try { caller = await getCallerProfile(event); } catch (err) { return json(500, { error: String((err && err.message) || err) }); }
  if (!caller) return json(401, { error: 'Kirjautuminen vaaditaan.' });
  if (!['super_admin', 'partner_admin', 'owner_super_admin'].includes(caller.role)) {
    return json(403, { error: 'Sinulla ei ole oikeutta hallita kutsuja.' });
  }

  const admin = adminClient();

  if (action === 'list') {
    let query = admin.from('invitations').select('*').order('created_at', { ascending: false });
    if (caller.role === 'partner_admin') query = query.eq('organization_id', caller.organization_id);
    const { data: invites, error } = await query;
    if (error) return json(500, { error: error.message });

    // Lazy-synkronointi: jokaiselle vielä 'pending'-tilaiselle kutsulle
    // tarkistetaan onko henkilö oikeasti kirjautunut sisään (last_sign_in_at)
    // - meillä ei ole webhookkia joka päivittäisi tämän reaaliajassa, joten
    // tila päätellään aina kun lista haetaan. Sama ajo merkitsee myös
    // vanhentuneet kutsut.
    const now = new Date();
    const updates = [];
    for (const inv of invites || []) {
      if (inv.status !== 'pending') continue;
      if (new Date(inv.expires_at) < now) {
        updates.push(admin.from('invitations').update({ status: 'expired' }).eq('id', inv.id));
        inv.status = 'expired';
        continue;
      }
      if (inv.auth_user_id) {
        const { data: authUser } = await admin.auth.admin.getUserById(inv.auth_user_id);
        if (authUser && authUser.user && authUser.user.last_sign_in_at) {
          updates.push(admin.from('invitations').update({ status: 'accepted', accepted_at: authUser.user.last_sign_in_at }).eq('id', inv.id));
          inv.status = 'accepted';
          inv.accepted_at = authUser.user.last_sign_in_at;
        }
      }
    }
    if (updates.length) await Promise.all(updates);

    return json(200, { invitations: invites || [] });
  }

  if (action === 'resend' || action === 'revoke') {
    const { invitation_id } = payload;
    if (!invitation_id) return json(400, { error: 'invitation_id vaaditaan.' });

    const { data: inv, error: invErr } = await admin.from('invitations').select('*').eq('id', invitation_id).single();
    if (invErr || !inv) return json(404, { error: 'Kutsua ei löytynyt.' });
    if (caller.role === 'partner_admin' && inv.organization_id !== caller.organization_id) {
      return json(403, { error: 'Et voi hallita toisen organisaation kutsuja.' });
    }
    if (!['pending', 'expired'].includes(inv.status)) {
      return json(409, { error: `Kutsu on jo tilassa "${inv.status}" - ei voi enää muokata.` });
    }

    // Sama mekanismi kummallekin: poistetaan vahvistamaton auth-käyttäjä
    // (kaataa mukana profiles-rivin FK-kaskadilla, ks. 0001_crm_schema.sql:
    // profiles.id references auth.users(id) on delete cascade) - Supabasen
    // inviteUserByEmail ei suostu kutsumaan samaa sähköpostia kahdesti niin
    // kauan kuin vanha vahvistamaton tili on olemassa, joten uudelleenkutsu
    // vaatii ensin vanhan siivoamisen. Tämä mitätöi automaattisesti myös
    // aiemman kutsulinkin (se osoitti poistettuun käyttäjään).
    if (inv.auth_user_id) {
      const { error: delErr } = await admin.auth.admin.deleteUser(inv.auth_user_id);
      if (delErr && delErr.status !== 404) {
        return json(502, { error: `Vanhan kutsutilin siivous epäonnistui: ${delErr.message}` });
      }
    }

    if (action === 'revoke') {
      await admin.from('invitations').update({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: caller.id, auth_user_id: null }).eq('id', inv.id);
      return json(200, { ok: true, status: 'revoked' });
    }

    // resend
    const { data: invited, error: sendErr } = await admin.auth.admin.inviteUserByEmail(inv.email, {
      data: { name: `${inv.first_name} ${inv.last_name}`, first_name: inv.first_name, last_name: inv.last_name }
    });
    if (sendErr) {
      await admin.from('invitations').update({ last_send_error: sendErr.message, auth_user_id: null }).eq('id', inv.id);
      return json(502, { error: `Uudelleenlähetys epäonnistui: ${sendErr.message}` });
    }
    const { error: profileErr } = await admin.from('profiles').insert({
      id: invited.user.id, organization_id: inv.organization_id, email: inv.email,
      name: `${inv.first_name} ${inv.last_name}`, role: inv.role, invited_by: caller.id
    });
    if (profileErr) return json(500, { error: `Sähköposti lähti, mutta profiilin luonti epäonnistui: ${profileErr.message}` });

    await admin.from('invitations').update({
      status: 'pending', auth_user_id: invited.user.id, expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      resend_count: inv.resend_count + 1, last_sent_at: new Date().toISOString(), last_send_error: null,
      accepted_at: null, revoked_at: null, revoked_by: null
    }).eq('id', inv.id);
    return json(200, { ok: true, status: 'pending' });
  }

  return json(400, { error: 'Tuntematon action.' });
};
