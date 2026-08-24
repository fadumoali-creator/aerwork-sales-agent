// Owner Super Admin: hae todennäköisin päättäjä yritykselle julkisista
// lähteistä web_search-työkalulla. EI LinkedIn-scrapingia, ei kirjautumista
// mihinkään palveluun - vain Anthropicin web_search-työkalu (sama kuin
// netlify/functions/chat.js käyttää), joka hakee julkisesti indeksoitua
// sisältöä ja palauttaa lähde-URL:t.
//
// Tulos tallennetaan AINA review_status='pending' - Owner hyväksyy/hylkää
// sen itse ennen kuin sitä käytetään myyntikontaktina (vaatimuksen kohta 5).
// Ei koskaan esitetä tulosta varmana faktana.

const { adminClient, getCallerProfile, json } = require('./_crm-shared');

const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';

const DECISION_MAKER_PRIORITY = [
  'toimitusjohtaja / CEO', 'omistaja tai perustaja', 'HR Director / henkilöstöjohtaja',
  'Head of HR / HR Manager', 'COO / operatiivinen johtaja', 'Operations Manager',
  'Payroll Manager / palkkahallinnosta vastaava', 'rekrytointipäällikkö'
];

async function isOwnerAllowlisted(admin, callerId) {
  const { data, error } = await admin.from('owner_allowlist').select('id').eq('user_id', callerId).eq('active', true).maybeSingle();
  return !error && !!data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Vain POST-pyynnöt sallittu.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Virheellinen pyyntö.' }); }
  const { company_id, company_name } = payload;
  if (!company_id || !company_name) return json(400, { error: 'company_id ja company_name vaaditaan.' });

  let caller;
  try { caller = await getCallerProfile(event); } catch (err) { return json(500, { error: String((err && err.message) || err) }); }
  if (!caller) return json(401, { error: 'Kirjautuminen vaaditaan.' });

  const admin = adminClient();
  if (caller.role !== 'owner_super_admin' || !(await isOwnerAllowlisted(admin, caller.id))) {
    return json(403, { error: 'Vain hyväksytty AerWork Owner Super Admin voi käyttää tätä hakua.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'ANTHROPIC_API_KEY puuttuu - päättäjähaku ei ole käytettävissä ilman sitä.' });
  }

  const prompt = `Etsi julkisista lähteistä (yrityksen oma verkkosivu, johtoryhmäsivu, uutiset, muu julkinen ammatillinen lähde - EI LinkedIn-kirjautumista vaativaa sisältöä) suomalaisen yrityksen "${company_name}" todennäköisin B2B-hankinnasta vastaava päättäjä.

Priorisoi tässä järjestyksessä: ${DECISION_MAKER_PRIORITY.join(' > ')}.

Käytä web_search-työkalua tarvittaessa (korkeintaan muutama haku). Kun olet valmis, vastaa VIIMEISENÄ viestinäsi TÄSMÄLLEEN yhdellä \`\`\`json-koodilohkolla tässä muodossa, älä mitään muuta sen jälkeen:
\`\`\`json
{"found": true|false, "name": "...", "title": "...", "source_url": "...", "reasoning": "lyhyt peruste"}
\`\`\`
Jos et löydä mitään riittävän luotettavaa, palauta {"found": false, "reasoning": "miksi ei löytynyt"}. ÄLÄ KOSKAAN keksi nimeä - jos et ole varma, found on false.`;

  let modelText = '';
  let usedSearch = false;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'FI', timezone: 'Europe/Helsinki' } }]
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return json(502, { error: `Anthropic API -virhe (${resp.status}): ${errText.slice(0, 300)}` });
    }
    const data = await resp.json();
    usedSearch = (data.content || []).some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
    modelText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  } catch (err) {
    await admin.from('integration_usage_log').insert({
      data_source_key: 'web_search', action: 'search', company_id, requested_by: caller.id,
      request_summary: `päättäjähaku: ${company_name}`, succeeded: false, error_message: String((err && err.message) || err)
    });
    return json(502, { error: `Haku epäonnistui: ${String((err && err.message) || err)}` });
  }

  const match = modelText.match(/```json\s*([\s\S]*?)```/);
  let parsed;
  try {
    parsed = JSON.parse(match ? match[1] : modelText);
  } catch {
    await admin.from('integration_usage_log').insert({
      data_source_key: 'web_search', action: 'search', company_id, requested_by: caller.id,
      request_summary: `päättäjähaku: ${company_name}`, succeeded: false, error_message: 'Mallin vastausta ei saatu jäsennettyä JSON:ksi.'
    });
    return json(502, { error: 'Haku epäonnistui: vastausta ei saatu jäsennettyä. Ei tallennettu mitään - ei keksitä tietoa.' });
  }

  await admin.from('integration_usage_log').insert({
    data_source_key: 'web_search', action: 'search', company_id, requested_by: caller.id,
    request_summary: `päättäjähaku: ${company_name}`, result_count: parsed.found ? 1 : 0, succeeded: true
  });

  if (!parsed.found || !parsed.name) {
    return json(200, { found: false, reasoning: parsed.reasoning || 'Ei löytynyt riittävän luotettavaa tietoa.' });
  }

  const { data: inserted, error: insertErr } = await admin.from('decision_makers').insert({
    company_id,
    name: parsed.name,
    title: parsed.title || null,
    source: usedSearch ? 'web_search' : 'ai_paattely',
    source_url: parsed.source_url || null,
    confidence: 'ai_paattely', // aina näin automaattihaulle - vasta owner hyväksyy vahvemmaksi
    review_status: 'pending',
    notes: parsed.reasoning || null,
    created_by: caller.id
  }).select().single();

  if (insertErr) return json(500, { error: `Tallennus epäonnistui: ${insertErr.message}` });

  await admin.from('audit_log').insert({
    table_name: 'decision_makers', record_id: inserted.id, action: 'search',
    field_name: 'web_search', new_value: parsed.name, changed_by: caller.id, partner_id: null
  });

  return json(200, { found: true, decision_maker: inserted });
};
