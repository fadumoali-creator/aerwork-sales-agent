// AerWork Opportunity Score — puhdas, testattava pisteytysfunktio.
// EI koskaan väitä tulosta varmaksi faktaksi — palauttaa aina signaalit,
// puuttuvat tiedot ja perustelun niin että UI voi näyttää "tämä on analyysi,
// ei vahvistettu tosiasia" (vaatimuksen kohta 7).

'use strict';

const SIGNAL_WEIGHTS = {
  multiple_open_jobs: 15,       // useita avoimia työpaikkoja
  hr_payroll_ops_hiring: 15,    // rekrytoi HR/payroll/operations-rooleihin
  shift_heavy: 15,              // paljon vuorotyötä
  target_industry: 15,          // hoiva/terveys/henkilöstö/ravintola/hotelli/siivous/turvallisuus/palveluala
  headcount_growth: 10,         // henkilöstömäärä kasvaa
  revenue_growth: 10,           // liikevaihto kasvaa
  multi_site: 10,               // useita toimipaikkoja
  no_active_contract: -100,     // (käsitellään erikseen: jos AKTIIVINEN sopimus, score on aina 0)
  decision_maker_found: 5,      // päättäjä löydetty
  responded_before: 5           // yritys on vastannut aiempaan yhteydenottoon
};

const TARGET_INDUSTRY_KEYWORDS = [
  'hoiva', 'terveys', 'henkilöstö', 'henkilostopalvelu', 'staffing', 'ravintola', 'hotelli',
  'majoitus', 'siivous', 'turvallisuus', 'vartiointi', 'palvelu', 'kotihoito', 'hoitokoti'
];

/**
 * @param {object} input
 * @param {object} input.company - { industry, employee_count, has_active_contract, in_active_process, headcount_growth, revenue_growth, site_count }
 * @param {Array}  input.jobPostings - avoimet työpaikat (status='open')
 * @param {Array}  input.decisionMakers - löydetyt päättäjät
 * @param {boolean} input.hasRespondedBefore
 */
function calcOpportunityScore(input) {
  const company = input.company || {};
  const jobPostings = input.jobPostings || [];
  const decisionMakers = input.decisionMakers || [];

  const signals = [];
  const missingData = [];

  if (company.has_active_contract) {
    return {
      score: 0,
      tier: 'matala',
      signals: [{ signal: 'has_active_contract', points: 0, evidence: 'Yrityksellä on jo aktiivinen AerWork-sopimus.' }],
      missing_data: [],
      recommended_product: null,
      recommended_action: 'Ei uutta myyntitoimenpidettä - asiakas on jo aktiivinen.',
      rationale: 'Yrityksellä on voimassa oleva sopimus, joten uutta Opportunity Scorea ei lasketa.'
    };
  }

  const openJobs = jobPostings.filter((j) => j.status === 'open');
  if (openJobs.length >= 3) {
    signals.push({
      signal: 'multiple_open_jobs',
      points: SIGNAL_WEIGHTS.multiple_open_jobs,
      evidence: `${openJobs.length} avointa työpaikkaa havaittu.`
    });
  } else if (openJobs.length === 0 && jobPostings.length === 0) {
    missingData.push('open_jobs_not_checked');
  }

  const hrRelated = openJobs.filter((j) => j.is_hr_related || j.is_payroll_related || j.is_recruiting_related);
  if (hrRelated.length > 0) {
    signals.push({
      signal: 'hr_payroll_ops_hiring',
      points: SIGNAL_WEIGHTS.hr_payroll_ops_hiring,
      evidence: `${hrRelated.length} avointa HR/palkanlaskenta/rekrytointi-roolia.`
    });
  }

  const shiftJobs = openJobs.filter((j) => j.is_shift_work);
  if (shiftJobs.length > 0) {
    signals.push({
      signal: 'shift_heavy',
      points: SIGNAL_WEIGHTS.shift_heavy,
      evidence: `${shiftJobs.length} vuorotyöhön liittyvää avointa tehtävää.`
    });
  }

  const industry = (company.industry || '').toLowerCase();
  if (TARGET_INDUSTRY_KEYWORDS.some((kw) => industry.includes(kw))) {
    signals.push({
      signal: 'target_industry',
      points: SIGNAL_WEIGHTS.target_industry,
      evidence: `Toimiala "${company.industry}" vastaa AerWorkin kohdealoja.`
    });
  } else if (!company.industry) {
    missingData.push('industry_unknown');
  }

  if (company.headcount_growth === true) {
    signals.push({ signal: 'headcount_growth', points: SIGNAL_WEIGHTS.headcount_growth, evidence: 'Henkilöstömäärä on kasvanut.' });
  } else if (company.headcount_growth === undefined || company.headcount_growth === null) {
    missingData.push('headcount_growth_unknown');
  }

  if (company.revenue_growth === true) {
    signals.push({ signal: 'revenue_growth', points: SIGNAL_WEIGHTS.revenue_growth, evidence: 'Liikevaihto on kasvanut.' });
  } else if (company.revenue_growth === undefined || company.revenue_growth === null) {
    missingData.push('revenue_data_not_available');
  }

  if (Number(company.site_count) > 1) {
    signals.push({ signal: 'multi_site', points: SIGNAL_WEIGHTS.multi_site, evidence: `${company.site_count} toimipaikkaa.` });
  }

  if (decisionMakers.length > 0) {
    signals.push({
      signal: 'decision_maker_found',
      points: SIGNAL_WEIGHTS.decision_maker_found,
      evidence: `${decisionMakers.length} päättäjä(ä) löydetty.`
    });
  } else {
    missingData.push('no_decision_maker_found');
  }

  if (input.hasRespondedBefore) {
    signals.push({ signal: 'responded_before', points: SIGNAL_WEIGHTS.responded_before, evidence: 'Yritys on vastannut aiempaan yhteydenottoon.' });
  }

  const rawScore = signals.reduce((sum, s) => sum + s.points, 0);
  const score = Math.max(0, Math.min(100, rawScore));
  const tier = score >= 60 ? 'korkea' : score >= 30 ? 'keskitaso' : 'matala';

  const recommendedProduct = shiftJobs.length > 0
    ? 'AerShift (AI-työvuorosuunnittelu)'
    : hrRelated.some((j) => j.is_recruiting_related)
      ? 'AI-rekrytoija'
      : hrRelated.length > 0
        ? 'Kevyt HR / AerPay'
        : null;

  const recommendedAction = company.in_active_process
    ? 'Yritys on jo aktiivisessa myyntiprosessissa - ei uutta ensikontaktia.'
    : tier === 'korkea'
      ? 'Priorisoi ensikontakti ja etsi/valitse vastuuhenkilö.'
      : tier === 'keskitaso'
        ? 'Lisää seurantalistalle, täydennä puuttuvat tiedot ennen kontaktia.'
        : 'Ei kiireellinen - tarkista signaalit myöhemmin uudestaan.';

  return {
    score,
    tier,
    signals,
    missing_data: missingData,
    recommended_product: recommendedProduct,
    recommended_action: recommendedAction,
    rationale: `Pisteytys perustuu ${signals.length} havaittuun signaaliin (${score}/100). ` +
      `Tämä on AI-avusteinen ANALYYSI, ei vahvistettu tosiasia - tarkista puuttuvat tiedot (${missingData.length} kpl) ennen päätöksentekoa.`
  };
}

module.exports = { calcOpportunityScore, SIGNAL_WEIGHTS, TARGET_INDUSTRY_KEYWORDS };
