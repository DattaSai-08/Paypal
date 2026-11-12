import { store } from '../store.js';
import { paypal } from './index.js';
import { markBalancePaid, captureDepositOrder, validateCapture, settleDepositWebhook } from '../booking-service.js';
import { logAction, timeline } from '../actions.js';
import { isMockPayPal } from '../config.js';
import { exclusive } from '../locks.js';

export function handleWebhook(headers, event) { return exclusive(() => handleWebhookOnce(headers, event)); }
async function handleWebhookOnce(headers, event) {
  if (!event?.id || typeof event.id !== 'string' || !event.event_type) return { ok: false, reason: 'Invalid event' };
  const verified = isMockPayPal() ? true : await paypal.verifyWebhook(headers, event).catch(() => false);
  if (verified && event?.id && store.findOne('webhook_events', (e) => e.event_id === event.id && e.verified && e.handled)) return { ok: true, duplicate: true };
  const record = store.insert('webhook_events', { event_id: event?.id, event_type: event?.event_type, verified, resource_id: event.event_type.startsWith('VAULT.') ? null : event?.resource?.id });
  if (!verified) {
    logAction({ actor: 'system', tool: 'webhook', args: { event_type: event?.event_type }, result: 'Signature verification failed; ignored', ok: false });
    return { ok: false, reason: 'unverified' };
  }
  const type = event?.event_type;
  const resource = event?.resource || {};
  try {
    if (type === 'CHECKOUT.ORDER.APPROVED') {
      const booking = findBookingForOrder(resource.id, resource);
      if (booking && !booking.deposit_paid) await captureDepositOrder(booking.id, resource.id, 'webhook');
    }
    if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      const bookingId = (resource.custom_id || '').replace(/-BAL$/, '');
      const booking = store.get('bookings', bookingId);
      if (booking) {
        const balance = (resource.custom_id || '').endsWith('-BAL');
        validateCapture(booking, resource, balance ? booking.balance_amount : booking.deposit_amount);
        const orderId = resource.supplementary_data?.related_ids?.order_id;
        if (balance) {
          if (!booking.deposit_paid || booking.status !== 'CONFIRMED' || !orderId || orderId !== booking.paypal?.balance_order_id) throw new Error('Balance capture does not match booking order');
          markBalancePaid(booking.id, { capture_id: resource.id, via: 'webhook' });
        } else {
          if (!orderId || orderId !== booking.paypal?.deposit_order_id) throw new Error('Deposit capture does not match booking order');
          await settleDepositWebhook(booking.id, resource, orderId);
        }
      }
    }
    if (type === 'PAYMENT.CAPTURE.REFUNDED') {
      const booking = store.findOne('bookings', (b) => [b.paypal?.deposit_capture_id, b.paypal?.balance_capture_id].includes(resource?.links?.find((l) => l.rel === 'up')?.href?.split('/').pop()));
      if (booking) timeline(booking.id, `PayPal confirmed refund ${resource.id}`);
    }
    if (type === 'INVOICING.INVOICE.PAID') {
      const invoiceId = resource?.invoice?.id || resource?.id;
      const booking = store.findOne('bookings', (b) => b.paypal?.invoice_id === invoiceId);
      if (booking) {
        const invoice = await paypal.getInvoice(invoiceId);
        const paid = invoice?.payments?.paid_amount;
        if (invoice?.status !== 'PAID' || paid?.currency_code !== booking.currency || Number(paid?.value) !== booking.balance_amount) throw new Error('Invoice payment does not match outstanding balance');
        markBalancePaid(booking.id, { invoice_id: invoiceId, via: 'invoice webhook' });
        const inv = store.findOne('invoices', (i) => i.paypal_invoice_id === invoiceId);
        if (inv) store.update('invoices', inv.id, { status: 'PAID', paid_at: store.now().toISOString() });
      }
    }
    if (type === 'CUSTOMER.DISPUTE.CREATED' || type === 'CUSTOMER.DISPUTE.UPDATED') {
      store.insert('disputes', { dispute_id: resource.dispute_id, status: resource.status, reason: resource.reason, amount: resource.dispute_amount, raw: resource });
    }
    if (type === 'VAULT.PAYMENT-TOKEN.CREATED') {
      logAction({ actor: 'system', tool: 'webhook', args: { event_type: type }, result: 'Payment token created' });
    }
    store.update('webhook_events', record.id, { handled: true });
    return { ok: true };
  } catch (e) {
    store.update('webhook_events', record.id, { handled: false, error: e.message });
    logAction({ actor: 'system', tool: 'webhook', args: { event_type: type }, result: e.message, ok: false });
    return { ok: false, reason: e.message };
  }
}

function findBookingForOrder(orderId, resource) {
  const custom = resource?.purchase_units?.[0]?.custom_id;
  return (custom && store.get('bookings', custom)) || store.findOne('bookings', (b) => b.paypal?.deposit_order_id === orderId);
}
