// 90 päivän liidisuoja — puhtaat näyttölogiikan funktiot (jäljellä oleva
// aika, tila/väri). Itse suojan LUONTI/TARKISTUS/VANHENEMINEN tapahtuu
// tietokannassa (supabase/migrations/0009_lead_claim_protection.sql:
// fn_check_lead_claim/fn_create_company_claim/fn_expire_stale_lead_claims)
// - tämä tiedosto EI KOSKAAN päätä onko suoja voimassa, vain NÄYTTÄÄ sen
// mitä tietokanta on jo päättänyt. Testattu tests/lead-claim.test.js:ssä.

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Jäljellä oleva aika suojan päättymiseen.
 * @param {string|Date|null} protectionExpiresAt
 * @param {string|Date} [now]
 * @returns {{days:number, hours:number, totalMs:number, isPast:boolean}}
 */
function timeRemaining(protectionExpiresAt, now) {
  if (!protectionExpiresAt) return { days: 0, hours: 0, totalMs: 0, isPast: true };
  const nowDate = now ? new Date(now) : new Date();
  const totalMs = new Date(protectionExpiresAt).getTime() - nowDate.getTime();
  const isPast = totalMs <= 0;
  const abs = Math.abs(totalMs);
  return {
    days: Math.floor(abs / DAY_MS),
    hours: Math.floor((abs % DAY_MS) / (60 * 60 * 1000)),
    totalMs,
    isPast
  };
}

// Vaatimuksen kohdan 5 tilat + värit:
//   vihreä: aktiivinen / oranssi: <14pv jäljellä / punainen: <3pv jäljellä
//   harmaa: vanhentunut tai vapautettu / sininen: muutettu asiakkaaksi
const CLAIM_DISPLAY = {
  converted_to_customer: { label: 'Muutettu asiakkaaksi', color: 'blue' },
  released: { label: 'Vapautettu', color: 'gray' },
  under_review: { label: 'Ylläpidon tarkistuksessa', color: 'gray' },
  expired: { label: 'Vanhentunut', color: 'gray' }
};

/**
 * Yrityksen liidisuojan näyttötila puhtaana objektina (label + väri +
 * jäljellä oleva aika) - ei koskaan itse päätä tilaa, lukee sen
 * claim_status-sarakkeesta ja laskee vain ajan/värin sen päälle.
 * @param {{claim_status:string, protection_expires_at:?string}} company
 * @param {string|Date} [now]
 */
function claimDisplayStatus(company, now) {
  const status = company && company.claim_status;
  if (status && CLAIM_DISPLAY[status]) {
    return { key: status, ...CLAIM_DISPLAY[status], daysRemaining: 0, hoursRemaining: 0 };
  }
  // 'active' (tai tuntematon/puuttuva - kohdellaan varovaisesti aktiivisena
  // kunnes tietokanta sanoo toisin)
  const remaining = timeRemaining(company && company.protection_expires_at, now);
  if (remaining.isPast) {
    // Ei vielä ehditty vanhentaa tietokannassa (ajastin ei ole ehtinyt) -
    // näytetään silti rehellisesti vanhentuneena, ei aktiivisena.
    return { key: 'expired', label: 'Vanhentunut', color: 'gray', daysRemaining: 0, hoursRemaining: 0 };
  }
  let color = 'green';
  if (remaining.days < 3) color = 'red';
  else if (remaining.days < 14) color = 'orange';
  return {
    key: 'active', label: `Liidisuoja aktiivinen – ${remaining.days} päivää jäljellä`,
    color, daysRemaining: remaining.days, hoursRemaining: remaining.hours
  };
}

module.exports = { timeRemaining, claimDisplayStatus, CLAIM_DISPLAY };
