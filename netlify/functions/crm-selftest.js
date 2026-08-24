// VÄLIAIKAINEN DIAGNOSTIIKKAFUNKTIO — poista kun SUPABASE_SERVICE_ROLE_KEY-
// bugi (crm-invite-user: "admin.auth.getUser(token) epäonnistui: Invalid API
// key") on jäljitetty ja korjattu.
//
// Eristää täsmälleen missä kohtaa palvelinpuolen Supabase-kytkentä on rikki:
// 1) Onko kutsuja edes kirjautunut (validoidaan ANON-avaimella, joka TIEDETÄÄN
//    toimivan koska frontend lukee dataa sillä onnistuneesti).
// 2) Onko SUPABASE_SERVICE_ROLE_KEY -ympäristömuuttuja edes asetettu, ja
//    minkä muotoinen/pituinen se on (EI koskaan paljasta itse arvoa).
// 3) Toimiiko service role -avain YKSIN, ilman käyttäjätokenia
//    (admin.auth.admin.listUsers) — tämä paljastaa onko avain itsessään
//    virheellinen riippumatta mistään muusta.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Vain POST-pyynnöt sallittu.' }) };
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKeyRaw = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const report = {
    step1_env_url_set: !!url,
    step1_env_url_value: url || null, // URL ei ole salainen (frontend saa sen jo crm-config.js:stä)
    step1_env_anon_key_set: !!anonKey,
    step2_service_key_set: !!serviceKeyRaw,
    step2_service_key_length: serviceKeyRaw ? serviceKeyRaw.length : 0,
    step2_service_key_prefix: serviceKeyRaw ? serviceKeyRaw.slice(0, 10) : null,
    step2_service_key_has_whitespace: serviceKeyRaw ? serviceKeyRaw !== serviceKeyRaw.trim() : null,
    step2_service_key_trimmed_length: serviceKeyRaw ? serviceKeyRaw.trim().length : 0
  };

  // Vaihe 3: onko kutsuja kirjautunut (ANON-avaimella, joka tiedetään toimivan)
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  report.step3_authorization_header_present = !!token;

  if (token && url && anonKey) {
    try {
      const anonClient = createClient(url, anonKey);
      const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
      report.step3_anon_key_validates_token = !userErr && !!(userData && userData.user);
      report.step3_anon_key_error = userErr ? userErr.message : null;
      report.step3_user_email = userData && userData.user ? userData.user.email : null;
    } catch (err) {
      report.step3_anon_key_validates_token = false;
      report.step3_anon_key_error = String((err && err.message) || err);
    }
  }

  // Vaihe 4: toimiiko service_role-avain YKSIN, ilman käyttäjätokenia.
  // Tämä on ratkaiseva testi: jos TÄMÄKIN epäonnistuu "Invalid API key" -virheellä,
  // vika on 100% varmasti SUPABASE_SERVICE_ROLE_KEY-ympäristömuuttujan arvossa
  // itsessään (väärä arvo Netlifyssä), ei tokenin validoinnissa eikä koodissa.
  if (url && serviceKeyRaw) {
    try {
      const adminClient = createClient(url, serviceKeyRaw, { auth: { persistSession: false } });
      const { data, error } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1 });
      report.step4_service_key_works_alone = !error;
      report.step4_service_key_error = error ? error.message : null;
      report.step4_users_seen = data ? (data.users || []).length : 0;
    } catch (err) {
      report.step4_service_key_works_alone = false;
      report.step4_service_key_error = String((err && err.message) || err);
    }
  } else {
    report.step4_service_key_works_alone = false;
    report.step4_service_key_error = 'SUPABASE_SERVICE_ROLE_KEY tai SUPABASE_URL puuttuu.';
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report, null, 2)
  };
};
