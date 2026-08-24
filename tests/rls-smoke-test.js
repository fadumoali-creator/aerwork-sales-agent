// RLS-eristyksen "murtotesti" oikeaa Supabase-projektia vasten.
// =============================================================
// Tätä EI voi ajaa ilman oikeaa, jo pystytettyä Supabase-projektia jossa
// migraatio (supabase/migrations/0001_crm_schema.sql) on ajettu ja jossa on
// olemassa vähintään kaksi testikäyttäjää KAHDESSA ERI Certified Partner
// -organisaatiossa. Tämä on juuri se testi, jota vaatimusten kohta 12
// edellyttää: "Käyttöoikeudet testataan myös yrittämällä päästä tietoihin
// suoran API-kutsun kautta" — tässä kutsutaan Supabasen REST/PostgREST-
// rajapintaa SUORAAN kahden eri käyttäjän access tokenilla, ohi sovelluksen.
//
// KÄYTTÖ:
//   1. Luo Supabase-projekti, aja migraatio.
//   2. Luo kaksi Certified Partner -organisaatiota ja kummallekin yksi
//      partner_admin-käyttäjä (Supabase Auth: sähköposti+salasana), sekä
//      kummallekin yksi companies-rivi (owning_partner_id = oma org).
//   3. Aseta ympäristömuuttujat ja aja: node tests/rls-smoke-test.js
//
//   SUPABASE_URL=...
//   SUPABASE_ANON_KEY=...
//   TEST_PARTNER_A_EMAIL=... TEST_PARTNER_A_PASSWORD=...
//   TEST_PARTNER_B_EMAIL=... TEST_PARTNER_B_PASSWORD=...
//
// Testi EPÄONNISTUU (exit 1) jos partneri A näkee YHDENKÄÄN partnerin B
// yritysrivin, tai päinvastoin, tai jos joku pystyy kirjoittamaan toisen
// partnerin dataan tai audit_logiin suoraan.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
  const emailA = requireEnv('TEST_PARTNER_A_EMAIL');
  const passA = requireEnv('TEST_PARTNER_A_PASSWORD');
  const emailB = requireEnv('TEST_PARTNER_B_EMAIL');
  const passB = requireEnv('TEST_PARTNER_B_PASSWORD');

  console.log('Kirjaudutaan sisään molemmilla testikäyttäjillä (suoraan Supabase Authiin, ei sovelluksen kautta)...');
  const clientA = await signIn(emailA, passA);
  const clientB = await signIn(emailB, passB);

  console.log('\n1) Partneri A ei saa nähdä partnerin B yrityksiä (ja päinvastoin):');
  const { data: companiesA } = await clientA.from('companies').select('id, owning_partner_id, name');
  const { data: companiesB } = await clientB.from('companies').select('id, owning_partner_id, name');

  const orgIdA = companiesA && companiesA[0] ? companiesA[0].owning_partner_id : null;
  const orgIdB = companiesB && companiesB[0] ? companiesB[0].owning_partner_id : null;

  check('A:n tulos sisältää vain A:n omaa dataa', !companiesA.some((c) => orgIdB && c.owning_partner_id === orgIdB));
  check('B:n tulos sisältää vain B:n omaa dataa', !companiesB.some((c) => orgIdA && c.owning_partner_id === orgIdA));
  check('A näkee vähintään yhden oman yrityksen (sanity check, ei väärä positiivinen)', companiesA.length > 0);
  check('B näkee vähintään yhden oman yrityksen (sanity check)', companiesB.length > 0);

  if (companiesB.length > 0) {
    const targetId = companiesB[0].id;
    console.log('\n2) Partneri A ei saa lukea suoraan .eq(id, <B:n yritys>) -kyselylläkään:');
    const { data: direct } = await clientA.from('companies').select('*').eq('id', targetId);
    check('Suora id-haku toisen partnerin yritykseen palauttaa tyhjän (ei RLS-vuotoa)', !direct || direct.length === 0);

    console.log('\n3) Partneri A ei saa PÄIVITTÄÄ partnerin B yritystä suoralla API-kutsulla:');
    const { data: updated, error: updateErr } = await clientA
      .from('companies')
      .update({ notes: 'HYÖKKÄYSTESTI — tämän ei pitäisi onnistua' })
      .eq('id', targetId)
      .select();
    check('Update ei palauta muokattuja rivejä (RLS esti, 0 riviä)', !updateErr && (!updated || updated.length === 0));

    console.log('\n4) Partneri A ei saa lisätä kontaktia partnerin B yritykselle:');
    const { error: insertErr } = await clientA.from('contacts').insert({ company_id: targetId, name: 'Hyökkäystesti' });
    check('Insert estetty RLS-policyllä (virhe palautui)', !!insertErr);

    console.log('\n5) fn_check_company_duplicate ei paljasta partnerin B tietoja partnerille A:lle:');
    const { data: dupResult } = await clientA.rpc('fn_check_company_duplicate', {
      p_name: companiesB[0].name,
      p_business_id: null,
      p_website: null,
      p_email: null,
      p_phone: null
    });
    check(
      'Duplikaattivastaus ei sisällä owner_partner_name/-id -kenttiä ei-super-adminille',
      dupResult && !('owner_partner_name' in dupResult) && !('owner_partner_id' in dupResult)
    );
  } else {
    console.warn('  (Ohitettu: partnerilla B ei ole yhtään yritysriviä testidatassa.)');
  }

  console.log('\n6) Kumpikaan ei saa kirjoittaa audit_log-tauluun suoraan (vain trigger saa):');
  const { error: auditInsertErr } = await clientA.from('audit_log').insert({
    table_name: 'companies',
    record_id: '00000000-0000-0000-0000-000000000000',
    action: 'update',
    changed_by: null
  });
  check('audit_log-insert estetty suoraan clientiltä', !!auditInsertErr);

  console.log(`\n${failures === 0 ? '✅ Kaikki RLS-eristystestit läpäisty.' : `❌ ${failures} testiä epäonnistui — tarkista RLS-policyt ennen tuotantoa!`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Testi kaatui virheeseen:', err.message);
  process.exit(2);
});
