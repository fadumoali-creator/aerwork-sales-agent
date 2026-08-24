// Siirtää yrityksen omistajuuden Certified Partnerilta toiselle.
// Vain AerWork Super Admin saa tehdä tämän. Tehdään service-rolella, koska
// RLS:n companies_update-policy ei anna kirjoittaa owning_partner_id:tä
// toisen partnerin arvoksi (with check owning_partner_id = current_org_id())
// — tarkoituksella, jotta partnerit eivät voi "siirtää" toistensa asiakkaita.
// Tämä funktio on ainoa hyväksytty reitti siirtoon, ja se kirjaa aina rivin
// ownership_transfer_log-tauluun sekä audit_log-tauluun.

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

  const { company_id, to_partner_id, reason } = payload;
  if (!company_id || !to_partner_id) {
    return json(400, { error: 'company_id ja to_partner_id ovat pakollisia.' });
  }

  let caller;
  try {
    caller = await getCallerProfile(event);
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
  if (!caller) {
    return json(401, { error: 'Kirjautuminen vaaditaan.' });
  }
  if (caller.role !== 'super_admin') {
    return json(403, { error: 'Vain AerWork Super Admin voi siirtää asiakkuuden omistajuuden.' });
  }

  const admin = adminClient();

  try {
    const { data: company, error: fetchErr } = await admin
      .from('companies')
      .select('id, owning_partner_id, name')
      .eq('id', company_id)
      .single();
    if (fetchErr || !company) {
      return json(404, { error: 'Yritystä ei löytynyt.' });
    }

    const { data: targetOrg, error: orgErr } = await admin
      .from('organizations')
      .select('id, type')
      .eq('id', to_partner_id)
      .single();
    if (orgErr || !targetOrg) {
      return json(404, { error: 'Kohdeorganisaatiota ei löytynyt.' });
    }

    const fromPartnerId = company.owning_partner_id;

    const { error: updateErr } = await admin
      .from('companies')
      .update({ owning_partner_id: to_partner_id, updated_at: new Date().toISOString() })
      .eq('id', company_id);
    if (updateErr) {
      return json(500, { error: `Siirto epäonnistui: ${updateErr.message}` });
    }

    await admin.from('ownership_transfer_log').insert({
      company_id,
      from_partner_id: fromPartnerId,
      to_partner_id,
      moved_by: caller.id,
      reason: reason || null
    });

    await admin.from('audit_log').insert({
      table_name: 'companies',
      record_id: company_id,
      action: 'update',
      field_name: 'owning_partner_id',
      old_value: fromPartnerId,
      new_value: to_partner_id,
      changed_by: caller.id,
      partner_id: to_partner_id
    });

    return json(200, { ok: true, company_id, from_partner_id: fromPartnerId, to_partner_id });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};
