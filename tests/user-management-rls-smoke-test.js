// RLS-murtotesti käyttäjähallinnan tietoturvakorjauksille
// (ks. supabase/migrations/0008_user_management.sql).
// Sama malli ja samat ympäristömuuttujat kuin tests/rls-smoke-test.js -
// ei vaadi uusia testikäyttäjiä, käyttää olemassa olevaa TEST_PARTNER_A:ta.
//
// KÄYTTÖ: SUPABASE_URL, SUPABASE_ANON_KEY, TEST_PARTNER_A_EMAIL/PASSWORD
//   node tests/user-management-rls-smoke-test.js
//
// TESTAA (kohta 14 "Käyttäjähallinnan määrittely" -dokumentin vaatimuksista):
//   - partner_admin ei voi nostaa KETÄÄN (edes itseään) super_adminiksi
//     suoralla PostgREST-kirjoituksella (ohi sovelluksen UI:n)
//   - partner_admin ei voi nostaa toista käyttäjää edes partner_adminiksi

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`Puuttuva ympäristömuuttuja: ${name}`); process.exit(2); }
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
  if (condition) console.log(`OK   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
}

(async () => {
  requireEnv('SUPABASE_URL'); requireEnv('SUPABASE_ANON_KEY');
  const emailA = requireEnv('TEST_PARTNER_A_EMAIL');
  const passA = requireEnv('TEST_PARTNER_A_PASSWORD');

  const clientA = await signIn(emailA, passA);
  const { data: { user: userA } } = await clientA.auth.getUser();

  // 1) partner_admin ei voi nostaa itseään super_adminiksi.
  const { error: selfEscalate } = await clientA.from('profiles').update({ role: 'super_admin' }).eq('id', userA.id);
  check('partner_admin ei voi nostaa itseään super_adminiksi', !!selfEscalate);

  // 2) partner_admin ei voi nostaa itseään edes partner_adminiksi uudelleen
  //    korkeampana kirjoitusoperaationa (varmistaa ettei policy vahingossa
  //    salli koska rooli "ei muutu" - testataan silti eksplisiittisesti
  //    kohteena joku MUU organisaation profiilirivi jos sellainen löytyy).
  const { data: orgProfiles } = await clientA.from('profiles').select('id, role').neq('id', userA.id).limit(1);
  if (orgProfiles && orgProfiles.length) {
    const targetId = orgProfiles[0].id;
    const { error: escalateOther } = await clientA.from('profiles').update({ role: 'partner_admin' }).eq('id', targetId);
    check('partner_admin ei voi nostaa toista käyttäjää partner_adminiksi', !!escalateOther);
  } else {
    console.log('SKIP partner_admin ei voi nostaa toista käyttäjää partner_adminiksi (ei toista käyttäjää testiorganisaatiossa)');
  }

  if (failures > 0) {
    console.error(`\n${failures} testiä epäonnistui.`);
    process.exit(1);
  }
  console.log('\nKaikki käyttäjähallinnan RLS-testit läpäisty.');
})().catch((err) => { console.error(err); process.exit(1); });
