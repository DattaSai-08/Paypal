import { config } from '../config.js';
import { store } from '../store.js';
import { operationId } from './operations.js';

const state = Object.fromEntries(['orders', 'captures', 'refunds', 'invoices', 'payouts', 'setupTokens', 'paymentTokens', 'disputes', 'responses'].map((key) => [key, new Map(store.state.mock_paypal?.[key] || [])]));
const id = (p) => `${p}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const nowIso = () => new Date().toISOString();

export function mockState() {
  return state;
}

export const mock = {
  mode: 'mock',

  async idToken() {
    return 'mock-id-token';
  },

  async createOrder({ amount, currency, custom_id, description, reference_id }) {
    const order = {
      id: id('MOCKORD'), status: 'CREATED', intent: 'CAPTURE', create_time: nowIso(),
      purchase_units: [{ reference_id, custom_id, description, amount: { currency_code: currency, value: amount.toFixed(2) } }],
      links: [{ rel: 'approve', href: `${config.baseUrl}/mock/approve?order=`, method: 'GET' }],
    };
    order.links[0].href += order.id;
    state.orders.set(order.id, order);
    return order;
  },

  async getOrder(orderId) {
    const o = state.orders.get(orderId);
    if (!o) throw new Error(`mock order ${orderId} not found`);
    return o;
  },

  async approveOrder(orderId) {
    const o = await this.getOrder(orderId);
    o.status = 'APPROVED';
    o.payer = { email_address: 'sb-buyer@personal.example.com', name: { given_name: 'Sandbox', surname: 'Buyer' }, payer_id: 'MOCKPAYER01' };
    return o;
  },

  async captureOrder(orderId) {
    const o = await this.getOrder(orderId);
    if (o.status === 'COMPLETED') return o;
    const pu = o.purchase_units[0];
    const capture = { id: id('MOCKCAP'), status: 'COMPLETED', amount: pu.amount, final_capture: true, custom_id: pu.custom_id, create_time: nowIso() };
    state.captures.set(capture.id, { ...capture, order_id: o.id, refunded: 0 });
    o.status = 'COMPLETED';
    o.payer = o.payer || { email_address: 'sb-buyer@personal.example.com', name: { given_name: 'Sandbox', surname: 'Buyer' }, payer_id: 'MOCKPAYER01' };
    pu.payments = { captures: [capture] };
    return o;
  },

  async createOrderWithVault({ amount, currency, vault_id, custom_id, description }) {
    if (!state.paymentTokens.has(vault_id)) throw new Error(`mock vault_id ${vault_id} unknown`);
    const order = await this.createOrder({ amount, currency, custom_id, description, reference_id: custom_id });
    order.payment_source = { paypal: { vault_id } };
    return this.captureOrder(order.id);
  },

  async refundCapture(captureId, amount, note) {
    const cap = state.captures.get(captureId);
    if (!cap) throw new Error(`mock capture ${captureId} not found`);
    const value = amount ?? Number(cap.amount.value) - cap.refunded;
    cap.refunded += value;
    const refund = { id: id('MOCKREF'), status: 'COMPLETED', amount: { currency_code: cap.amount.currency_code, value: value.toFixed(2) }, links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` }], note_to_payer: note, create_time: nowIso() };
    state.refunds.set(refund.id, refund);
    return refund;
  },
  async getCapture(id) { return state.captures.get(id); },
  async getRefund(id) { return state.refunds.get(id); },

  async createInvoice(input) {
    const inv = { id: id('INV2-MOCK'), status: 'DRAFT', detail: { currency_code: input.currency, invoice_number: input.invoice_number, note: input.note, payment_term: { due_date: input.due_date } }, amount: { currency_code: input.currency, value: input.total.toFixed(2) }, primary_recipients: [{ billing_info: { email_address: input.recipient_email } }], items: input.items };
    state.invoices.set(inv.id, inv);
    return inv;
  },
  async sendInvoice(invoiceId) { const inv = state.invoices.get(invoiceId); inv.status = 'SENT'; inv.pay_url = `${config.baseUrl}/mock/pay-invoice?invoice=${invoiceId}`; return { href: inv.pay_url }; },
  async remindInvoice(invoiceId) { const inv = state.invoices.get(invoiceId); inv.reminders = (inv.reminders || 0) + 1; return { ok: true }; },
  async cancelInvoice(invoiceId) { const inv = state.invoices.get(invoiceId); inv.status = 'CANCELLED'; return { ok: true }; },
  async getInvoice(invoiceId) { return state.invoices.get(invoiceId); },
  async markInvoicePaid(invoiceId) { const inv = state.invoices.get(invoiceId); inv.status = 'PAID'; inv.payments = { paid_amount: inv.amount, transactions: [{ payment_id: id('MOCKINVPAY'), method: 'PAYPAL', amount: inv.amount }] }; return inv; },

  async createPayout({ items, batch_id }) {
    const batch = { batch_header: { payout_batch_id: id('MOCKPOB'), batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: batch_id } }, items: items.map((it) => ({ payout_item_id: id('MOCKPOI'), transaction_status: 'SUCCESS', payout_item: it })) };
    state.payouts.set(batch.batch_header.payout_batch_id, batch);
    return batch;
  },
  async getPayout(batchId) { return state.payouts.get(batchId); },

  async createSetupToken({ customer_id }) {
    const t = { id: id('MOCKSETUP'), status: 'PAYER_ACTION_REQUIRED', customer: { id: customer_id || id('MOCKCUST') }, links: [{ rel: 'approve', href: '' }] };
    t.links[0].href = `${config.baseUrl}/mock/vault?token=${t.id}`;
    state.setupTokens.set(t.id, t);
    return t;
  },
  async approveSetupToken(setupId) { const t = state.setupTokens.get(setupId); t.status = 'APPROVED'; return t; },
  async createPaymentToken(setupId) {
    const setup = state.setupTokens.get(setupId);
    if (!setup) throw new Error(`mock setup token ${setupId} unknown`);
    if (setup.status !== 'APPROVED') throw new Error('Payer approval is required before saving payment method');
    const token = { id: id('MOCKVAULT'), customer: setup.customer, payment_source: { paypal: { email_address: 'sb-traveler@personal.example.com', name: { given_name: 'Noor', surname: 'Rahman' } } } };
    state.paymentTokens.set(token.id, token);
    return token;
  },

  async listDisputes() {
    if (state.disputes.size === 0) {
      const d = { dispute_id: 'PP-D-MOCK-77421', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', status: 'WAITING_FOR_SELLER_RESPONSE', dispute_amount: { currency_code: 'USD', value: '376.32' }, create_time: nowIso(), seller_response_due_date: new Date(Date.now() + 6 * 86400000).toISOString(), disputed_transactions: [{ seller_transaction_id: 'SEED-CAP-1B', custom: null }], messages: [{ posted_by: 'BUYER', content: 'The suite was supposed to have a valley view and we got the back of the estate.' }] };
      state.disputes.set(d.dispute_id, d);
    }
    return { items: [...state.disputes.values()] };
  },
  async getDispute(disputeId) { return state.disputes.get(disputeId); },
  async provideEvidence(disputeId) { const d = state.disputes.get(disputeId); d.status = 'UNDER_REVIEW'; return { links: [{ rel: 'self', href: `mock://disputes/${disputeId}` }] }; },

  async verifyWebhook() { return true; },
};

for (const method of ['createOrder', 'captureOrder', 'approveOrder', 'createOrderWithVault', 'refundCapture', 'createInvoice', 'sendInvoice', 'cancelInvoice', 'markInvoicePaid', 'createPayout', 'createSetupToken', 'approveSetupToken', 'createPaymentToken']) {
  const execute = mock[method];
  mock[method] = async function (...args) {
    const requestId = operationId();
    const key = requestId && `${method}:${requestId}`;
    if (key && state.responses.has(key)) return structuredClone(state.responses.get(key));
    const result = await execute.apply(this, args);
    if (key) state.responses.set(key, structuredClone(result));
    store.state.mock_paypal = Object.fromEntries(Object.entries(state).map(([name, entries]) => [name, [...entries]]));
    store.save();
    return result;
  };
}
