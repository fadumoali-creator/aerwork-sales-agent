// Yksikkötestit kasvun suunta -logiikalle (crm/lib/financialGrowth.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcGrowthDirection } = require('../crm/lib/financialGrowth');

test('yli +3% -> kasvaa', () => {
  const r = calcGrowthDirection(1124000, 1000000); // +12.4%
  assert.equal(r.direction, 'kasvaa');
  assert.equal(r.percent, 12.4);
});

test('tasan +3% -> vakaa (raja ei ole kasvaa)', () => {
  const r = calcGrowthDirection(1030000, 1000000);
  assert.equal(r.direction, 'vakaa');
});

test('-3%..+3% väli -> vakaa', () => {
  const r = calcGrowthDirection(980000, 1000000); // -2%
  assert.equal(r.direction, 'vakaa');
});

test('alle -3% -> laskee', () => {
  const r = calcGrowthDirection(900000, 1000000); // -10%
  assert.equal(r.direction, 'laskee');
});

test('puuttuva vertailutieto -> ei_tietoa, ei prosenttia', () => {
  assert.equal(calcGrowthDirection(1000000, null).direction, 'ei_tietoa');
  assert.equal(calcGrowthDirection(null, 1000000).direction, 'ei_tietoa');
  assert.equal(calcGrowthDirection(1000000, undefined).percent, null);
});

test('edellinen tilikausi 0 -> ei_tietoa (ei jaeta nollalla)', () => {
  const r = calcGrowthDirection(1000, 0);
  assert.equal(r.direction, 'ei_tietoa');
});
