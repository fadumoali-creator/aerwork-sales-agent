// Palauttaa CRM-frontendille julkisen Supabase-konfiguraation.
// HUOM: SUPABASE_ANON_KEY on Supabasen tarkoituksella JULKINEN avain — se ei
// anna mitään oikeuksia ohi Row Level Securityn, joten sen paljastaminen
// selaimelle on turvallista ja Supabasen suositeltu käyttötapa. Todellinen
// pääsynhallinta tulee aina RLS-policyista (ks. supabase/migrations), ei
// tämän avaimen salaamisesta. SUPABASE_SERVICE_ROLE_KEY EI koskaan kulje
// tämän funktion kautta.

exports.handler = async () => {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error:
          'SUPABASE_URL tai SUPABASE_ANON_KEY puuttuu Netlifyn ympäristömuuttujista. Lisää ne: Project configuration → Environment variables, ja tee uusi deploy. Ks. supabase/README.md.'
      })
    };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ supabaseUrl: url, supabaseAnonKey: anonKey })
  };
};
