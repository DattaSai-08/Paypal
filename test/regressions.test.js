import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-regression-')), 'db.json');
process.env.AI_PROVIDER = 'scripted';
process.env.PAYPAL_MODE = 'mock';
const { store } = await import('../src/store.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { chat } = await import('../src/agent/guest.js');
const { parseDiscount } = await import('../src/agent/scripted.js');
const { runTool } = await import('../src/agent/tools.js');
const { createHold, createDepositOrder, captureDepositOrder, addExtra, resolveEscalation } = await import('../src/booking-service.js');
const { mockState } = await import('../src/paypal/mock.js');
const { handleWebhook } = await import('../src/paypal/webhooks.js');
const { config, validateConfig, isMockPayPal } = await import('../src/config.js');
const { provider } = await import('../src/agent/llm.js');
const { addDays, isIsoDate } = await import('../src/dates.js');

test.beforeEach(() => seedIfEmpty({ reset: true }));
const dates = () => `${addDays(store.today(), 100)} to ${addDays(store.today(), 103)}`;
const input = () => ({ room_id: 'room_estate_view', check_in: addDays(store.today(), 100), check_out: addDays(store.today(), 103), guests: 2, guest_name: 'Test Guest', guest_email: 'guest@example.com' });
async function heldChat() {
  return chat(null, `Estate view ${dates()} for 2 guests. Test Guest, guest@example.com. My name is Test Guest`);
}

test('discount parsing preserves decimals, zero and three digits', () => {
  assert.equal(parseDiscount('100% off'), 100);
  assert.equal(parseDiscount('12.5 percent'), 12.5);
  assert.equal(parseDiscount('no discount'), 0);
  assert.equal(parseDiscount('hello'), null);
  assert.equal(parseDiscount('-5%'), -5);
});

test('discount is quoted before contact details and can be reset to zero', async () => {
  const first = await chat(null, `Estate view ${dates()} for 2 guests, 25% off?`);
  assert.match(first.reply, /approves 10% of your requested 25%/);
  assert.match(first.reply, /owner approval/);
  assert.equal(first.booking, null);
  const second = await chat(first.conversation_id, 'no discount');
  assert.equal(store.get('conversations', first.conversation_id).slots.requested_discount_pct, 0);
  assert.doesNotMatch(second.reply, /requested 25%/);
});

test('discount after hold reprices the same booking and replaces the payment order', async () => {
  const first = await heldChat();
  const next = await chat(first.conversation_id, '25% discount');
  assert.equal(next.booking.id, first.booking.id);
  assert.equal(next.booking.discount_pct, 10);
  assert.match(next.reply, /sent to the owner/);
  assert.ok(next.booking.total < first.booking.total);
  assert.notEqual(next.payment_request.order_id, first.payment_request.order_id);
  const reset = await chat(first.conversation_id, '0% discount');
  assert.equal(reset.booking.discount_pct, 0);
  assert.equal(store.find('escalations', (e) => e.booking_id === first.booking.id && e.status === 'OPEN').length, 0);
});

test('history trimming preserves complete tool-call turns', async () => {
  const { trimHistory } = await import('../src/agent/llm.js');
  const history = [{ role: 'user', content: 'first' }, { role: 'assistant', tool_calls: [{ id: 'one' }] }, { role: 'tool', content: '{}' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'second' }, { role: 'assistant', content: 'reply' }];
  assert.deepEqual(trimHistory(history, 4), history.slice(4));
});

test('room choices are not repeated for every unrelated follow-up', async () => {
  const first = await chat(null, `${dates()} for 2 guests`);
  assert.match(first.reply, /we have:/);
  const next = await chat(first.conversation_id, 'Tell me more');
  assert.match(next.reply, /Which room/);
  assert.doesNotMatch(next.reply, /we have:/);
});

test('policy, thanks and concurrent payment retries keep a single hold and order', async () => {
  const first = await heldChat();
  assert.ok(first.payment_request);
  const count = store.all('bookings').length;
  const policy = await chat(first.conversation_id, 'What is the cancellation policy?');
  assert.match(policy.reply, /Cancellation:/);
  assert.equal(store.get('bookings', first.booking.id).status, 'HOLD');
  await chat(first.conversation_id, 'thanks');
  const retries = await Promise.all([chat(first.conversation_id, 'pay deposit'), chat(first.conversation_id, 'pay deposit')]);
  assert.ok(retries.every((r) => r.payment_request.order_id === first.payment_request.order_id));
  assert.equal(store.all('bookings').length, count);
  assert.equal(store.find('payments', (p) => p.booking_id === first.booking.id).length, 1);
});

test('cancelled booking is cleared on next turn without silently creating a replacement', async () => {
  const first = await heldChat();
  await chat(first.conversation_id, 'cancel my booking');
  const next = await chat(first.conversation_id, 'hello');
  assert.equal(next.booking, null);
  assert.equal(store.get('conversations', first.conversation_id).booking_id, null);
});

test('party size and checkout can be collected on separate turns', async () => {
  const first = await chat(null, `Estate view ${addDays(store.today(), 100)}`);
  const second = await chat(first.conversation_id, addDays(store.today(), 103));
  assert.match(second.reply, /How many guests/);
  const third = await chat(first.conversation_id, '2 guests');
  assert.match(third.reply, /total/);
});

test('capture rejects expired or cancelled holds before charging', async () => {
  for (const status of ['EXPIRED', 'CANCELLED']) {
    const { booking } = createHold(input());
    const order = await createDepositOrder(booking.id);
    store.update('bookings', booking.id, { status });
    await assert.rejects(captureDepositOrder(booking.id, order.order_id), /not on hold/);
    assert.equal(mockState().orders.get(order.order_id).status, 'CREATED');
  }
});

test('capture rejects amount, currency and cross-booking mismatches', async () => {
  const { booking } = createHold(input());
  const order = await createDepositOrder(booking.id);
  await assert.rejects(captureDepositOrder(booking.id, 'wrong-order'), /does not belong/);
  mockState().orders.get(order.order_id).purchase_units[0].amount.value = '0.01';
  await assert.rejects(captureDepositOrder(booking.id, order.order_id), /does not match/);
  assert.equal(store.get('bookings', booking.id).deposit_paid, false);
});

test('concurrent order creation and capture are idempotent', async () => {
  const { booking } = createHold(input());
  const orders = await Promise.all([createDepositOrder(booking.id), createDepositOrder(booking.id)]);
  assert.equal(orders[0].order_id, orders[1].order_id);
  await Promise.all(orders.map((o) => captureDepositOrder(booking.id, o.order_id)));
  assert.equal(store.find('payments', (p) => p.booking_id === booking.id && p.status === 'COMPLETED').length, 1);
});

test('price changes invalidate old payment orders', async () => {
  const { booking } = createHold(input());
  const oldOrder = await createDepositOrder(booking.id);
  addExtra(booking.id, 'xp_airport_pickup');
  await assert.rejects(captureDepositOrder(booking.id, oldOrder.order_id), /does not belong/);
  const next = await createDepositOrder(booking.id);
  assert.notEqual(next.order_id, oldOrder.order_id);
  assert.ok(next.amount > oldOrder.amount);
});

test('owner-approved discount invalidates stale order', async () => {
  const { booking } = createHold({ ...input(), requested_discount_pct: 25 });
  const order = await createDepositOrder(booking.id);
  const escalation = store.findOne('escalations', (e) => e.booking_id === booking.id);
  await resolveEscalation(escalation.id, 'APPROVE');
  await assert.rejects(captureDepositOrder(booking.id, order.order_id), /does not belong/);
  assert.equal(store.get('bookings', booking.id).discount_pct, 25);
});

test('guest tools cannot read or cancel another conversation booking', async () => {
  const { booking } = createHold({ ...input(), conversation_id: 'other-conversation' });
  for (const name of ['get_booking', 'request_cancellation']) {
    const out = await runTool(name, { booking_id: booking.id }, { actor: 'guest_agent', conversation_id: 'attacker' });
    assert.match(out.error, /not part of this conversation/);
  }
  assert.equal(store.get('bookings', booking.id).status, 'HOLD');
});

test('webhook validates amount and order and deduplicates successful events', async () => {
  const { booking } = createHold(input());
  const order = await createDepositOrder(booking.id);
  const event = { id: 'webhook-test', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'capture-test', status: 'COMPLETED', custom_id: booking.id, amount: { value: '0.01', currency_code: booking.currency }, supplementary_data: { related_ids: { order_id: order.order_id } } } };
  assert.equal((await handleWebhook({}, event)).ok, false);
  event.resource.amount.value = String(booking.deposit_amount);
  assert.equal((await handleWebhook({}, event)).ok, true);
  assert.equal((await handleWebhook({}, event)).duplicate, true);
});

test('invalid dates and numeric inputs are rejected at service boundary', () => {
  assert.equal(isIsoDate('2027-02-30'), false);
  for (const guests of [0, -1, 1.5, NaN]) assert.throws(() => createHold({ ...input(), guests }));
  for (const requested_discount_pct of [-1, 101, NaN]) assert.throws(() => createHold({ ...input(), requested_discount_pct }));
});

test('blank model keys use scripted mode and non-mock PayPal cannot silently fall back', () => {
  const oldAi = { ...config.ai }; const oldPaypal = { ...config.paypal };
  try {
    Object.assign(config.ai, { provider: 'auto', anthropicKey: '', openaiKey: '' });
    assert.equal(provider(), 'scripted');
    Object.assign(config.paypal, { mode: 'sandbox', clientId: '', clientSecret: '' });
    assert.equal(isMockPayPal(), false);
    assert.throws(validateConfig, /credentials are required/);
  } finally { Object.assign(config.ai, oldAi); Object.assign(config.paypal, oldPaypal); }
});
