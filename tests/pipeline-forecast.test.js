// Yksikkötestit myyntiputken forecast-/pysähtyneisyyslaskennalle
// (crm/lib/pipelineForecast.js). Aja: node --test tests/pipeline-forecast.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcWeightedForecast, daysInStage, isStalled } = require('../crm/lib/pipelineForecast');

test('calcWeightedForecast: tyhjä lista -> nollat', () => {
  const result = calcWeightedForecast([]);
  assert.deepEqual(result, { totalValue: 0, weightedValue: 0, count: 0 });
});

test('calcWeightedForecast: summaa arvon ja painottaa todennäköisyydellä', () => {
  const result = calcWeightedForecast([
    { estimated_value: 10000, probability: 50 },
    { estimated_value: 4000, probability: 25 }
  ]);
  assert.equal(result.totalValue, 14000);
  assert.equal(result.weightedValue, 6000); // 5000 + 1000
  assert.equal(result.count, 2);
});

test('calcWeightedForecast: puuttuva arvo/todennäköisyys käsitellään nollana, ei kaadu', () => {
  const result = calcWeightedForecast([{ estimated_value: null, probability: undefined }]);
  assert.equal(result.totalValue, 0);
  assert.equal(result.weightedValue, 0);
});

test('calcWeightedForecast: todennäköisyys rajataan 0-100 väliin', () => {
  const result = calcWeightedForecast([{ estimated_value: 1000, probability: 150 }]);
  assert.equal(result.weightedValue, 1000); // ei 1500
});

test('daysInStage: laskee kokonaiset päivät, ei koskaan negatiivinen', () => {
  assert.equal(daysInStage('2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z'), 4);
  assert.equal(daysInStage('2026-08-10T00:00:00Z', '2026-08-05T00:00:00Z'), 0);
  assert.equal(daysInStage(null, '2026-08-05T00:00:00Z'), 0);
});

test('isStalled: ylittää max_duration_days -> true', () => {
  const stage = { max_duration_days: 5 };
  const opp = { stage_entered_at: '2026-08-01T00:00:00Z' };
  assert.equal(isStalled(opp, stage, '2026-08-10T00:00:00Z'), true);
  assert.equal(isStalled(opp, stage, '2026-08-03T00:00:00Z'), false);
});

test('isStalled: vaihe ilman aikarajaa (null) -> ei koskaan pysähtynyt', () => {
  const stage = { max_duration_days: null };
  const opp = { stage_entered_at: '2020-01-01T00:00:00Z' };
  assert.equal(isStalled(opp, stage, '2026-08-24T00:00:00Z'), false);
});

test('isStalled: voitettu/hävitty vaihe -> ei koskaan pysähtynyt vaikka aikaraja olisi', () => {
  const stageWon = { max_duration_days: 5, is_won: true };
  const stageLost = { max_duration_days: 5, is_lost: true };
  const opp = { stage_entered_at: '2020-01-01T00:00:00Z' };
  assert.equal(isStalled(opp, stageWon, '2026-08-24T00:00:00Z'), false);
  assert.equal(isStalled(opp, stageLost, '2026-08-24T00:00:00Z'), false);
});
