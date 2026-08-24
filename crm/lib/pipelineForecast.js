// Myyntiputken puhtaat laskentafunktiot: painotettu ennuste ja pysähtyneen
// kaupan tunnistus. Peilaavat samaa dataa kuin supabase/migrations/
// 0005_opportunities_pipeline.sql (opportunities.stage_entered_at,
// pipeline_stages.max_duration_days). Ei koskaan muuta dataa — vain laskee
// arvoja UI:ta varten. Testattu tests/pipeline-forecast.test.js:ssä.

'use strict';

/**
 * Laske avoimen putken kokonaisarvo ja todennäköisyyspainotettu ennuste.
 * @param {Array<{estimated_value:number, probability:number}>} opportunities
 *   - kutsujan vastuulla on antaa vain AVOIMET (ei voitetut/hävityt) rivit.
 */
function calcWeightedForecast(opportunities) {
  return (opportunities || []).reduce((acc, o) => {
    const value = Number(o.estimated_value) || 0;
    const probability = Math.max(0, Math.min(100, Number(o.probability) || 0));
    acc.totalValue += value;
    acc.weightedValue += value * (probability / 100);
    acc.count += 1;
    return acc;
  }, { totalValue: 0, weightedValue: 0, count: 0 });
}

/**
 * Montako kokonaista päivää mahdollisuus on ollut nykyisessä vaiheessa.
 * @param {string|Date|null} stageEnteredAt
 * @param {string|Date} [now] - testattavuutta varten, oletus = new Date()
 */
function daysInStage(stageEnteredAt, now) {
  if (!stageEnteredAt) return 0;
  const entered = new Date(stageEnteredAt);
  const nowDate = now ? new Date(now) : new Date();
  const ms = nowDate.getTime() - entered.getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

/**
 * Onko mahdollisuus "pysähtynyt" — ylittänyt vaiheen suositellun enimmäis-
 * keston. Voitetut/hävityt (päätetilat) eivät koskaan ole pysähtyneitä, eikä
 * vaihe jolla ei ole aikarajaa (max_duration_days == null).
 * @param {{stage_entered_at:string}} opportunity
 * @param {{max_duration_days:?number, is_won?:boolean, is_lost?:boolean}} stage
 * @param {string|Date} [now]
 */
function isStalled(opportunity, stage, now) {
  if (!stage || stage.max_duration_days == null) return false;
  if (stage.is_won || stage.is_lost) return false;
  return daysInStage(opportunity && opportunity.stage_entered_at, now) > stage.max_duration_days;
}

module.exports = { calcWeightedForecast, daysInStage, isStalled };
