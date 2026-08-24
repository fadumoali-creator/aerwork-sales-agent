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
  // PRH/YTJ v3 tukee hakua kaupungin/paikkakunnan mukaan omalla
  // "location"-parametrillaan (ei nimihakua) - tämä mahdollistaa oikean
  // "etsi yritykset tietystä kaupungista" -haun eikä vain nimihaun
  // jälkikäteissuodatusta. locations voi sisältää useamman kaupungin
  // (OR-haku: jokaiselle tehdään oma PRH-kutsu ja tulokset yhdistetään).
  const locations = Array.isArray(payload.locations)
    ? payload.locations.map((l) => String(l || '').trim()).filter(Boolean)
    : (payload.location ? [String(payload.location).trim()].filter(Boolean) : []);

  if (!name && !business_id && !locations.length) {
    return json(400, { error: 'name, business_id tai kaupunki (location) vaaditaan.' });
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

  // Tuotannossa havaittiin: PRH:n "location" ei suodata luotettavasti
  // yhdistettynä name/businessId-hakuun (yhdistetty haku palautti joko
  // vääriä kaupunkeja tai nollasi tulokset kokonaan). Siksi location(t)
  // lähetetään PRH:lle VAIN kun haetaan pelkällä kaupungilla, ilman
  // nimeä/Y-tunnusta. Jos nimi/Y-tunnus on annettu, haetaan sillä
  // normaalisti ja kaupunki suodatetaan luotettavasti client-puolella
  // (ks. crm/app.js: addressMatchesAnyCity) - PRH:n palauttama osoitedata
  // on tarkkaa, vain sen oma location-hakuparametri ei ole.
  const searchLocations = (business_id || name) ? [] : locations;
  const baseParams = () => {
    const p = new URLSearchParams();
    if (business_id) p.set('businessId', String(business_id));
    if (name) p.set('name', String(name));
    p.set('maxResults', String(searchLocations.length > 1 ? 15 : 20));
    return p;
  };

  let results = [];
  let succeeded = true;
  let errorMessage = null;

  try {
    if (searchLocations.length) {
      // Yksi PRH-kutsu per kaupunki (OR-haku), tulokset yhdistetään ja
      // duplikaatit poistetaan Y-tunnuksen perusteella.
      const perLocation = await Promise.all(searchLocations.map(async (loc) => {
        const p = baseParams();
        p.set('location', loc);
        const resp = await fetch(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?${p.toString()}`, {
          headers: { Accept: 'application/json' }
        });
        if (!resp.ok) throw new Error(`PRH-haku epäonnistui kaupungille "${loc}" (HTTP ${resp.status}).`);
        const data = await resp.json();
        return Array.isArray(data.companies) ? data.companies : [];
      }));
      const seen = new Set();
      results = perLocation.flat().filter((c) => {
        const bid = c.businessId ? c.businessId.value : null;
        const key = bid || JSON.stringify(c);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } else {
      const resp = await fetch(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?${baseParams().toString()}`, {
        headers: { Accept: 'application/json' }
      });
      if (!resp.ok) throw new Error(`PRH-haku epäonnistui (HTTP ${resp.status}).`);
      const data = await resp.json();
      results = Array.isArray(data.companies) ? data.companies : [];
    }
  } catch (err) {
    succeeded = false;
    errorMessage = String((err && err.message) || err);
  }

  const requestSummaryParts = [];
  if (name) requestSummaryParts.push(`name=${name}`);
  if (business_id) requestSummaryParts.push(`business_id=${business_id}`);
  if (searchLocations.length) requestSummaryParts.push(`location=${searchLocations.join('|')}`);

  await admin.from('integration_usage_log').insert({
    data_source_key: 'prh_ytj',
    action: 'search',
    requested_by: caller.id,
    request_summary: requestSummaryParts.join(' '),
    result_count: results.length,
    succeeded,
    error_message: errorMessage
  });

  await admin.from('audit_log').insert({
    table_name: 'external_company_records',
    record_id: '00000000-0000-0000-0000-000000000000',
    action: 'search',
    field_name: 'prh_ytj',
    new_value: requestSummaryParts.join(' ') || null,
    changed_by: caller.id,
    partner_id: null
  });

  if (!succeeded) {
    return json(502, { error: errorMessage, results: [] });
  }

  const mapped = results.map((c) => ({
    name: c.names && c.names[0] ? c.names[0].name : null,
    business_id: c.businessId ? c.businessId.value : null,
    company_form: c.companyForms && c.companyForms[0] ? c.companyForms[0].type : null,
    registration_date: c.registrationDate || null,
    main_business_line: c.mainBusinessLine ? c.mainBusinessLine.type : null,
    addresses: c.addresses || [],
    raw: c
  }));

  // Rikastetaan JOKAINEN tulos tiedolla onko yritys jo CRM:ssä (Y-tunnuksen
  // perusteella, ei paljasta omistavan partnerin nimeä täällä - sama
  // luottamuksellisuusperiaate kuin fn_check_company_duplicate) sekä jo
  // mahdollisesti löydetyllä päättäjällä. Ei koskaan keksitä liikevaihtoa/
  // kasvua - niitä ei ole vielä saatavilla ilman maksullista lähdettä
  // (ks. data_sources: financial_data = requires_paid_source).
  const businessIds = mapped.map((m) => m.business_id).filter(Boolean);
  let existingCompanies = [];
  if (businessIds.length) {
    const { data } = await admin.from('companies').select('id, business_id, status_id, archived_at').in('business_id', businessIds).is('archived_at', null);
    existingCompanies = data || [];
  }
  const companyIds = existingCompanies.map((c) => c.id);
  let topDecisionMakers = {};
  if (companyIds.length) {
    const { data: dms } = await admin.from('decision_makers').select('*').in('company_id', companyIds).order('found_at', { ascending: false });
    (dms || []).forEach((d) => {
      if (!topDecisionMakers[d.company_id]) topDecisionMakers[d.company_id] = d; // uusin per yritys, riittää kortille
    });
  }

  const enriched = mapped.map((m) => {
    const existing = existingCompanies.find((c) => c.business_id === m.business_id);
    return {
      ...m,
      in_crm: !!existing,
      existing_company_id: existing ? existing.id : null,
      financial: { available: false, reason: 'requires_paid_source' }, // rehellinen tila - ei keksitä lukuja
      decision_maker: existing && topDecisionMakers[existing.id] ? topDecisionMakers[existing.id] : null
    };
  });

  return json(200, {
    results: enriched,
    source: 'prh_ytj',
    confidence: 'virallinen_rekisteri',
    fetched_at: new Date().toISOString()
  });
};
