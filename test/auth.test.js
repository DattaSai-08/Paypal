import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-auth-')), 'db.json');
process.env.PAYPAL_MODE = 'mock';
process.env.AI_PROVIDER = 'scripted';
process.env.OWNER_KEY = 'test-owner-secret-longer-than-thirty-two-characters';
const { createApp } = await import('../src/server.js');
const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { addDays } = await import('../src/dates.js');
let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; config.baseUrl = base; });
test.after(() => server.close());
async function request(url, body, headers = {}) {
  const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
async function session() {
  const r = await request('/api/session', {}, { 'x-session-bootstrap': '1' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  return { Cookie: r.headers.get('set-cookie').split(';')[0], 'x-csrf-token': r.body.csrf };
}
async function hold(headers) {
  const dates = `${addDays(store.today(), 150)} to ${addDays(store.today(), 152)}`;
  const first = await request('/api/chat', { message: `Estate view ${dates} for 2 guests` }, headers);
  const result = await request('/api/chat', { conversation_id: first.body.conversation_id, message: 'Test Person, test@example.com' }, headers);
  assert.equal(result.status, 200); assert.ok(result.body.booking);
  return result.body;
}
const mcp = (headers, name, args) => request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { ...headers, Accept: 'application/json, text/event-stream' });

test('private APIs require authentication; CSRF and cross-origin requests are rejected', async () => {
  assert.equal((await request('/api/chat', { message: 'hello' })).status, 401);
  assert.equal((await request('/mcp', {})).status, 401);
  assert.equal((await request('/api/session', {}, { 'x-session-bootstrap': '1', Origin: 'https://attacker.example' })).status, 403);
  const h = await session();
  assert.equal((await request('/api/chat', { message: 'hello' }, { Cookie: h.Cookie })).status, 403);
  assert.equal((await request('/api/session', {}, { Cookie: h.Cookie, 'x-session-bootstrap': '1' })).status, 200, 'page reload can refresh CSRF token');
});

test('another session cannot read, chat with, pay or cancel a booking', async () => {
  const a = await session(); const b = await session(); const booking = await hold(a);
  assert.equal((await request(`/api/conversations/${booking.conversation_id}`, undefined, b)).status, 404);
  assert.equal((await request(`/api/bookings/${booking.booking.id}`, undefined, b)).status, 404);
  assert.equal((await request('/api/chat', { conversation_id: booking.conversation_id, message: 'cancel' }, b)).status, 404);
  assert.equal((await request(`/api/paypal/orders/${booking.payment_request.order_id}/capture`, { booking_id: booking.booking.id }, b)).status, 404);
  const out = await mcp(b, 'request_cancellation', { booking_id: booking.booking.id });
  assert.ok(out.body.result.isError);
  assert.equal(store.get('bookings', booking.booking.id).status, 'HOLD');
});

test('travelers, vault exchange and identity tokens are bound to a session', async () => {
  const a = await session(); const b = await session();
  const t = (await request('/api/travelers', { name: 'Test Person', email: 'vault@example.com', budget_total: 1000 }, a)).body;
  assert.equal((await request(`/api/travelers/${t.id}`, undefined, b)).status, 404);
  assert.equal((await request('/api/vault/setup-token', { traveler_id: t.id }, b)).status, 404);
  assert.equal((await request(`/api/paypal/id-token?traveler_id=${t.id}`, undefined, b)).status, 404);
  const setup = (await request('/api/vault/setup-token', { traveler_id: t.id }, a)).body;
  assert.equal((await request('/api/vault/payment-token', { traveler_id: t.id, setup_token_id: setup.id }, a)).status, 400, 'unapproved tokens cannot be linked');
  assert.equal((await request('/api/traveler/run', { traveler_id: t.id }, a)).status, 400, 'payment consent is mandatory');
});

test('MCP grants cannot mint credentials or call browser APIs; payment requires a grant', async () => {
  const h = await session();
  const grant = (await request('/api/mcp-token', {}, h)).body;
  const bearer = { Authorization: `Bearer ${grant.access_token}` };
  assert.equal((await request('/api/mcp-token', { payment_consent: true }, bearer)).status, 403);
  assert.equal((await request('/api/session', {}, { ...bearer, 'x-session-bootstrap': '1' })).status, 403);
  const out = await mcp(bearer, 'pay_deposit_with_token', { booking_id: 'unknown', payment_token_id: 'test-token' });
  assert.ok(out.body.result.isError);
});

test('owner keys in URLs and default credentials do not authorize administration', async () => {
  assert.equal((await request('/api/owner/overview?key=owner-demo-key')).status, 401);
  assert.equal((await request('/api/owner/overview', undefined, { 'x-owner-key': 'owner-demo-key' })).status, 401);
  const owner = { 'x-owner-key': process.env.OWNER_KEY };
  assert.equal((await request('/api/owner/overview', undefined, owner)).status, 200);
  assert.equal((await request('/api/owner/policy', { deposit_pct: -1 }, owner)).status, 400);
  assert.equal((await request('/api/owner/policy', { unexpected: 'field' }, owner)).status, 400);
  assert.equal((await request('/webhooks/paypal', { id: 'forged', event_type: 'PAYMENT.CAPTURE.COMPLETED' })).status, 401);
});

test('logout revokes the browser credential and all delegated grants', async () => {
  const h = await session();
  const grant = (await request('/api/mcp-token', {}, h)).body;
  assert.equal((await request('/api/logout', {}, h)).status, 200);
  assert.equal((await request('/api/chat', { message: 'hello' }, h)).status, 401);
  assert.equal((await mcp({ Authorization: `Bearer ${grant.access_token}` }, 'get_property_info', {})).status, 401);
});

test('payment grants are limited to one traveler, one booking, and the consented budget', async () => {
  const h = await session();
  const traveler = (await request('/api/travelers', { name: 'Grant Guest', email: 'grant@example.com', budget_total: 2000 }, h)).body;
  const setup = (await request('/api/vault/setup-token', { traveler_id: traveler.id }, h)).body;
  await request('/api/mock/vault-approve', { setup_token_id: setup.id }, h);
  await request('/api/vault/payment-token', { traveler_id: traveler.id, setup_token_id: setup.id }, h);
  const grant = (await request('/api/mcp-token', { traveler_id: traveler.id, payment_consent: true, max_total: 2000 }, h)).body;
  const auth = { Authorization: `Bearer ${grant.access_token}` };
  const call = async (name, args) => JSON.parse((await mcp(auth, name, args)).body.result.content[0].text);
  const make = async (day) => call('create_hold', { room_id: 'room_family_suite', check_in: addDays(store.today(), day), check_out: addDays(store.today(), day + 2), guests: 2, guest_name: traveler.name, guest_email: traveler.email });
  const first = await make(210); const second = await make(220);
  const paid = await call('pay_deposit_with_token', { booking_id: first.booking.id });
  assert.equal(paid.booking.deposit_paid, true, 'server resolves saved token without exposing it to the agent');
  assert.match((await call('pay_deposit_with_token', { booking_id: second.booking.id })).error, /already belongs/);
  const consent = (await request('/api/mcp-token', { traveler_id: traveler.id, payment_consent: true, max_total: 10 }, h)).body;
  const blocked = await mcp({ Authorization: `Bearer ${consent.access_token}` }, 'pay_deposit_with_token', { booking_id: second.booking.id });
  assert.match(JSON.parse(blocked.body.result.content[0].text).error, /maximum total/);
  const cancelled = await call('request_cancellation', { booking_id: first.booking.id });
  assert.equal(cancelled.outcome, 'CANCELLED_REFUNDED');
  assert.equal(store.get('travelers', traveler.id).committed, 0);
  assert.equal(store.get('travelers', traveler.id).spent, 0);
});
