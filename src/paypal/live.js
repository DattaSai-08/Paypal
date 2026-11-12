import { config } from '../config.js';
import { request, requestId, idToken as oauthIdToken } from './client.js';
import { textToPdf } from '../pdf.js';

const purchaseUnit = ({ amount, currency, custom_id, description, reference_id, invoice_id }) => ({
  reference_id: reference_id || custom_id,
  custom_id,
  invoice_id,
  description: description?.slice(0, 127),
  amount: { currency_code: currency, value: amount.toFixed(2) },
});

export const live = {
  mode: config.paypal.mode,

  idToken(customerId) {
    return oauthIdToken(customerId);
  },

  async createOrder(input) {
    const body = {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit(input)],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: config.paypal.brandName,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${config.baseUrl}/paypal/return?booking=${encodeURIComponent(input.custom_id)}`,
            cancel_url: `${config.baseUrl}/paypal/cancel?booking=${encodeURIComponent(input.custom_id)}`,
          },
        },
      },
    };
    const { json } = await request('create order', 'POST', '/v2/checkout/orders', body, { 'PayPal-Request-Id': requestId(input.custom_id) });
    return json;
  },

  async getOrder(orderId) {
    const { json } = await request('get order', 'GET', `/v2/checkout/orders/${orderId}`);
    return json;
  },

  async captureOrder(orderId) {
    const { json } = await request('capture order', 'POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'PayPal-Request-Id': requestId(`cap-${orderId}`) });
    return json;
  },

  async getCapture(id) { return (await request('get capture', 'GET', `/v2/payments/captures/${encodeURIComponent(id)}`)).json; },
  async getRefund(id) { return (await request('get refund', 'GET', `/v2/payments/refunds/${encodeURIComponent(id)}`)).json; },

  async createOrderWithVault(input) {
    const body = {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit(input)],
      payment_source: { paypal: { vault_id: input.vault_id } },
    };
    const { json } = await request('create vaulted order', 'POST', '/v2/checkout/orders', body, { 'PayPal-Request-Id': requestId(`vault-${input.custom_id}`) });
    return json;
  },

  async refundCapture(captureId, amount, note) {
    const body = { note_to_payer: note?.slice(0, 255) };
    if (amount !== undefined) body.amount = { currency_code: config.paypal.currency, value: amount.toFixed(2) };
    const { json } = await request('refund', 'POST', `/v2/payments/captures/${captureId}/refund`, body, { 'PayPal-Request-Id': requestId(`ref-${captureId}`) });
    return json;
  },

  async createInvoice(input) {
    const body = {
      detail: {
        currency_code: input.currency,
        invoice_number: input.invoice_number,
        reference: input.reference,
        note: input.note,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: input.due_date },
      },
      invoicer: { business_name: config.paypal.brandName },
      primary_recipients: [{ billing_info: { name: { full_name: input.recipient_name }, email_address: input.recipient_email } }],
      items: input.items.map((it) => ({ name: it.name, quantity: String(it.qty || 1), unit_amount: { currency_code: input.currency, value: it.price.toFixed(2) }, unit_of_measure: 'AMOUNT' })),
      configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
    };
    const { json, headers } = await request('create invoice', 'POST', '/v2/invoicing/invoices', body, { 'PayPal-Request-Id': requestId(`inv-${input.invoice_number}`) });
    const href = json?.href || json?.links?.find((l) => l.rel === 'self')?.href || headers.get('location') || '';
    const id = json?.id || href.split('/').pop();
    return { id, ...json };
  },

  async sendInvoice(invoiceId) {
    const { json } = await request('send invoice', 'POST', `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true, send_to_invoicer: false });
    const inv = await this.getInvoice(invoiceId).catch(() => null);
    return { href: inv?.detail?.metadata?.recipient_view_url || json?.href || null, status: inv?.status || 'SENT' };
  },

  async remindInvoice(invoiceId, note) {
    const { json } = await request('remind invoice', 'POST', `/v2/invoicing/invoices/${invoiceId}/remind`, { subject: 'Balance for your stay is due', note, send_to_recipient: true });
    return json || { ok: true };
  },

  async cancelInvoice(invoiceId) {
    const { json } = await request('cancel invoice', 'POST', `/v2/invoicing/invoices/${invoiceId}/cancel`, { send_to_recipient: true, send_to_invoicer: false });
    return json || { ok: true };
  },

  async getInvoice(invoiceId) {
    const { json } = await request('get invoice', 'GET', `/v2/invoicing/invoices/${invoiceId}`);
    return json;
  },

  async createPayout({ items, batch_id, subject }) {
    const body = {
      sender_batch_header: { sender_batch_id: batch_id, email_subject: subject || 'Payout from Cinnamon Ridge Stays' },
      items: items.map((it) => ({
        recipient_type: 'EMAIL', receiver: it.email, note: it.note, sender_item_id: it.sender_item_id,
        amount: { value: it.amount.toFixed(2), currency: it.currency },
      })),
    };
    const { json } = await request('create payout', 'POST', '/v1/payments/payouts', body, { 'PayPal-Request-Id': requestId(`po-${batch_id}`) });
    return json;
  },

  async getPayout(batchId) {
    const { json } = await request('get payout', 'GET', `/v1/payments/payouts/${batchId}`);
    return json;
  },

  async createSetupToken({ customer_id }) {
    const body = {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          usage_pattern: 'IMMEDIATE',
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: config.paypal.brandName,
            shipping_preference: 'NO_SHIPPING',
            return_url: `${config.baseUrl}/traveler?vault=approved`,
            cancel_url: `${config.baseUrl}/traveler?vault=cancelled`,
          },
        },
      },
    };
    if (customer_id) body.customer = { id: customer_id };
    const { json } = await request('create setup token', 'POST', '/v3/vault/setup-tokens', body, { 'PayPal-Request-Id': requestId('setup') });
    return json;
  },

  async createPaymentToken(setupTokenId) {
    const { json } = await request('create payment token', 'POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }, { 'PayPal-Request-Id': requestId(`pt-${setupTokenId}`) });
    return json;
  },

  async listDisputes() {
    const { json } = await request('list disputes', 'GET', '/v1/customer/disputes?page_size=20');
    return json;
  },

  async getDispute(disputeId) {
    const { json } = await request('get dispute', 'GET', `/v1/customer/disputes/${disputeId}`);
    return json;
  },

  async provideEvidence(disputeId, { note, evidenceText }) {
    const form = new FormData();
    const pdf = textToPdf(evidenceText, { title: `Evidence for ${disputeId}` });
    form.append('input', new Blob([JSON.stringify({ evidences: [{ evidence_type: 'OTHER', notes: note.slice(0, 2000), documents: [{ name: 'innkeeper-evidence.pdf' }] }] })], { type: 'application/json' }));
    form.append('file1', new Blob([pdf], { type: 'application/pdf' }), 'innkeeper-evidence.pdf');
    const { json } = await request('provide evidence', 'POST', `/v1/customer/disputes/${disputeId}/provide-evidence`, form);
    return json;
  },

  async verifyWebhook(headers, event) {
    if (!config.paypal.webhookId) return false;
    const body = {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    };
    const { json } = await request('verify webhook', 'POST', '/v1/notifications/verify-webhook-signature', body);
    return json?.verification_status === 'SUCCESS';
  },
};
