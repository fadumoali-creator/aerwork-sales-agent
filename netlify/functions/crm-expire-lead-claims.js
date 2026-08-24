// Ajastettu tehtävä (Netlify Scheduled Function, ks. netlify.toml): kutsuu
// fn_expire_stale_lead_claims()-funktiota säännöllisesti. Tämä on VARMISTUS/
// siisteys koko kannalle - ei tietoturvan perusta (ks. 0009_lead_claim_
// protection.sql:n kommentti). Kaikki turvallisuuskriittinen vanheneminen
// tapahtuu jo AINA saman transaktion sisällä fn_check_lead_claim/
// fn_create_company_claim -kutsuissa, riippumatta siitä onko tämä ajastin
// ehtinyt ajaa vai ei.

const { adminClient } = require('./_crm-shared');

exports.handler = async () => {
  const admin = adminClient();
  const { data, error } = await admin.rpc('fn_expire_stale_lead_claims');
  if (error) {
    console.error('Liidisuojien vanhentaminen epäonnistui:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  console.log(`Vanhennettiin ${data} liidisuojaa.`);
  return { statusCode: 200, body: JSON.stringify({ expired_count: data }) };
};

exports.config = {
  // Kerran tunnissa - riittävän tiheä ettei suoja ehdi olla merkittävästi
  // vanhentunut ennen kuin dashboard/lista näyttävät sen oikein niillekin
  // käyttäjille jotka eivät koske kirjaustoimintoon (mikä laukaisisi
  // lazy-vanhennuksen muutenkin).
  schedule: '@hourly'
};
