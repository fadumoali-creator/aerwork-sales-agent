// Käyttäjän hallintatoiminnot: roolin vaihto, esto, palautus, poisto
// organisaatiosta (soft), siirto toiseen organisaatioon. action-parametrilla
// ohjattu yhteen funktioon.
//
// HUOM istunnon mitätöinnistä: Supabasen admin-API:ssa ei ole suoraa
// "mitätöi kaikki tämän käyttäjä-id:n istunnot" -kutsua (signOut vaatii
// käyttäjän oman access tokenin, ei user id:tä) - tätä ei siis kutsuta
// tässä, ETTÄ EI ARVATA API:a joka saattaisi epäonnistua hiljaa. Sen sijaan
// suojaus tulee RLS:stä: current_org_id()/app_current_role() palauttavat
// NULL heti kun profiles.active=false (ks. 0008_user_management.sql), joten
// estetyn käyttäjän JWT saattaa teknisesti pysyä voimassa enintään sen
// oletusvoimassaoloajan (tyypillisesti 1h) mutta EI anna pääsyä yhteenkään
// riviin missään taulussa - todennettu paikallisin RLS-testein.

const { adminClient, getCallerProfile, json, isOwnerAllowlisted, canManageRole } = require('./_crm-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Vain POST-pyynnöt sallittu.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Virheellinen pyyntö.' }); }
  const { action, user_id } = payload;
  if (!action || !user_id) return json(400, { error: 'action ja user_id vaaditaan.' });

  let caller;
  try { caller = await getCallerProfile(event); } catch (err) { return json(500, { error: String((err && err.message) || err) }); }
  if (!caller) return json(401, { error: 'Kirjautuminen vaaditaan.' });

  const admin = adminClient();
  const callerIsOwner = caller.role === 'owner_super_admin' && (await isOwnerAllowlisted(admin, caller.id));

  const { data: target, error: targetErr } = await admin.from('profiles').select('*').eq('id', user_id).single();
  if (targetErr || !target) return json(404, { error: 'Käyttäjää ei löytynyt.' });

  if (target.id === caller.id && ['change_role', 'suspend', 'remove'].includes(action)) {
    return json(403, { error: 'Et voi kohdistaa tätä toimintoa itseesi.' });
  }
  if (!callerIsOwner && caller.role !== 'super_admin' && target.organization_id !== caller.organization_id) {
    return json(403, { error: 'Et voi hallita toisen organisaation käyttäjiä.' });
  }
  if (!canManageRole(caller.role, callerIsOwner, target.role)) {
    return json(403, { error: 'Sinulla ei ole oikeutta hallita tämän roolista käyttäjää.' });
  }

  if (action === 'change_role') {
    const { new_role } = payload;
    if (!canManageRole(caller.role, callerIsOwner, new_role)) {
      return json(403, { error: 'Et voi myöntää tätä roolia - se on omaa rooliasi korkeampi tai muuten rajoitettu.' });
    }
    const { error } = await admin.from('profiles').update({ role: new_role }).eq('id', target.id);
    if (error) return json(500, { error: mapDbError(error) });
    return json(200, { ok: true });
  }

  if (action === 'suspend') {
    const { error } = await admin.from('profiles').update({ active: false }).eq('id', target.id);
    if (error) return json(500, { error: mapDbError(error) });
    return json(200, { ok: true });
  }

  if (action === 'reactivate') {
    const { error } = await admin.from('profiles').update({ active: true, removed_at: null, removed_by: null }).eq('id', target.id);
    if (error) return json(500, { error: mapDbError(error) });
    return json(200, { ok: true });
  }

  if (action === 'remove') {
    // Soft delete / membership removal - ei koskaan fyysistä DELETEä, jotta
    // audit_log ja historialliset yritys-/kauppa-/aktiviteettitiedot (jotka
    // viittaavat created_by/responsible_user_id:hen) säilyvät ehjinä.
    const { error } = await admin.from('profiles').update({ active: false, removed_at: new Date().toISOString(), removed_by: caller.id }).eq('id', target.id);
    if (error) return json(500, { error: mapDbError(error) });
    return json(200, { ok: true });
  }

  if (action === 'transfer_org') {
    const { new_organization_id } = payload;
    if (!new_organization_id) return json(400, { error: 'new_organization_id vaaditaan.' });
    if (!callerIsOwner && caller.role !== 'super_admin') {
      return json(403, { error: 'Vain AerWork-ylläpitäjä tai omistaja voi siirtää käyttäjän toiseen organisaatioon.' });
    }
    const { error } = await admin.from('profiles').update({ organization_id: new_organization_id }).eq('id', target.id);
    if (error) return json(500, { error: mapDbError(error) });
    return json(200, { ok: true });
  }

  return json(400, { error: 'Tuntematon action.' });
};

// Postgresin/RLS:n omat virheet (esim. fn_protect_last_owner-triggerin
// RAISE EXCEPTION) ovat jo suomenkielisiä ja ihmisluettavia - näytetään
// sellaisenaan, ei geneeristä "tietokantavirhettä".
function mapDbError(error) {
  return error.message || 'Tietokantavirhe.';
}
