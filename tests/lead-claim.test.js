// Yksikkötestit liidisuojan näyttölogiikalle (crm/lib/leadClaim.js).
// Aja: node --test tests/lead-claim.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { timeRemaining, claimDisplayStatus } = require('../crm/lib/leadClaim');

test('timeRemaining: laskee 90 vrk esimerkin mukaisesti (spesifikaation esimerkki)', () => {
  const r = timeRemaining('2026-11-22T14:30:00Z', '2026-08-24T14:30:00Z');
  assert.equal(r.days, 90);
  assert.equal(r.isPast, false);
});

test('timeRemaining: mennyt aika -> isPast true', () => {
  const r = timeRemaining('2026-08-01T00:00:00Z', '2026-08-24T00:00:00Z');
  assert.equal(r.isPast, true);
});

test('timeRemaining: puuttuva päättymisaika -> isPast true, ei kaadu', () => {
  const r = timeRemaining(null);
  assert.equal(r.isPast, true);
  assert.equal(r.totalMs, 0);
});

test('claimDisplayStatus: aktiivinen, >14pv jäljellä -> vihreä', () => {
  const status = claimDisplayStatus({ claim_status: 'active', protection_expires_at: '2026-09-30T00:00:00Z' }, '2026-08-24T00:00:00Z');
  assert.equal(status.color, 'green');
  assert.equal(status.key, 'active');
});

test('claimDisplayStatus: <14pv jäljellä -> oranssi', () => {
  const status = claimDisplayStatus({ claim_status: 'active', protection_expires_at: '2026-09-01T00:00:00Z' }, '2026-08-24T00:00:00Z');
  assert.equal(status.color, 'orange');
});

test('claimDisplayStatus: <3pv jäljellä -> punainen', () => {
  const status = claimDisplayStatus({ claim_status: 'active', protection_expires_at: '2026-08-26T00:00:00Z' }, '2026-08-24T00:00:00Z');
  assert.equal(status.color, 'red');
});

test('claimDisplayStatus: claim_status=expired -> harmaa, riippumatta ajasta', () => {
  const status = claimDisplayStatus({ claim_status: 'expired', protection_expires_at: '2026-12-01T00:00:00Z' }, '2026-08-24T00:00:00Z');
  assert.equal(status.color, 'gray');
  assert.equal(status.key, 'expired');
});

test('claimDisplayStatus: claim_status=converted_to_customer -> sininen', () => {
  const status = claimDisplayStatus({ claim_status: 'converted_to_customer' });
  assert.equal(status.color, 'blue');
});

test('claimDisplayStatus: claim_status=released -> harmaa', () => {
  const status = claimDisplayStatus({ claim_status: 'released' });
  assert.equal(status.color, 'gray');
});

test('claimDisplayStatus: active mutta päättymisaika jo mennyt (ajastin ei ehtinyt) -> silti vanhentunut, ei aktiivinen', () => {
  const status = claimDisplayStatus({ claim_status: 'active', protection_expires_at: '2026-01-01T00:00:00Z' }, '2026-08-24T00:00:00Z');
  assert.equal(status.key, 'expired');
});
