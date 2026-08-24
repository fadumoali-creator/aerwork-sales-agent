// Sopimuslaskennan puhtaat funktiot — peilaavat TARKALLEEN Supabase-migraation
// fn_recalc_deal_totals()-funktiota (supabase/migrations/0001_crm_schema.sql).
// Näitä käytetään frontendissä esikatseluun (esim. tarjouslomakkeella ennen
// tallennusta) ja niiden oikeellisuus on testattu tests/calc.test.js:ssä.
// TIETOKANTA ON AINA TOTUUDEN LÄHDE lopullisille arvoille — nämä funktiot eivät
// koskaan korvaa palvelinpuolen laskentaa, vain näyttävät saman tuloksen etukäteen.

'use strict';

/**
 * Laske yhden rivin kuukausittainen toistuva laskutus (MRR-osuus).
 * @param {{monthly_price:number, quantity:number, discount_percent?:number}} item
 */
function lineItemMrr(item) {
  const price = Number(item.monthly_price) || 0;
  const qty = Number(item.quantity) || 0;
  const discount = Number(item.discount_percent) || 0;
  return round2(price * qty * (1 - discount / 100));
}

/**
 * Laske sopimuksen kesto kuukausina kahden päivämäärän välillä
 * (kalenterikuukausien erotus, ei koskaan negatiivinen).
 * @param {string|Date|null} start
 * @param {string|Date|null} end
 */
function contractLengthMonths(start, end) {
  if (!start || !end) return null;
  const s = new Date(start);
  const e = new Date(end);
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Laske koko sopimuksen kokonaisluvut: MRR, ARR, kesto, kokonaisarvo, komissio.
 * @param {object} deal - { contract_start_date, contract_end_date, discount_percent, commission_rate }
 * @param {Array<object>} lineItems - deal_line_items-rivit
 */
function calcDealTotals(deal, lineItems) {
  const rawMrr = (lineItems || []).reduce((sum, item) => sum + lineItemMrr(item), 0);
  const dealDiscount = Number(deal.discount_percent) || 0;
  const mrr = round2(rawMrr * (1 - dealDiscount / 100));
  const arr = round2(mrr * 12);

  const length = contractLengthMonths(deal.contract_start_date, deal.contract_end_date);

  const setupTotal = (lineItems || []).reduce(
    (sum, item) => sum + (Number(item.setup_fee) || 0) * (Number(item.quantity) || 0),
    0
  );
  const oneTimeTotal = (lineItems || []).reduce(
    (sum, item) => sum + (Number(item.one_time_fees) || 0) * (Number(item.quantity) || 0),
    0
  );

  const totalValue = round2(mrr * (length || 0) + setupTotal + oneTimeTotal);
  const commissionRate = Number(deal.commission_rate) || 0;
  const commissionAmount = round2(totalValue * (commissionRate / 100));

  return {
    mrr,
    arr,
    contract_length_months: length,
    total_value: totalValue,
    commission_amount: commissionAmount
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = { lineItemMrr, contractLengthMonths, calcDealTotals, round2 };
