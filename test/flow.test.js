import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 500);
process.env.PORT = String(PORT);
process.env.BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-flow-')), 'db.json');
process.env.PAYPAL_MODE = 'mock';
process.env.AI_PROVIDER = 'scripted';
process.env.OWNER_KEY = 'test-owner-key-that-is-long-enough-12345';

const { createApp } = await import('../src/server.js');
const { store } = await import('../src/store.js');
const { addDays } = await import('../src/dates.js');

const base = process.env.BASE_URL;
const H = { 'Content-Type': 'application/json' };
let mcpAuth = H;
const post = async (p, body = {}) => { const r = await fetch(base + p, { method: 'POST', headers: p.startsWith('/api/owner') || p === '/webhooks/paypal' ? { ...H, 'x-owner-key': process.env.OWNER_KEY } : H, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, json: await r.json() }; };
const mcp = async (method, params, id = 1) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...mcpAuth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return (await r.json()).result;
};
const toolText = (res) => JSON.parse(res.content[0].text);

let server;
test.before(async () => {
  server = createApp().listen(PORT); await new Promise((r) => server.once('listening', r));
  const response = await fetch(base + '/api/session', { method: 'POST', headers: { 'x-session-bootstrap': '1' } });
  H.Cookie = response.headers.get('set-cookie').split(';')[0]; H['x-csrf-token'] = (await response.json()).csrf;
});
test.after(() => server.close());

test('guest chat books, pays deposit through PayPal order, then adds an extra', async () => {
  const today = store.today();
  const c1 = await post('/api/chat', { message: `Anything free ${addDays(today, 30)} to ${addDays(today, 33)} for 2 guests?` });
  assert.equal(c1.status, 200);
  assert.match(c1.json.reply, /Estate View Room/);
  const cid = c1.json.conversation_id;
  const c2 = await post('/api/chat', { conversation_id: cid, message: 'Estate view please, any discount?' });
  assert.match(c2.json.reply, /name for the booking/);
  const c3 = await post('/api/chat', { conversation_id: cid, message: 'Asha Menon, asha@example.com' });
  assert.ok(c3.json.payment_request?.order_id);
  assert.equal(c3.json.booking.status, 'HOLD');
  assert.equal(c3.json.booking.discount_pct, 10);
  const approve = await post('/api/mock/approve', { order_id: c3.json.payment_request.order_id });
  assert.equal(approve.json.booking.status, 'CONFIRMED');
  assert.ok(approve.json.booking.deposit_paid);
  const c4 = await post('/api/chat', { conversation_id: cid, message: 'Add a Tadiandamol trek for 2' });
  assert.match(c4.json.reply, /Added 2 x Guided Tadiandamol trek/);
  const b = store.get('bookings', c3.json.booking.id);
  assert.equal(b.extras.length, 1);
  assert.equal(b.extras[0].payout_status, 'SCHEDULED');
});

test('MCP endpoint lists tools and a second agent can hold, pay with a saved token and cancel', async () => {
  const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.serverInfo.name, 'innkeeper-property');
  const list = await mcp('tools/list', {}, 2);
  assert.ok(list.tools.some((t) => t.name === 'pay_deposit_with_token'));

  const traveler = (await post('/api/travelers', { name: 'Noor Rahman', email: 'noor@example.com', budget_total: 700 })).json;
  const setup = (await post('/api/vault/setup-token', { traveler_id: traveler.id })).json;
  await post('/api/mock/vault-approve', { setup_token_id: setup.id });
  const linked = (await post('/api/vault/payment-token', { traveler_id: traveler.id, setup_token_id: setup.id })).json;
  assert.ok(linked.linked);

  const r = await fetch(`${base}/api/traveler/run`, { method: 'POST', headers: H, body: JSON.stringify({ traveler_id: traveler.id, payment_consent: true, brief: { check_in: addDays(store.today(), 27), check_out: addDays(store.today(), 30), guests: 2, preference: 'estate view balcony' } }) });
  const events = (await r.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done?.booking?.deposit_paid, 'traveler agent should have paid the deposit');
  assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'pay_deposit_with_token'));
  assert.equal(store.get('bookings', done.booking.id).channel, 'mcp');

  const blocked = (await post('/api/travelers', { name: 'Tight Budget', email: 'tight@example.com', budget_total: 100 })).json;
  const s2 = (await post('/api/vault/setup-token', { traveler_id: blocked.id })).json;
  await post('/api/mock/vault-approve', { setup_token_id: s2.id });
  await post('/api/vault/payment-token', { traveler_id: blocked.id, setup_token_id: s2.id });
  const r2 = await fetch(`${base}/api/traveler/run`, { method: 'POST', headers: H, body: JSON.stringify({ traveler_id: blocked.id, payment_consent: true, brief: { check_in: addDays(store.today(), 27), check_out: addDays(store.today(), 30), guests: 2 } }) });
  const ev2 = (await r2.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
  assert.ok(!ev2.some((e) => e.type === 'tool_call' && e.name === 'pay_deposit_with_token'), 'governor must stop payment over budget');
  assert.match(ev2.find((e) => e.type === 'done').text, /broke the budget/);

  const cancel = toolText(await mcp('tools/call', { name: 'request_cancellation', arguments: { booking_id: done.booking.id, reason: 'plans changed' } }, 3));
  assert.equal(cancel.outcome, 'CANCELLED_REFUNDED');
  assert.equal(cancel.terms.refund_pct, 100);
  assert.equal(store.find('payments', (p) => p.booking_id === done.booking.id && p.type === 'REFUND').length, 1);
});

test('money loop: clock advance collects a vaulted balance, invoices a card guest, pays vendors, and the invoice webhook settles it', async () => {
  const today = store.today();
  const traveler = (await post('/api/travelers', { name: 'Vault Guest', email: 'vault@example.com', budget_total: 2000 })).json;
  const setup = (await post('/api/vault/setup-token', { traveler_id: traveler.id })).json;
  await post('/api/mock/vault-approve', { setup_token_id: setup.id });
  await post('/api/vault/payment-token', { traveler_id: traveler.id, setup_token_id: setup.id });
  const grant = (await post('/api/mcp-token', { traveler_id: traveler.id, payment_consent: true, max_total: 2000 })).json;
  mcpAuth = { Authorization: `Bearer ${grant.access_token}` };
  const hold = toolText(await mcp('tools/call', { name: 'create_hold', arguments: { room_id: 'room_family_suite', check_in: addDays(today, 10), check_out: addDays(today, 12), guests: 3, guest_name: 'Vault Guest', guest_email: 'vault@example.com', extras: [{ id: 'xp_kodava_dinner', qty: 2 }] } }, 4));
  const paid = toolText(await mcp('tools/call', { name: 'pay_deposit_with_token', arguments: { booking_id: hold.booking.id, payment_token_id: store.get('travelers', traveler.id).payment_token_id } }, 5));
  assert.ok(paid.booking.deposit_paid);
  mcpAuth = H;

  const cardHold = toolText(await mcp('tools/call', { name: 'create_hold', arguments: { room_id: 'room_estate_view', check_in: addDays(today, 9), check_out: addDays(today, 11), guests: 2, guest_name: 'Card Guest', guest_email: 'card@example.com' } }, 6));
  const order = toolText(await mcp('tools/call', { name: 'create_deposit_order', arguments: { booking_id: cardHold.booking.id } }, 7));
  await post('/api/mock/approve', { order_id: order.order_id });

  const clock = (await post('/api/owner/clock', { days: 12 })).json;
  const actions = Object.fromEntries(clock.report.balances.map((b) => [b.booking_id, b.action]));
  assert.equal(actions[hold.booking.id], 'VAULT_CAPTURED');
  assert.equal(actions[cardHold.booking.id], 'INVOICE_SENT');
  assert.ok(clock.report.payouts.some((p) => p.booking_id === hold.booking.id), 'dinner vendor should be paid once the date passes');
  assert.ok(store.get('bookings', hold.booking.id).balance_paid);

  const card = store.get('bookings', cardHold.booking.id);
  assert.ok(card.paypal.invoice_id);
  assert.equal(card.balance_paid, false);
  const { mock } = await import('../src/paypal/mock.js');
  await mock.markInvoicePaid(card.paypal.invoice_id);
  const wh = await post('/webhooks/paypal', { id: 'WH-TEST', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: card.paypal.invoice_id } } });
  assert.equal(wh.status, 200);
  assert.ok(store.get('bookings', cardHold.booking.id).balance_paid);
});

test('owner can resolve a refund escalation and the refund executes on PayPal', async () => {
  const today = store.today();
  const hold = toolText(await mcp('tools/call', { name: 'create_hold', arguments: { room_id: 'room_treehouse', check_in: addDays(today, 40), check_out: addDays(today, 46), guests: 2, guest_name: 'Long Stay', guest_email: 'long@example.com' } }, 8));
  const order = toolText(await mcp('tools/call', { name: 'create_deposit_order', arguments: { booking_id: hold.booking.id } }, 9));
  await post('/api/mock/approve', { order_id: order.order_id });
  assert.ok(hold.booking.deposit_amount > store.policy.refund_auto_approve_limit);
  const cancel = toolText(await mcp('tools/call', { name: 'request_cancellation', arguments: { booking_id: hold.booking.id, reason: 'visa refused' } }, 10));
  assert.equal(cancel.outcome, 'PENDING_OWNER');
  const esc = store.findOne('escalations', (e) => e.booking_id === hold.booking.id && e.status === 'OPEN');
  assert.ok(esc);
  const resolved = (await post(`/api/owner/escalations/${esc.id}`, { decision: 'APPROVE' })).json;
  assert.equal(resolved.status, 'APPROVED');
  const b = store.get('bookings', hold.booking.id);
  assert.equal(b.status, 'CANCELLED');
  assert.equal(store.find('payments', (p) => p.booking_id === b.id && p.type === 'REFUND').reduce((s, p) => s + p.amount, 0), hold.booking.deposit_amount);
});
