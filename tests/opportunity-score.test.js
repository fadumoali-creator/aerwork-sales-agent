// Yksikkötestit AerWork Opportunity Score -laskennalle (crm/lib/opportunityScore.js).
// Aja: node --test tests/opportunity-score.test.js (tai npm test, ks. package.json)

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcOpportunityScore } = require('../crm/lib/opportunityScore');

test('Aktiivinen sopimus -> aina score 0, matala, ei suositusta', () => {
  const result = calcOpportunityScore({ company: { has_active_contract: true } });
  assert.equal(result.score, 0);
  assert.equal(result.tier, 'matala');
  assert.equal(result.recommended_product, null);
});

test('Ei signaaleja -> score 0, matala, puuttuvat tiedot listattu', () => {
  const result = calcOpportunityScore({ company: {} });
  assert.equal(result.score, 0);
  assert.equal(result.tier, 'matala');
  assert.ok(result.missing_data.includes('industry_unknown'));
  assert.ok(result.missing_data.includes('no_decision_maker_found'));
});

test('Vahva tapaus: kohdetoimiala + monta vuorotyöpaikkaa + HR-rekrytointi + kasvu -> korkea', () => {
  const result = calcOpportunityScore({
    company: { industry: 'Hoiva-ala', headcount_growth: true, revenue_growth: true, site_count: 3 },
    jobPostings: [
      { status: 'open', is_shift_work: true, is_hr_related: false, is_payroll_related: false, is_recruiting_related: false },
      { status: 'open', is_shift_work: true, is_hr_related: false, is_payroll_related: false, is_recruiting_related: false },
      { status: 'open', is_shift_work: false, is_hr_related: true, is_payroll_related: false, is_recruiting_related: true }
    ],
    decisionMakers: [{ name: 'Testi Henkilö' }],
    hasRespondedBefore: true
  });
  assert.equal(result.tier, 'korkea');
  assert.ok(result.score >= 60);
  assert.equal(result.recommended_product, 'AerShift (AI-työvuorosuunnittelu)');
});

test('Score ei koskaan ylitä 100 eikä mene negatiiviseksi', () => {
  const result = calcOpportunityScore({
    company: { industry: 'Henkilöstöpalveluala', headcount_growth: true, revenue_growth: true, site_count: 5 },
    jobPostings: Array.from({ length: 10 }, () => ({
      status: 'open', is_shift_work: true, is_hr_related: true, is_payroll_related: true, is_recruiting_related: true
    })),
    decisionMakers: [{ name: 'A' }, { name: 'B' }],
    hasRespondedBefore: true
  });
  assert.ok(result.score <= 100);
  assert.ok(result.score >= 0);
});

test('Yksi HR-rooli ilman rekrytointia -> suositus Kevyt HR / AerPay', () => {
  const result = calcOpportunityScore({
    company: { industry: 'Ravintola-ala' },
    jobPostings: [{ status: 'open', is_hr_related: false, is_payroll_related: true, is_recruiting_related: false }],
    decisionMakers: []
  });
  assert.equal(result.recommended_product, 'Kevyt HR / AerPay');
});

test('Aktiivisessa myyntiprosessissa -> suositeltu toimenpide kertoo sen', () => {
  const result = calcOpportunityScore({
    company: { industry: 'Siivousala', in_active_process: true },
    jobPostings: [],
    decisionMakers: []
  });
  assert.match(result.recommended_action, /aktiivisessa myyntiprosessissa/);
});

test('rationale mainitsee aina että kyseessä on analyysi, ei vahvistettu fakta', () => {
  const result = calcOpportunityScore({ company: { industry: 'Ravintola' } });
  assert.match(result.rationale, /AI-avusteinen ANALYYSI, ei vahvistettu tosiasia/);
});
