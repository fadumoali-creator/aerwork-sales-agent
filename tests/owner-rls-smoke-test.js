// Owner Super Admin -kolmoisportin RLS-murtotesti oikeaa Supabase-projektia
// vasten. Sama periaate kuin tests/rls-smoke-test.js: kutsutaan Supabasen
// REST/PostgREST-rajapintaa SUORAAN, ohi sovelluksen.
//
// PAKOLLISET ympäristömuuttujat (Certified Partner -tunnukset, negatiiviset testit):
//   SUPABASE_URL, SUPABASE_ANON_KEY
//   TEST_PARTNER_A_EMAIL, TEST_PARTNER_A_PASSWORD
//
// VALINNAISET (positiivinen polku - jos annettu, testataan että oikea owner
// pääsee sisään ja että pelkkä rooli ilman allowlistiä EI riitä):
//   TEST_OWNER_EMAIL, TEST_OWNER_PASSWORD              (rooli owner_super_admin + allowlistillä)
//   TEST_FAKE_OWNER_EMAIL, TEST_FAKE_OWNER_PASSWORD    (rooli owner_super_admin, EI allowlistillä)
//
// Testi EPÄONNISTUU jos Certified Partner näkee YHDENKÄÄN rivin owner-only
// tauluista, tai jos "faker"-tunnus (rooli mutta ei allowlistiä) pääsee sisään.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const OWNER_ONLY_TABLES = [
  'external_company_records', 'decision_makers', 'job_postings',
  'opportunity_scores', 'saved_searches', 'data_sources', 'integration_usage_log'
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Puuttuva ympäristömuuttuja: ${name}. Katso ohjeet tämän tiedoston alusta.`);
    process.exit(2);
  }
  return v;
}

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Kirjautuminen epäonnistui (${email}): ${error.message}`);
  return client;
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

async function main() {
  requireEnv('SUPABASE_URL');
  requireEnv('SUPABASE_ANON_KEY');
  const partnerEmail = requireEnv('TEST_PARTNER_A_EMAIL');
  const partnerPassword = requireEnv('TEST_PARTNER_A_PASSWORD');

  console.log('1) Certified Partner ei saa nähdä YHTÄÄN owner-only-taulun riviä suoralla API-kutsulla:');
  const partnerClient = await signIn(partnerEmail, partnerPassword);
  for (const table of OWNER_ONLY_TABLES) {
    const { data, error } = await partnerClient.from(table).select('*').limit(50);
    check(`${table}: 0 riviä (tai RLS-virhe)`, !!error || !data || data.length === 0);
  }

  console.log('\n2) Certified Partner ei saa KIRJOITTAA owner-only-tauluun:');
  const { error: insertErr } = await partnerClient.from('decision_makers').insert({
    name: 'Hyökkäystesti', company_id: null, source: 'test', confidence: 'vahvistamaton'
  });
  check('decision_makers-insert estetty', !!insertErr);

  console.log('\n3) is_owner_super_admin() palauttaa false Certified Partnerille:');
  const { data: isOwnerPartner } = await partnerClient.rpc('is_owner_super_admin');
  check('is_owner_super_admin() = false partnerille', isOwnerPartner === false);

  if (process.env.TEST_FAKE_OWNER_EMAIL && process.env.TEST_FAKE_OWNER_PASSWORD) {
    console.log('\n4) Rooli owner_super_admin MUTTA ei allowlistillä -> pääsy silti evätty:');
    const fakeClient = await signIn(process.env.TEST_FAKE_OWNER_EMAIL, process.env.TEST_FAKE_OWNER_PASSWORD);
    const { data: isOwnerFake } = await fakeClient.rpc('is_owner_super_admin');
    check('is_owner_super_admin() = false ilman allowlistiä', isOwnerFake === false);
    const { data: fakeData, error: fakeErr } = await fakeClient.from('decision_makers').select('*').limit(1);
    check('Faker ei näe decision_makers-rivejä', !!fakeErr || !fakeData || fakeData.length === 0);
  } else {
    console.warn('\n(Ohitettu vaihe 4: TEST_FAKE_OWNER_EMAIL/PASSWORD ei asetettu.)');
  }

  if (process.env.TEST_OWNER_EMAIL && process.env.TEST_OWNER_PASSWORD) {
    console.log('\n5) Oikea owner (rooli + allowlist) pääsee sisään:');
    const ownerClient = await signIn(process.env.TEST_OWNER_EMAIL, process.env.TEST_OWNER_PASSWORD);
    const { data: isOwner } = await ownerClient.rpc('is_owner_super_admin');
    check('is_owner_super_admin() = true oikealle ownerille', isOwner === true);
    const { data: dataSources, error: dsErr } = await ownerClient.from('data_sources').select('*');
    check('Owner näkee data_sources-rivit', !dsErr && Array.isArray(dataSources) && dataSources.length > 0);
  } else {
    console.warn('\n(Ohitettu vaihe 5: TEST_OWNER_EMAIL/PASSWORD ei asetettu.)');
  }

  console.log(`\n${failures === 0 ? '✅ Kaikki Owner Super Admin -eristystestit läpäisty.' : `❌ ${failures} testiä epäonnistui!`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Testi kaatui virheeseen:', err.message);
  process.exit(2);
});
