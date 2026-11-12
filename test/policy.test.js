import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-policy-')), 'db.json');
process.env.PAYPAL_MODE = 'mock';
process.env.AI_PROVIDER = 'scripted';

const { store } = await import('../src/store.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { quoteStay, approveDiscount, cancellationTerms } = await import('../src/policy.js');
const { addDays } = await import('../src/dates.js');

seedIfEmpty({ reset: true });
const today = store.today();
const room = store.get('rooms', 'room_estate_view');

test('quote applies nights, tax and deposit split', () => {
  const q = quoteStay({ room, check_in: addDays(today, 30), check_out: addDays(today, 33), guests: 2 });
  assert.equal(q.nights, 3);
  assert.equal(q.room_subtotal, 285);
  assert.equal(q.tax, 34.2);
  assert.equal(q.total, 319.2);
  assert.equal(q.deposit, 95.76);
  assert.equal(Math.round((q.deposit + q.balance) * 100) / 100, q.total);
});

test('peak periods raise nightly rates', () => {
  const q = quoteStay({ room, check_in: '2026-12-24', check_out: '2026-12-26', guests: 2 });
  assert.ok(q.has_peak_nights);
  assert.equal(q.nightly[0].rate, 128.25);
});

test('discount governor follows night and lead-time thresholds and peak cap', () => {
  const far = approveDiscount({ requested_pct: 10, nights: 2, check_in: addDays(today, 40), has_peak_nights: false });
  assert.equal(far.approved_pct, 10);
  const soon = approveDiscount({ requested_pct: 10, nights: 2, check_in: addDays(today, 3), has_peak_nights: false });
  assert.equal(soon.approved_pct, 0);
  assert.ok(soon.needs_owner);
  const peak = approveDiscount({ requested_pct: 10, nights: 4, check_in: addDays(today, 40), has_peak_nights: true });
  assert.equal(peak.approved_pct, 5);
  const over = approveDiscount({ requested_pct: 25, nights: 4, check_in: addDays(today, 40), has_peak_nights: false });
  assert.equal(over.approved_pct, 10);
  assert.ok(over.needs_owner);
});

test('cancellation tiers and auto-approve limit', () => {
  const base = { check_in: addDays(today, 20), deposit_amount: 100, balance_amount: 200, deposit_paid: true, balance_paid: false };
  const t1 = cancellationTerms(base);
  assert.equal(t1.refund_pct, 100);
  assert.equal(t1.refund_amount, 100);
  assert.ok(t1.auto_approve);
  const t2 = cancellationTerms({ ...base, check_in: addDays(today, 10), balance_paid: true });
  assert.equal(t2.refund_pct, 50);
  assert.equal(t2.refund_amount, 150);
  const t3 = cancellationTerms({ ...base, check_in: addDays(today, 2) });
  assert.equal(t3.refund_pct, 0);
  const big = cancellationTerms({ ...base, deposit_amount: 300, balance_amount: 700, balance_paid: true });
  assert.equal(big.auto_approve, false);
});
