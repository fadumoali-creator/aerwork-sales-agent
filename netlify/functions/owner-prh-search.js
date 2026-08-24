// Owner Super Admin -yrityshaku PRH/YTJ-avoindatasta.
// Vain owner_super_admin + owner_allowlist (kolmoisportti) saa kutsua tätä.
// Jokainen haku kirjataan integration_usage_log-tauluun (kohta 15: audit log
// kattaa "käytetyt tietolähteet").

const { adminClient, getCallerProfile, json } = require('./_crm-shared');

async function isOwnerAllowlisted(admin, callerId) {
  const { data, error } = await admin
    .from('owner_allowlist')
    .select('id, active')
    .eq('user_id', callerId)
    .eq('active', true)
    .maybeSingle();
  return !error && !!data;
}

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

  const { name, business_id } = payload;
  if (!name && !business_id) {
    return json(400, { error: 'name tai business_id vaaditaan.' });
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

  const admin = adminClient();

  // KOLMOISPORTTI: sessio (yllä) + rooli + allowlist. RLS suojaa datan joka
  // tapauksessa, mutta tarkistetaan myös tässä ETTÄ tämä palvelinfunktio ei
  // tee mitään ei-ownerin puolesta.
  if (caller.role !== 'owner_super_admin' || !(await isOwnerAllowlisted(admin, caller.id))) {
    return json(403, { error: 'Vain hyväksytty AerWork Owner Super Admin voi käyttää tätä hakua.' });
  }

  const params = new URLSearchParams();
  if (business_id) params.set('businessId', String(business_id));
  else params.set('name', String(name));
  params.set('maxResults', '10');

  let results = [];
  let succeeded = true;
  let errorMessage = null;

  try {
    const resp = await fetch(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?${params.toString()}`, {
      headers: { Accept: 'application/json' }
    });
    if (!resp.ok) {
      succeeded = false;
      errorMessage = `PRH-haku epäonnistui (HTTP ${resp.status}).`;
    } else {
      const data = await resp.json();
      results = Array.isArray(data.companies) ? data.companies : [];
    }
  } catch (err) {
    succeeded = false;
    errorMessage = String((err && err.message) || err);
  }

  await admin.from('integration_usage_log').insert({
    data_source_key: 'prh_ytj',
    action: 'search',
    requested_by: caller.id,
    request_summary: business_id ? `business_id=${business_id}` : `name=${name}`,
    result_count: results.length,
    succeeded,
    error_message: errorMessage
  });

  await admin.from('audit_log').insert({
    table_name: 'external_company_records',
    record_id: '00000000-0000-0000-0000-000000000000',
    action: 'search',
    field_name: 'prh_ytj',
    new_value: business_id || name,
    changed_by: caller.id,
    partner_id: null
  });

  if (!succeeded) {
    return json(502, { error: errorMessage, results: [] });
  }

  return json(200, {
    results: results.map((c) => ({
      name: c.names && c.names[0] ? c.names[0].name : null,
      business_id: c.businessId ? c.businessId.value : null,
      company_form: c.companyForms && c.companyForms[0] ? c.companyForms[0].type : null,
      registration_date: c.registrationDate || null,
      main_business_line: c.mainBusinessLine ? c.mainBusinessLine.type : null,
      addresses: c.addresses || [],
      raw: c
    })),
    source: 'prh_ytj',
    confidence: 'virallinen_rekisteri',
    fetched_at: new Date().toISOString()
  });
};
