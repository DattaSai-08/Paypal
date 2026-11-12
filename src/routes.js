import { Router } from 'express';
import { store } from './store.js';
import { config, isMockPayPal } from './config.js';
import { paypal, paypalMode, approveLink } from './paypal/index.js';
import { mock } from './paypal/mock.js';
import { chat, getConversation } from './agent/guest.js';
import { llmAvailable, modelLabel, provider as aiProvider } from './agent/llm.js';
import { runTravelerAgent } from './agent/traveler.js';
import { captureDepositOrder, resolveEscalation, bookingSummary, markBalancePaid } from './booking-service.js';
import { runJobs } from './jobs.js';
import { handleWebhook } from './paypal/webhooks.js';
import { listDisputes, buildEvidencePack, submitEvidence } from './disputes.js';
import { seedIfEmpty, defaultPolicy } from './seed.js';
import { describePolicy, policySchema } from './policy.js';
import { logAction } from './actions.js';
import { money } from './dates.js';
import { requireAuth, ownerOnly, assertOwned, issueSession } from './auth.js';
import { exclusive } from './locks.js';
import { redact } from './actions.js';
import { z } from 'zod';
import { reconcileOperation, reconcileBooking } from './reconciliation.js';

export const api = Router();

const wrap = (fn, serialize = true) => (req, res) => Promise.resolve().then(() => serialize ? exclusive(() => fn(req, res)) : fn(req, res)).catch((e) => {
  if (!res.headersSent) res.status(e.status || 400).json({ error: e.message });
});

api.use((req, res, next) => ['/property', '/webhooks/paypal'].includes(req.path) ? next() : requireAuth(req, res, next));
api.use((req, res, next) => {
  try {
    const match = req.path.match(/^\/(conversations|bookings|travelers)\/([^/]+)$/);
    if (match) assertOwned(req.auth, match[1], match[2]);
    if (req.path === '/chat' && req.body?.conversation_id) assertOwned(req.auth, 'conversations', req.body.conversation_id);
    if (/^\/(vault\/|traveler\/run)/.test(req.path)) assertOwned(req.auth, 'travelers', req.body?.traveler_id);
    if (/^\/paypal\/orders\//.test(req.path)) assertOwned(req.auth, 'bookings', req.body?.booking_id);
    if (req.path === '/mock/approve') assertOwned(req.auth, 'bookings', store.findOne('bookings', (b) => b.paypal?.deposit_order_id === req.body?.order_id)?.id);
    if (req.path === '/mock/pay-invoice') assertOwned(req.auth, 'bookings', store.findOne('bookings', (b) => b.paypal?.invoice_id === req.body?.invoice_id)?.id);
    if (req.path === '/mock/vault-approve') assertOwned(req.auth, 'travelers', store.findOne('travelers', (t) => t.setup_token_id === req.body?.setup_token_id)?.id);
    next();
  } catch (error) { res.status(error.status || 403).json({ error: 'Not found' }); }
});

api.post('/mcp-token', wrap(async (req, res) => {
  const t = req.body?.traveler_id ? assertOwned(req.auth, 'travelers', req.body.traveler_id) : null;
  const consent = req.body?.payment_consent === true;
  const maxTotal = Number(req.body?.max_total);
  if (consent && (!t?.payment_token_id || !Number.isFinite(maxTotal) || maxTotal <= 0 || maxTotal > t.budget_total)) throw new Error('A linked traveler and a valid maximum total are required for payment consent');
  const issued = issueSession({ kind: 'mcp', principalId: t?.principal_id || req.auth.principal_id, travelerId: t?.id, paymentConsent: consent, maxTotal: consent ? maxTotal : null });
  res.json({ access_token: issued.token, expires_at: issued.session.expires_at });
}));

api.get('/property', (req, res) => {
  res.json({
    today: store.today(), property: store.property, rooms: store.all('rooms'), extras: store.all('extras'), policy: store.policy, policy_text: describePolicy(),
    paypal: { mode: paypalMode(), client_id: isMockPayPal() ? null : config.paypal.clientId, currency: config.paypal.currency },
    ai: { provider: aiProvider(), model: llmAvailable() ? modelLabel() : null },
    clock: store.state.clock, base_url: config.baseUrl,
  });
});

api.post('/chat', wrap(async (req, res) => {
  const { conversation_id, message } = req.body || {};
  if (!message || typeof message !== 'string') throw new Error('message is required');
  res.json(await chat(conversation_id || null, message.slice(0, 2000), { principalId: req.auth.principal_id }));
}));

api.get('/conversations/:id', (req, res) => {
  const c = getConversation(req.params.id);
  res.json({ id: c.id, messages: c.messages, booking: c.booking_id ? bookingSummary(store.get('bookings', c.booking_id)) : null });
});

api.get('/bookings/:id', (req, res) => {
  const b = store.get('bookings', req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  return res.json({ booking: bookingSummary(b), timeline: b.timeline });
});

api.post('/paypal/orders/:orderId/capture', wrap(async (req, res) => {
  const { booking_id } = req.body || {};
  const booking = await captureDepositOrder(booking_id, req.params.orderId, 'guest');
  res.json({ booking: bookingSummary(booking) });
}));

api.get('/paypal/id-token', wrap(async (req, res) => {
  const traveler = assertOwned(req.auth, 'travelers', req.query.traveler_id);
  res.json({ id_token: await paypal.idToken(traveler.customer_id || undefined) });
}));

api.post('/travelers', wrap(async (req, res) => {
  const { name, email, budget_total, preferences } = req.body || {};
  z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), budget_total: z.number().finite().positive().max(100000) }).parse({ name, email, budget_total });
  res.json(store.insert('travelers', { principal_id: req.auth.principal_id, name, email, budget_total: money(budget_total), spent: 0, committed: 0, preferences: String(preferences || '').slice(0, 1000), payment_token_id: null, customer_id: null, bookings: [] }));
}));

api.get('/travelers/:id', (req, res) => {
  const t = store.get('travelers', req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { payment_token_id, setup_token_id, ...safe } = t;
  return res.json({ ...safe, linked: Boolean(payment_token_id) });
});

api.post('/vault/setup-token', wrap(async (req, res) => {
  const t = store.get('travelers', req.body?.traveler_id);
  if (!t) throw new Error('Traveler not found');
  const setup = await paypal.createSetupToken({ customer_id: t.customer_id || undefined, request_key: `${t.id}:${t.setup_revision || 0}` });
  store.update('travelers', t.id, { setup_token_id: setup.id });
  logAction({ actor: 'traveler_agent', tool: 'create_setup_token', args: { traveler_id: t.id }, result: `Setup token ${setup.id} ${setup.status}`, paypal_call: 'POST /v3/vault/setup-tokens' });
  res.json({ id: setup.id, status: setup.status, approve_url: approveLink(setup) });
}));

api.post('/vault/payment-token', wrap(async (req, res) => {
  const { traveler_id, setup_token_id } = req.body || {};
  const t = store.get('travelers', traveler_id);
  if (!t) throw new Error('Traveler not found');
  if (!setup_token_id || t.setup_token_id !== setup_token_id) throw new Error('Setup token does not belong to this traveler');
  const token = await paypal.createPaymentToken(setup_token_id);
  if (token.status && token.status !== 'ACTIVE') throw new Error('Payment method is not active');
  const updated = store.update('travelers', t.id, { payment_token_id: token.id, customer_id: token.customer?.id || t.customer_id, paypal_email: token.payment_source?.paypal?.email_address || null, linked_at: store.now().toISOString(), setup_token_id: null, setup_revision: (t.setup_revision || 0) + 1 });
  logAction({ actor: 'traveler_agent', tool: 'create_payment_token', args: { traveler_id: t.id }, result: `Payment token saved for ${updated.paypal_email || 'payer'}; customer ${updated.customer_id}`, paypal_call: 'POST /v3/vault/payment-tokens' });
  res.json({ linked: true, customer_id: updated.customer_id, paypal_email: updated.paypal_email });
}));

api.post('/traveler/run', wrap(async (req, res) => {
  const { traveler_id, brief } = req.body || {};
  const traveler = assertOwned(req.auth, 'travelers', traveler_id);
  if (req.body.payment_consent !== true) throw new Error('Explicit payment consent is required');
  const issued = await exclusive(() => issueSession({ kind: 'mcp', principalId: traveler.principal_id, travelerId: traveler.id, paymentConsent: true, maxTotal: traveler.budget_total }));
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await runTravelerAgent({ travelerId: traveler_id, brief: brief || {}, serverUrl: `http://127.0.0.1:${config.port}/mcp`, accessToken: issued.token, onEvent: send });
  } catch (e) {
    send({ type: 'error', text: e.message });
  }
  await exclusive(() => store.remove('sessions', issued.session.id));
  res.end();
}, false));

export const webhookHandler = wrap(async (req, res) => {
  if (isMockPayPal() && req.auth?.role !== 'owner') return res.status(401).json({ error: 'Owner authentication required for mock webhooks' });
  const result = await handleWebhook(req.headers, req.body);
  res.status(result.ok ? 200 : 400).json(result);
});
api.post('/webhooks/paypal', webhookHandler);

api.get('/owner/overview', ownerOnly, (req, res) => {
  const bookings = store.all('bookings');
  const payments = store.all('payments');
  const sum = (type) => money(payments.filter((p) => p.type === type && ['COMPLETED', 'SUCCESS'].includes(p.status)).reduce((s, p) => s + p.amount, 0));
  const today = store.today();
  const upcoming = bookings.filter((b) => b.status === 'CONFIRMED' && b.check_in >= today);
  res.json({
    today, clock: store.state.clock, policy: store.policy, policy_text: describePolicy(), property: store.property,
    kpis: {
      collected: money(sum('DEPOSIT') + sum('BALANCE')), refunded: sum('REFUND'), paid_out: sum('PAYOUT'),
      net: money(sum('DEPOSIT') + sum('BALANCE') - sum('REFUND') - sum('PAYOUT')),
      deposits_held: money(upcoming.reduce((s, b) => s + (b.deposit_paid ? b.deposit_amount : 0), 0)),
      balance_outstanding: money(upcoming.reduce((s, b) => s + (b.balance_paid ? 0 : b.balance_amount), 0)),
      confirmed_upcoming: upcoming.length, open_escalations: store.find('escalations', (e) => e.status === 'OPEN').length,
      agent_bookings: bookings.filter((b) => b.channel === 'mcp').length,
    },
    bookings: bookings.map((b) => ({ ...bookingSummary(b), channel: b.channel, source: b.source, created_at: b.created_at, vault: Boolean(b.vault_id), timeline_len: b.timeline?.length || 0 })),
    payments: [...payments].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    payouts: store.all('payouts'), invoices: store.all('invoices'),
    escalations: [...store.all('escalations')].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    actions: [...store.all('actions')].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 300),
    cashflow: cashflow(bookings),
    webhook_events: store.all('webhook_events').slice(-50), disputes_local: store.all('disputes'),
    paypal_mode: paypalMode(), ai: modelLabel(),
  });
});

api.get('/owner/booking/:id', ownerOnly, (req, res) => {
  const b = store.get('bookings', req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const conv = b.conversation_id ? store.get('conversations', b.conversation_id) : null;
  return res.json({ booking: redact(b), conversation: conv ? conv.messages : [], payments: store.find('payments', (p) => p.booking_id === b.id), actions: store.find('actions', (a) => a.booking_id === b.id) });
});

api.post('/owner/policy', ownerOnly, wrap(async (req, res) => {
  const next = { ...store.policy, ...req.body };
  next.deposit_pct = Number(next.deposit_pct); next.balance_due_days = Number(next.balance_due_days); next.refund_auto_approve_limit = Number(next.refund_auto_approve_limit); next.tax_pct = Number(next.tax_pct);
  if (req.body.discount) next.discount = { ...store.policy.discount, ...Object.fromEntries(Object.entries(req.body.discount).map(([k, v]) => [k, Number(v)])) };
  if (req.body.cancellation_tiers) next.cancellation_tiers = req.body.cancellation_tiers.map((t) => ({ min_days_before: Number(t.min_days_before), refund_pct: Number(t.refund_pct) }));
  policySchema.parse(next);
  if (next.currency !== store.policy.currency) throw new Error('Currency changes require a separate property migration');
  store.setPolicy(next);
  logAction({ actor: 'owner', tool: 'update_policy', args: req.body, result: 'Policy updated' });
  res.json({ policy: store.policy, policy_text: describePolicy() });
}));

api.post('/owner/escalations/:id', ownerOnly, wrap(async (req, res) => {
  res.json(await resolveEscalation(req.params.id, req.body?.decision === 'APPROVE' ? 'APPROVE' : 'DECLINE', req.body?.note || ''));
}));

api.post('/owner/clock', ownerOnly, wrap(async (req, res) => {
  if (!isMockPayPal()) throw new Error('Demo clock is disabled outside mock mode');
  if (!req.body?.reset && (!Number.isInteger(req.body?.days) || Math.abs(req.body.days) > 365)) throw new Error('Clock days must be an integer within 365 days');
  const clock = req.body?.reset ? store.resetClock() : store.advanceClock(Number(req.body?.days || 1));
  logAction({ actor: 'owner', tool: 'advance_clock', args: { days: req.body?.days, reset: Boolean(req.body?.reset) }, result: `Simulated date now ${store.today()}` });
  const report = await runJobs({ trigger: 'clock' });
  res.json({ clock, today: store.today(), report });
}));

api.post('/owner/run-jobs', ownerOnly, wrap(async (req, res) => res.json(await runJobs({ trigger: 'manual' }))));

api.get('/owner/operations', ownerOnly, (req, res) => res.json({ operations: store.all('operations').filter((op) => op.status !== 'SUCCEEDED').map(({ id, method, status, started_at }) => ({ id, method, status, started_at })) }));
api.post('/owner/operations/:id/reconcile', ownerOnly, wrap(async (req, res) => res.json(await reconcileOperation(req.params.id, req.body?.paypal_id))));
api.post('/owner/bookings/:id/reconcile', ownerOnly, wrap(async (req, res) => res.json({ booking: await reconcileBooking(req.params.id, req.body?.capture_id) })));

api.get('/owner/disputes', ownerOnly, wrap(async (req, res) => res.json(await listDisputes())));
api.get('/owner/disputes/:id/evidence', ownerOnly, wrap(async (req, res) => res.json(buildEvidencePack(await paypal.getDispute(req.params.id)))));
api.post('/owner/disputes/:id/evidence', ownerOnly, wrap(async (req, res) => res.json(await submitEvidence(req.params.id))));

api.post('/owner/reset-demo', ownerOnly, wrap(async (req, res) => {
  if (!isMockPayPal()) throw new Error('Demo reset is disabled outside mock mode');
  seedIfEmpty({ reset: true });
  store.setPolicy(defaultPolicy());
  res.json({ ok: true, today: store.today() });
}));

api.post('/mock/approve', wrap(async (req, res) => {
  if (!isMockPayPal()) throw new Error('Mock endpoints are disabled outside mock mode');
  const { order_id } = req.body || {};
  const booking = store.findOne('bookings', (b) => b.paypal?.deposit_order_id === order_id);
  if (!booking) throw new Error('No booking for that order');
  await mock.approveOrder(order_id);
  const updated = await captureDepositOrder(booking.id, order_id, 'mock-buyer');
  res.json({ booking: bookingSummary(updated) });
}));

api.post('/mock/vault-approve', wrap(async (req, res) => {
  if (!isMockPayPal()) throw new Error('Mock endpoints are disabled outside mock mode');
  const { setup_token_id } = req.body || {};
  await mock.approveSetupToken(setup_token_id);
  res.json({ ok: true, setup_token_id });
}));

api.post('/mock/pay-invoice', wrap(async (req, res) => {
  if (!isMockPayPal()) throw new Error('Mock endpoints are disabled outside mock mode');
  const { invoice_id } = req.body || {};
  const booking = store.findOne('bookings', (b) => b.paypal?.invoice_id === invoice_id);
  if (!booking) throw new Error('No booking for that invoice');
  await mock.markInvoicePaid(invoice_id);
  const inv = store.findOne('invoices', (i) => i.paypal_invoice_id === invoice_id);
  if (inv) store.update('invoices', inv.id, { status: 'PAID', paid_at: store.now().toISOString() });
  res.json({ booking: bookingSummary(markBalancePaid(booking.id, { invoice_id, via: 'mock invoice payment' })) });
}));

function cashflow(bookings) {
  const today = store.today();
  const weeks = [];
  for (let w = 0; w < 8; w += 1) {
    const from = new Date(Date.parse(`${today}T00:00:00Z`) + w * 7 * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${today}T00:00:00Z`) + (w + 1) * 7 * 86400000).toISOString().slice(0, 10);
    const due = bookings.filter((b) => b.status === 'CONFIRMED' && !b.balance_paid && b.balance_due_date >= from && b.balance_due_date < to).reduce((s, b) => s + b.balance_amount, 0);
    const arriving = bookings.filter((b) => b.status === 'CONFIRMED' && b.check_in >= from && b.check_in < to).length;
    weeks.push({ week_start: from, balance_due: money(due), arrivals: arriving });
  }
  return weeks;
}
