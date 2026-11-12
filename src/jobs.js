import { store } from './store.js';
import { paypal } from './paypal/index.js';
import { expireHolds } from './inventory.js';
import { markBalancePaid, validateCapture } from './booking-service.js';
import { logAction, timeline } from './actions.js';
import { addDays, money } from './dates.js';
import { exclusive } from './locks.js';

export function runJobs(options) { return exclusive(() => runJobsOnce(options)); }
async function runJobsOnce({ trigger = 'scheduler' } = {}) {
  const report = { trigger, at: store.now().toISOString(), today: store.today(), expired_holds: 0, balances: [], payouts: [], completed: [], errors: [] };
  report.expired_holds = expireHolds();
  for (const b of dueBalances()) {
    try { report.balances.push(await collectBalance(b)); } catch (e) { report.errors.push({ booking_id: b.id, step: 'balance', error: e.message }); }
  }
  for (const item of duePayouts()) {
    try { report.payouts.push(await payVendor(item)); } catch (e) { report.errors.push({ booking_id: item.booking.id, step: 'payout', error: e.message }); }
  }
  for (const b of store.find('bookings', (x) => x.status === 'CONFIRMED' && x.balance_paid && !x.cancellation_pending && x.check_out <= store.today())) {
    store.update('bookings', b.id, { status: 'COMPLETED' });
    timeline(b.id, 'Stay completed');
    report.completed.push(b.id);
  }
  if (report.balances.length || report.payouts.length || report.expired_holds || report.errors.length) {
    logAction({ actor: 'system', tool: 'run_jobs', args: { trigger }, result: `${report.balances.length} balance actions, ${report.payouts.length} payouts, ${report.expired_holds} holds expired, ${report.errors.length} errors` });
  }
  return report;
}

export function dueBalances() {
  const today = store.today();
  return store.find('bookings', (b) => b.status === 'CONFIRMED' && b.deposit_paid && !b.balance_paid && b.balance_amount > 0 && b.balance_due_date <= today && !b.cancellation_pending);
}

export function collectBalance(booking) { return exclusive(() => collectBalanceOnce(booking)); }
async function collectBalanceOnce(booking) {
  const b = store.get('bookings', booking.id);
  if (!b || b.balance_paid || b.status !== 'CONFIRMED' || b.cancellation_pending) return { booking_id: booking.id, action: 'NOT_DUE' };
  if (b.source === 'seed') {
    store.insert('payments', { booking_id: b.id, type: 'BALANCE', amount: b.balance_amount, currency: b.currency, status: 'COMPLETED', paypal_id: `SEED-CAP-${b.id}`, paypal_kind: 'capture', via: 'seed-simulated' });
    store.update('bookings', b.id, { balance_paid: true });
    timeline(b.id, `Balance ${b.currency} ${b.balance_amount} collected (simulated for seed data)`);
    return { booking_id: b.id, action: 'SIMULATED_CAPTURE' };
  }
  if (b.vault_id) {
    const traveler = store.get('travelers', b.traveler_id);
    if (!traveler || traveler.payment_token_id !== b.vault_id || !b.balance_consent || b.total > b.balance_consent.maximum) throw new Error('Balance collection lacks valid traveler consent');
    store.update('bookings', b.id, { payment_pending: { kind: 'balance' } });
    const order = await paypal.createOrderWithVault({ amount: b.balance_amount, currency: b.currency, custom_id: `${b.id}-BAL`, vault_id: b.vault_id, description: `Balance: ${b.room_name}, ${b.check_in} to ${b.check_out}` });
    const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
    logAction({ actor: 'system', tool: 'collect_balance', args: { booking_id: b.id, method: 'vault' }, result: `Order ${order.id} ${order.status}`, booking_id: b.id, paypal_call: 'POST /v2/checkout/orders (vault_id)' });
    if (order.status === 'COMPLETED' && capture) {
      validateCapture(b, capture, b.balance_amount);
      store.update('bookings', b.id, (row) => ({ ...row, paypal: { ...row.paypal, balance_order_id: order.id } }));
      markBalancePaid(b.id, { capture_id: capture.id, via: 'vault auto-capture' });
      return { booking_id: b.id, action: 'VAULT_CAPTURED', capture_id: capture.id };
    }
    throw new Error(`Vault capture returned ${order.status}`);
  }
  if (!b.paypal?.invoice_id) {
    store.update('bookings', b.id, { payment_pending: { kind: 'invoice' } });
    const invoiceNumber = `INN-${b.id.replace('bk_', '')}`;
    const inv = await paypal.createInvoice({
      currency: b.currency, invoice_number: invoiceNumber, reference: b.id, due_date: addDays(store.today(), 3), total: b.balance_amount,
      recipient_name: b.guest_name, recipient_email: b.guest_email,
      note: `Balance for your stay at ${store.property.name}: ${b.room_name}, ${b.check_in} to ${b.check_out}. Deposit of ${b.currency} ${b.deposit_amount} already received.`,
      items: [{ name: `Balance for ${b.room_name} (${b.nights} nights, taxes included)`, qty: 1, price: b.balance_amount }],
    });
    const sent = await paypal.sendInvoice(inv.id);
    store.transaction(() => {
      store.insert('invoices', { booking_id: b.id, paypal_invoice_id: inv.id, amount: b.balance_amount, currency: b.currency, status: 'SENT', sent_at: store.now().toISOString(), pay_url: sent?.href || null });
      store.insert('payments', { booking_id: b.id, type: 'BALANCE', amount: b.balance_amount, currency: b.currency, status: 'PENDING', paypal_id: inv.id, paypal_kind: 'invoice' });
      store.update('bookings', b.id, (row) => ({ ...row, payment_pending: null, paypal: { ...row.paypal, invoice_id: inv.id }, invoice_sent_at: store.now().toISOString(), reminders_sent: 0 }));
    });
    timeline(b.id, `Balance invoice ${inv.id} sent to ${b.guest_email}`);
    logAction({ actor: 'system', tool: 'collect_balance', args: { booking_id: b.id, method: 'invoice' }, result: `Invoice ${inv.id} created and sent`, booking_id: b.id, paypal_call: 'POST /v2/invoicing/invoices + /send' });
    return { booking_id: b.id, action: 'INVOICE_SENT', invoice_id: inv.id };
  }
  const sentDaysAgo = Math.floor((store.now() - new Date(b.invoice_sent_at)) / 86400000);
  const cadence = b.reminders_sent === 0 ? 2 : 3;
  if (sentDaysAgo >= cadence * (b.reminders_sent + 1) && b.reminders_sent < 3) {
    const tone = ['friendly', 'firm', 'final'][b.reminders_sent];
    await paypal.remindInvoice(b.paypal.invoice_id, reminderNote(b, tone));
    store.update('bookings', b.id, { reminders_sent: b.reminders_sent + 1 });
    timeline(b.id, `Reminder ${b.reminders_sent + 1} (${tone}) sent for invoice ${b.paypal.invoice_id}`);
    logAction({ actor: 'system', tool: 'remind_invoice', args: { booking_id: b.id, tone }, result: `Reminder ${b.reminders_sent + 1} sent`, booking_id: b.id, paypal_call: `POST /v2/invoicing/invoices/${b.paypal.invoice_id}/remind` });
    return { booking_id: b.id, action: 'REMINDER_SENT', tone };
  }
  return { booking_id: b.id, action: 'WAITING_ON_INVOICE' };
}

function reminderNote(b, tone) {
  const base = `${b.guest_name}, your balance of ${b.currency} ${b.balance_amount} for ${b.check_in} is still open.`;
  if (tone === 'friendly') return `${base} No rush if you are travelling, but settling it keeps your ${b.room_name} locked in.`;
  if (tone === 'firm') return `${base} Please settle it within 48 hours so we can hold the room; otherwise the cancellation policy applies.`;
  return `${base} This is the final reminder before the booking is released under the cancellation terms you accepted.`;
}

export function duePayouts() {
  const today = store.today();
  const out = [];
  for (const booking of store.find('bookings', (b) => ['CONFIRMED', 'COMPLETED'].includes(b.status) && b.balance_paid && !b.cancellation_pending)) {
    for (const [idx, x] of (booking.extras || []).entries()) {
      if (x.vendor_id && ['SCHEDULED', 'PROCESSING'].includes(x.payout_status) && addDays(x.date, store.policy.vendor_payout_delay_days) <= today) out.push({ booking, idx, extra: x });
    }
  }
  return out;
}

export function payVendor(input) { return exclusive(() => payVendorOnce(input)); }
async function payVendorOnce({ booking, idx }) {
  booking = store.get('bookings', booking.id);
  const extra = booking.extras[idx];
  if (!booking.balance_paid || booking.cancellation_pending || !['CONFIRMED', 'COMPLETED'].includes(booking.status) || !['SCHEDULED', 'PROCESSING'].includes(extra?.payout_status)) return { booking_id: booking.id, action: 'NOT_DUE' };
  const vendor = store.get('vendors', extra.vendor_id);
  const amount = money(extra.vendor_share * (extra.qty || 1));
  const batchId = `po-${booking.id}-${idx}`;
  const existing = extra.payout_id && store.get('payouts', extra.payout_id);
  const batch = existing ? await paypal.getPayout(existing.paypal_batch_id) : booking.source === 'seed'
    ? { batch_header: { payout_batch_id: `SEED-${batchId}`, batch_status: 'SUCCESS' } }
    : await paypal.createPayout({ batch_id: batchId, subject: `Payout for ${extra.name}`, items: [{ email: vendor.paypal_email, amount, currency: booking.currency, note: `${extra.name} for ${booking.guest_name}, ${extra.date}`, sender_item_id: `${booking.id}-${idx}` }] });
  const status = batch.batch_header.batch_status;
  const paid = status === 'SUCCESS' && (booking.source === 'seed' || (batch.items?.length > 0 && batch.items.every((item) => item.transaction_status === 'SUCCESS')));
  store.transaction(() => {
    const payout = existing ? store.update('payouts', existing.id, { status: paid ? 'SUCCESS' : status }) : store.insert('payouts', { booking_id: booking.id, vendor_id: vendor.id, vendor_name: vendor.name, amount, currency: booking.currency, status: paid ? 'SUCCESS' : status, paypal_batch_id: batch.batch_header.payout_batch_id, extra_name: extra.name });
    const payment = store.findOne('payments', (p) => p.type === 'PAYOUT' && p.paypal_id === batch.batch_header.payout_batch_id);
    if (payment) store.update('payments', payment.id, { status: paid ? 'SUCCESS' : 'PENDING' });
    else store.insert('payments', { booking_id: booking.id, type: 'PAYOUT', amount, currency: booking.currency, status: paid ? 'SUCCESS' : 'PENDING', paypal_id: batch.batch_header.payout_batch_id, paypal_kind: 'payout', vendor_id: vendor.id });
    store.update('bookings', booking.id, (b) => { const extras = [...b.extras]; extras[idx] = { ...extras[idx], payout_status: paid ? 'PAID' : 'PROCESSING', payout_id: payout.id }; return { ...b, extras }; });
  });
  timeline(booking.id, `${paid ? 'Paid' : 'Payout pending for'} ${vendor.name} ${booking.currency} ${amount} for ${extra.name} via PayPal Payouts`);
  logAction({ actor: 'system', tool: 'pay_vendor', args: { booking_id: booking.id, vendor: vendor.name, amount }, result: `Payout batch ${batch.batch_header.payout_batch_id} ${batch.batch_header.batch_status}`, booking_id: booking.id, paypal_call: 'POST /v1/payments/payouts' });
  return { booking_id: booking.id, vendor: vendor.name, amount, batch_id: batch.batch_header.payout_batch_id };
}

let timer = null;
export function startScheduler(intervalMs) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => runJobs().catch((e) => console.error('[jobs]', e.message)), intervalMs);
  timer.unref?.();
  return timer;
}
