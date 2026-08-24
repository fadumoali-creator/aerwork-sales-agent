// Ajastettu tehtävä (Netlify Scheduled Function, ks. netlify.toml): kutsuu
// fn_generate_commission_ledger()-funktiota säännöllisesti, jotta
// commission_ledger pysyy ajan tasalla ilman että kukaan käyttäjä joutuu
// erikseen laukaisemaan sitä. Idempotentti (unique-rajoite deal_line_item_id
// + period_month), joten turvallinen ajaa uudelleen jos ajo epäonnistuu tai
// ajastin laukeaa useammin kuin tarpeen.

const { adminClient } = require('./_crm-shared');

exports.handler = async () => {
  const admin = adminClient();
  const { data, error } = await admin.rpc('fn_generate_commission_ledger');
  if (error) {
    console.error('Provisiolaskelman generointi epäonnistui:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  console.log(`Lisättiin ${data} uutta provisiolaskelmariviä.`);
  return { statusCode: 200, body: JSON.stringify({ inserted_rows: data }) };
};

exports.config = {
  // Kerran vuorokaudessa riittää - kuukausiraja ei liiku nopeammin, ja
  // fn_generate_commission_ledger on halpa/idempotentti ajaa useammin jos
  // ajastin laukeaa uudelleen samana päivänä.
  schedule: '@daily'
};
