import { store } from './store.js';
import { paypal } from './paypal/index.js';
import { exclusive } from './locks.js';
import { captureDepositOrder, payDepositWithToken, validateCapture, markBalancePaid, requestCancellation, bookingSummary } from './booking-service.js';
import { collectBalance } from './jobs.js';

// Recovery never trusts an owner's assertion that a payment succeeded.
// Every supplied provider ID is fetched and matched to the persisted intent.
export function reconcileOperation(id, paypalId) {
  return exclusive(async () => {
    const op = store.get('operations', id);
    if (!op || op.status === 'SUCCEEDED') throw new Error('Unresolved operation not found');
    const args = op.request;
    if (!args) throw new Error('Operation has no durable request to verify');
    let result;
    if (['createOrder', 'createOrderWithVault', 'captureOrder'].includes(op.method)) {
      result = await paypal.getOrder(op.method === 'captureOrder' ? args[0] : paypalId);
      if (op.method === 'captureOrder') {
        if (result?.id !== args[0] || result.status !== 'COMPLETED') throw new Error('Capture is not completed');
      } else {
        const unit = result?.purchase_units?.[0]; const expected = args[0];
        if (!unit || unit.custom_id !== expected.custom_id || unit.amount?.currency_code !== expected.currency || Number(unit.amount?.value) !== expected.amount) throw new Error('Order does not match operation');
      }
    } else if (op.method === 'refundCapture') {
      result = await paypal.getRefund(paypalId);
      if (!result?.id || !['COMPLETED', 'PENDING'].includes(result.status) || Number(result.amount?.value) !== args[1] || result.links?.find((link) => link.rel === 'up')?.href?.split('/').pop() !== args[0]) throw new Error('Refund does not match operation');
    } else if (op.method === 'createInvoice') {
      result = await paypal.getInvoice(paypalId);
      const expected = args[0];
      if (result?.detail?.invoice_number !== expected.invoice_number || result.amount?.currency_code !== expected.currency || Number(result.amount?.value) !== expected.total) throw new Error('Invoice does not match operation');
    } else if (op.method === 'createPayout') {
      result = await paypal.getPayout(paypalId);
      if (result?.batch_header?.sender_batch_header?.sender_batch_id !== args[0].batch_id) throw new Error('Payout does not match operation');
    } else if (['sendInvoice', 'cancelInvoice'].includes(op.method)) {
      const invoice = await paypal.getInvoice(args[0]);
      if (op.method === 'cancelInvoice' ? invoice?.status !== 'CANCELLED' : !['SENT', 'PAID', 'PARTIALLY_PAID'].includes(invoice?.status)) throw new Error('Invoice state does not confirm the requested operation');
      result = op.method === 'sendInvoice' ? { href: invoice.detail?.metadata?.recipient_view_url || invoice.pay_url || null } : {};
    } else throw new Error('This operation requires provider support; it cannot be replayed automatically');
    store.update('operations', id, { status: 'SUCCEEDED', result: structuredClone(result), reconciled_at: new Date().toISOString() });
    return { id, status: 'SUCCEEDED' };
  });
}

export function reconcileBooking(bookingId, captureId = null) {
  return exclusive(async () => {
    let booking = store.get('bookings', bookingId);
    if (!booking) throw new Error('Booking not found');
    const pending = booking.payment_pending;
    if (pending?.kind === 'deposit') await captureDepositOrder(booking.id, pending.order_id, 'reconciliation');
    if (pending?.kind === 'vault') {
      const traveler = store.get('travelers', pending.traveler_id);
      await payDepositWithToken(booking.id, traveler?.payment_token_id, 'reconciliation', traveler?.id);
    }
    if (['balance', 'invoice'].includes(pending?.kind)) await collectBalance(booking);
    booking = store.get('bookings', bookingId);
    if (booking.paypal?.invoice_id) {
      const invoice = await paypal.getInvoice(booking.paypal.invoice_id);
      if (invoice?.status === 'PAID') {
        if (Number(invoice.payments?.paid_amount?.value) !== booking.balance_amount || invoice.payments?.paid_amount?.currency_code !== booking.currency) throw new Error('Paid invoice does not match balance');
        if (captureId) {
          if (!invoice.payments?.transactions?.some((t) => t.payment_id === captureId)) throw new Error('Capture is not a transaction on this invoice');
          const capture = await paypal.getCapture(captureId);
          validateCapture(booking, capture, booking.balance_amount);
          store.update('bookings', booking.id, { paypal: { ...booking.paypal, balance_capture_id: capture.id } });
        }
        markBalancePaid(booking.id, { invoice_id: invoice.id, capture_id: captureId, via: 'verified invoice reconciliation' });
      }
    }
    for (const p of store.find('payments', (p) => p.booking_id === bookingId && p.type === 'REFUND' && p.status !== 'COMPLETED')) {
      const refund = await paypal.getRefund(p.paypal_id);
      if (refund?.id === p.paypal_id && refund.status === 'COMPLETED' && Number(refund.amount?.value) === p.amount && refund.amount?.currency_code === p.currency) store.update('payments', p.id, { status: 'COMPLETED' });
    }
    booking = store.get('bookings', bookingId);
    if (booking.cancellation_pending && !booking.cancellation_pending.escalation_id) await requestCancellation(booking.id, booking.cancellation_pending.reason, 'reconciliation');
    return bookingSummary(store.get('bookings', bookingId));
  });
}
