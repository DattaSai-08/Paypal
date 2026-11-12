import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-accounting-')), 'db.json');
process.env.PAYPAL_MODE = 'mock';
process.env.AI_PROVIDER = 'scripted';
const { store, Store } = await import('../src/store.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { addDays } = await import('../src/dates.js');
const { createHold, createDepositOrder, captureDepositOrder, requestCancellation, executeRefund, addExtra, modifyDates, markBalancePaid } = await import('../src/booking-service.js');
const { collectBalance, payVendor } = await import('../src/jobs.js');
const { mock, mockState } = await import('../src/paypal/mock.js');
const { durableOperation, operationId } = await import('../src/paypal/operations.js');
const { reconcileBooking } = await import('../src/reconciliation.js');
const { handleWebhook } = await import('../src/paypal/webhooks.js');

test.beforeEach(() => seedIfEmpty({ reset: true }));
const input = () => ({ room_id: 'room_estate_view', check_in: addDays(store.today(), 100), check_out: addDays(store.today(), 103), guests: 2, guest_name: 'Test Person', guest_email: 'test@example.com' });
async function paid() {
  const { booking } = createHold(input()); const order = await createDepositOrder(booking.id); await captureDepositOrder(booking.id, order.order_id); return store.get('bookings', booking.id);
}

test('only one process can own the data file', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/store.js')"], { cwd: process.cwd(), env: { ...process.env, DATA_FILE: store.file }, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /already in use/);
});

test('synchronous transactions persist atomically and roll back on error', () => {
  const before = store.all('payments').length;
  assert.throws(() => store.transaction(() => { store.insert('payments', { amount: 10 }); throw new Error('abort'); }));
  assert.equal(store.all('payments').length, before);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).payments.length, before);
});

test('successful operation results survive reopening the database', async () => {
  const args = ['durable-test']; let calls = 0;
  const first = await durableOperation('createOrder', args, async () => { calls++; return { id: 'known-order' }; });
  assert.equal(first.id, 'known-order');
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(saved.operations.find((o) => o.method === 'createOrder').status, 'SUCCEEDED');
  await durableOperation('createOrder', args, async () => { calls++; });
  assert.equal(calls, 1);
});

test('uncertain retries retain request IDs and stop after the safe retry window', async () => {
  const ids = []; const args = ['uncertain-test'];
  await assert.rejects(durableOperation('captureOrder', args, async () => { ids.push(operationId()); throw new Error('network lost'); }));
  await durableOperation('captureOrder', args, async () => { ids.push(operationId()); return { status: 'COMPLETED' }; });
  assert.equal(ids[0], ids[1]);
  await assert.rejects(durableOperation('captureOrder', ['old-test'], async () => { throw new Error('network lost'); }));
  const op = store.findOne('operations', (o) => o.request?.[0] === 'old-test');
  store.update('operations', op.id, { started_at: '2000-01-01T00:00:00Z' });
  await assert.rejects(durableOperation('captureOrder', ['old-test'], async () => assert.fail('must not call provider')), /reconciliation/);
});

test('concurrent cancellation and capture settle one charge and one refund', async () => {
  const { booking } = createHold(input()); const order = await createDepositOrder(booking.id);
  const results = await Promise.all([captureDepositOrder(booking.id, order.order_id), requestCancellation(booking.id)]);
  assert.equal(results[1].outcome, 'CANCELLED_REFUNDED');
  const payments = store.find('payments', (p) => p.booking_id === booking.id);
  assert.equal(payments.filter((p) => p.type === 'DEPOSIT' && p.status === 'COMPLETED').length, 1);
  assert.equal(payments.filter((p) => p.type === 'REFUND').length, 1);
});

test('lost capture response freezes cancellation, then reconciliation completes it once', async () => {
  const { booking } = createHold(input()); const order = await createDepositOrder(booking.id);
  const original = mock.captureOrder; let lost = true;
  mock.captureOrder = async (...args) => { const result = await original.apply(mock, args); if (lost) { lost = false; throw new Error('response lost'); } return result; };
  try {
    await assert.rejects(captureDepositOrder(booking.id, order.order_id));
    await assert.rejects(requestCancellation(booking.id), /reconciliation/);
    const resolved = await reconcileBooking(booking.id);
    assert.ok(resolved.deposit_paid);
    assert.equal(store.find('payments', (p) => p.booking_id === booking.id && p.type === 'DEPOSIT' && p.status === 'COMPLETED').length, 1);
  } finally { mock.captureOrder = original; }
});

test('lost refund response is retried with the same remote operation and never doubles refunds', async () => {
  const b = await paid(); const original = mock.refundCapture; let lost = true;
  mock.refundCapture = async (...args) => { const result = await original.apply(mock, args); if (lost) { lost = false; throw new Error('response lost'); } return result; };
  try {
    await assert.rejects(requestCancellation(b.id));
    await requestCancellation(b.id);
    assert.equal(mockState().captures.get(b.paypal.deposit_capture_id).refunded, b.deposit_amount);
    assert.equal(store.find('payments', (p) => p.booking_id === b.id && p.type === 'REFUND').length, 1);
  } finally { mock.refundCapture = original; }
});

test('paid or invoiced bookings cannot be edited into a second balance charge', async () => {
  const b = await paid();
  await collectBalance(b);
  assert.throws(() => addExtra(b.id, 'xp_airport_pickup'), /reconciliation/);
  assert.throws(() => modifyDates(b.id, addDays(store.today(), 101), addDays(store.today(), 104)), /reconciliation/);
  markBalancePaid(b.id, { invoice_id: store.get('bookings', b.id).paypal.invoice_id, via: 'test' });
  assert.throws(() => addExtra(b.id, 'xp_airport_pickup'), /reconciliation/);
  assert.equal((await collectBalance(b)).action, 'NOT_DUE');
});

test('missing refundable sources cannot report cancellation as refunded', async () => {
  const b = await paid();
  markBalancePaid(b.id, { invoice_id: 'unreconciled-invoice', via: 'test' });
  await assert.rejects(executeRefund(b.id, b.total, 'refund'), /capture is missing/);
  assert.equal(store.find('payments', (p) => p.booking_id === b.id && p.type === 'REFUND').length, 0);
});

test('concurrent invoice and payout requests create single provider objects', async () => {
  const b = await paid(); addExtra(b.id, 'xp_kodava_dinner', 1);
  await Promise.all([collectBalance(b), collectBalance(b)]);
  assert.equal(store.find('invoices', (i) => i.booking_id === b.id).length, 1);
  markBalancePaid(b.id, { invoice_id: store.get('bookings', b.id).paypal.invoice_id, via: 'test' });
  const item = { booking: store.get('bookings', b.id), idx: 0 };
  await Promise.all([payVendor(item), payVendor(item)]);
  assert.equal(store.find('payouts', (p) => p.booking_id === b.id).length, 1);
});

test('late capture of an expired hold is refunded without reopening inventory', async () => {
  const { booking } = createHold(input()); const order = await createDepositOrder(booking.id);
  store.update('bookings', booking.id, { status: 'EXPIRED' });
  const captured = await mock.captureOrder(order.order_id);
  const capture = captured.purchase_units[0].payments.captures[0];
  const result = await handleWebhook({}, { id: 'late-capture', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { ...capture, supplementary_data: { related_ids: { order_id: order.order_id } } } });
  assert.equal(result.ok, true);
  assert.equal(store.get('bookings', booking.id).status, 'EXPIRED');
  assert.equal(mockState().captures.get(capture.id).refunded, booking.deposit_amount);
});

test('pending refunds do not report cancellation complete and can be reconciled', async () => {
  const b = await paid(); const original = mock.refundCapture;
  mock.refundCapture = async (...args) => ({ ...await original.apply(mock, args), status: 'PENDING' });
  try {
    await assert.rejects(requestCancellation(b.id), /pending reconciliation/);
    assert.notEqual(store.get('bookings', b.id).status, 'CANCELLED');
  } finally { mock.refundCapture = original; }
  const result = await reconcileBooking(b.id);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(store.find('payments', (p) => p.booking_id === b.id && p.type === 'REFUND').length, 1);
});

test('pending payouts remain processing until the provider confirms item success', async () => {
  const b = await paid(); addExtra(b.id, 'xp_kodava_dinner', 1);
  markBalancePaid(b.id, { capture_id: 'test-balance', via: 'test' });
  const original = mock.createPayout;
  mock.createPayout = async (...args) => { const result = await original.apply(mock, args); return { ...result, batch_header: { ...result.batch_header, batch_status: 'PENDING' } }; };
  const item = { booking: b, idx: 0 };
  try { await payVendor(item); } finally { mock.createPayout = original; }
  assert.equal(store.get('bookings', b.id).extras[0].payout_status, 'PROCESSING');
  await payVendor(item);
  assert.equal(store.get('bookings', b.id).extras[0].payout_status, 'PAID');
  assert.equal(store.find('payouts', (p) => p.booking_id === b.id).length, 1);
});

test('operation intent and idempotency key survive process termination', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-restart-'));
  const file = path.join(directory, 'db.json');
  const providerFile = path.join(directory, 'provider.json');
  const code = `import fs from 'node:fs'; const { durableOperation, operationId } = await import('./src/paypal/operations.js'); await durableOperation('captureOrder', ['restart-order'], async () => { const file = process.env.TEST_PROVIDER_FILE; const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; const key = operationId(); previous[key] = true; fs.writeFileSync(file, JSON.stringify(previous)); if (process.env.TEST_CRASH === '1') process.exit(0); return { id: 'capture-recovered' }; });`;
  for (const crash of ['1', '0']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env, DATA_FILE: file, TEST_PROVIDER_FILE: providerFile, TEST_CRASH: crash }, encoding: 'utf8' });
    assert.equal(child.status, 0, 'isolated recovery process must complete');
  }
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(providerFile, 'utf8'))).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operations[0].status, 'SUCCEEDED');
});
