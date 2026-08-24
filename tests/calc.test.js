// Yksikkötestit sopimuslaskennalle (crm/lib/calc.js).
// Aja: node --test tests/calc.test.js  (tai `npm test`, ks. package.json)

const test = require('node:test');
const assert = require('node:assert/strict');
const { lineItemMrr, contractLengthMonths, calcDealTotals, round2 } = require('../crm/lib/calc');

test('round2 pyöristää oikein', () => {
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(10.004), 10);
  assert.equal(round2(0), 0);
});

test('lineItemMrr: perus kertolasku ilman alennusta', () => {
  assert.equal(lineItemMrr({ monthly_price: 100, quantity: 3 }), 300);
});

test('lineItemMrr: rivikohtainen alennus vähentää oikein', () => {
  assert.equal(lineItemMrr({ monthly_price: 100, quantity: 2, discount_percent: 10 }), 180);
});

test('lineItemMrr: puuttuvat kentät eivät kaada laskentaa (fallback 0)', () => {
  assert.equal(lineItemMrr({}), 0);
});

test('contractLengthMonths: tasan 12 kuukautta', () => {
  assert.equal(contractLengthMonths('2026-01-01', '2027-01-01'), 12);
});

test('contractLengthMonths: vajaa kuukausi pyöristyy alaspäin (ei ylös)', () => {
  // 2026-01-15 -> 2026-02-10 on alle kuukauden (päivä 10 < 15), joten 0 kk
  assert.equal(contractLengthMonths('2026-01-15', '2026-02-10'), 0);
});

test('contractLengthMonths: puuttuva päivämäärä palauttaa null', () => {
  assert.equal(contractLengthMonths(null, '2026-02-10'), null);
  assert.equal(contractLengthMonths('2026-01-01', null), null);
});

test('contractLengthMonths: ei koskaan negatiivinen', () => {
  assert.equal(contractLengthMonths('2026-06-01', '2026-01-01'), 0);
});

test('calcDealTotals: yksi tuote, ei alennuksia, 12kk sopimus', () => {
  const deal = {
    contract_start_date: '2026-01-01',
    contract_end_date: '2027-01-01',
    discount_percent: 0,
    commission_rate: 20
  };
  const lineItems = [{ monthly_price: 500, quantity: 1, setup_fee: 1000, one_time_fees: 0 }];
  const result = calcDealTotals(deal, lineItems);

  assert.equal(result.mrr, 500);
  assert.equal(result.arr, 6000);
  assert.equal(result.contract_length_months, 12);
  // total_value = mrr*12 + setup = 500*12 + 1000 = 7000
  assert.equal(result.total_value, 7000);
  // commission = 7000 * 20% = 1400
  assert.equal(result.commission_amount, 1400);
});

test('calcDealTotals: useampi rivi + sopimustason alennus', () => {
  const deal = {
    contract_start_date: '2026-01-01',
    contract_end_date: '2026-07-01', // 6 kk
    discount_percent: 10, // koko sopimuksen MRR:ää alennetaan 10%
    commission_rate: 15
  };
  const lineItems = [
    { monthly_price: 200, quantity: 5, setup_fee: 300, one_time_fees: 0 }, // rivi-MRR 1000
    { monthly_price: 50, quantity: 2, discount_percent: 20, setup_fee: 0, one_time_fees: 100 } // rivi-MRR 80
  ];
  const result = calcDealTotals(deal, lineItems);

  // raw mrr = 1000 + 80 = 1080, deal-tason 10% alennus -> 972
  assert.equal(result.mrr, 972);
  assert.equal(result.arr, round2(972 * 12));
  assert.equal(result.contract_length_months, 6);
  // setup = 300*qty(5) = 1500, onetime = 100*qty(2) = 200 (setup/onetime skaalautuu rivin quantitylla)
  // total = 972*6 + 1500 + 200 = 5832 + 1700 = 7532
  assert.equal(result.total_value, 7532);
  assert.equal(result.commission_amount, round2(7532 * 0.15));
});

test('calcDealTotals: ei alkamis/päättymispäivää -> kesto null, total_value käyttää 0kk', () => {
  const deal = { commission_rate: 10 };
  const lineItems = [{ monthly_price: 100, quantity: 1, setup_fee: 500, one_time_fees: 0 }];
  const result = calcDealTotals(deal, lineItems);

  assert.equal(result.contract_length_months, null);
  assert.equal(result.mrr, 100);
  // total = mrr*0 + setup = 500
  assert.equal(result.total_value, 500);
  assert.equal(result.commission_amount, 50);
});

test('calcDealTotals: tyhjä rivilista -> kaikki nollia, ei kaadu', () => {
  const result = calcDealTotals({ commission_rate: 10 }, []);
  assert.equal(result.mrr, 0);
  assert.equal(result.arr, 0);
  assert.equal(result.total_value, 0);
  assert.equal(result.commission_amount, 0);
});
