import { store } from './store.js';
import { paypal, captureFromOrder, approveLink } from './paypal/index.js';
import { quoteStay, approveDiscount, cancellationTerms } from './policy.js';
import { roomsAvailable } from './inventory.js';
import { addDays, isIsoDate, money } from './dates.js';
import { logAction, escalate, timeline } from './actions.js';
import { exclusive, assertWritable } from './locks.js';

async function paymentOperation(bookingId, work) {
  return exclusive(work);
}

export function validateCapture(booking, capture, amount = booking.deposit_amount) {
  if (!capture?.id || capture.status !== 'COMPLETED' || capture.amount?.currency_code !== booking.currency || !Number.isFinite(Number(capture.amount?.value)) || money(Number(capture.amount.value)) !== amount) {
    throw new Error('Capture status, amount or currency does not match booking');
  }
}

function invalidateDepositOrder(booking) {
  assertWritable();
  if (booking.payment_pending) throw new Error('Payment requires reconciliation before changing the booking');
  if (booking.deposit_paid) return;
  for (const payment of store.find('payments', (p) => p.booking_id === booking.id && p.type === 'DEPOSIT' && p.status === 'PENDING')) store.update('payments', payment.id, { status: 'SUPERSEDED' });
  store.update('bookings', booking.id, { payment_revision: (booking.payment_revision || 0) + 1, paypal: { ...booking.paypal, deposit_order_id: null } });
}

function travelerTotals(travelerId, exclude = null) {
  const bookings = store.find('bookings', (b) => b.traveler_id === travelerId && b.id !== exclude);
  let spent = 0; let committed = 0;
  for (const b of bookings) {
    const paid = store.find('payments', (p) => p.booking_id === b.id && p.status === 'COMPLETED').reduce((sum, p) => sum + (['DEPOSIT', 'BALANCE'].includes(p.type) ? p.amount : p.type === 'REFUND' ? -p.amount : 0), 0);
    spent += paid;
    committed += ['CONFIRMED', 'COMPLETED'].includes(b.status) || b.payment_pending?.kind === 'vault' ? b.total : Math.max(0, paid);
  }
  return { spent: money(spent), committed: money(committed), bookings: bookings.filter((b) => b.deposit_paid).map((b) => b.id) };
}

function syncTraveler(travelerId) {
  if (travelerId && store.get('travelers', travelerId)) store.update('travelers', travelerId, travelerTotals(travelerId));
}

function finishCancellation(bookingId, patch) {
  return store.transaction(() => {
    const booking = store.update('bookings', bookingId, patch);
    syncTraveler(booking.traveler_id);
    return booking;
  });
}

export function resolveExtras(requested = []) {
  return requested.map((r) => {
    const cat = store.get('extras', r.id || r.extra_id);
    if (!cat) throw new Error(`Unknown extra ${r.id || r.extra_id}`);
    const qty = Number(r.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1) throw new Error('Extra quantity must be a positive integer');
    return { ...cat, qty, date: r.date, payout_status: cat.vendor_id ? 'SCHEDULED' : 'NONE' };
  });
}

export function createHold(input) { return store.transaction(() => createHoldOnce(input)); }
function createHoldOnce(input) {
  const { room_id, check_in, check_out, guests = 2, guest_name, guest_email, extras = [], requested_discount_pct = 0, channel = 'web', conversation_id = null, traveler_id = null, actor = 'guest_agent' } = input;
  if (conversation_id) {
    const existing = store.findOne('bookings', (b) => b.conversation_id === conversation_id && (b.status === 'CONFIRMED' || (b.status === 'HOLD' && b.hold_expires_at > store.now().toISOString())));
    if (existing) return { booking: existing, discount: existing.discount_decision };
  }
  if (!isIsoDate(check_in) || !isIsoDate(check_out)) throw new Error('Dates must be YYYY-MM-DD');
  if (check_in < store.today()) throw new Error('check_in is in the past');
  if (!guest_name || !guest_email) throw new Error('guest_name and guest_email are required to hold a room');
  const room = store.get('rooms', room_id);
  if (!room) throw new Error(`Unknown room ${room_id}`);
  if (roomsAvailable(room_id, check_in, check_out) < 1) throw new Error(`${room.name} is not available for those dates`);

  const lines = resolveExtras(extras).map((x) => ({ ...x, date: x.date || check_in }));
  const probe = quoteStay({ room, check_in, check_out, guests, extras: lines, discount_pct: 0 });
  const discount = approveDiscount({ requested_pct: Number(requested_discount_pct), nights: probe.nights, check_in, has_peak_nights: probe.has_peak_nights });
  const quote = quoteStay({ room, check_in, check_out, guests, extras: lines, discount_pct: discount.approved_pct });

  const expires = new Date(store.now().getTime() + store.policy.hold_minutes * 60000).toISOString();
  const booking = store.insert('bookings', {
    source: 'live', channel, conversation_id, traveler_id, principal_id: input.principal_id || null,
    room_id: room.id, room_name: room.name, check_in, check_out, nights: quote.nights, guests,
    guest_name, guest_email, status: 'HOLD', hold_expires_at: expires,
    quote, total: quote.total, currency: quote.currency, policy_snapshot: structuredClone(store.policy),
    deposit_amount: quote.deposit, balance_amount: quote.balance, deposit_paid: false, balance_paid: false,
    balance_due_date: addDays(check_in, -store.policy.balance_due_days),
    discount_pct: discount.approved_pct, discount_decision: discount,
    extras: quote.extras.map((x) => ({ ...x, payout_status: x.vendor_id ? 'SCHEDULED' : 'NONE' })),
    paypal: {}, timeline: [{ at: store.now().toISOString(), event: `Room held for ${store.policy.hold_minutes} minutes pending deposit` }],
  });
  logAction({ actor, tool: 'create_hold', args: { room_id, check_in, check_out, guests, requested_discount_pct }, result: `Hold ${booking.id}, total ${quote.total}, deposit ${quote.deposit}, discount ${discount.approved_pct}%`, booking_id: booking.id, conversation_id });
  if (discount.needs_owner) {
    escalate({ booking_id: booking.id, kind: 'DISCOUNT_APPROVAL', summary: `Guest asked for ${discount.requested_pct}% off; policy allows ${discount.allowed_pct}%. Hold created at ${discount.approved_pct}%.`, proposed: { requested_pct: discount.requested_pct, allowed_pct: discount.allowed_pct }, actor, conversation_id });
  }
  return { booking, discount };
}

export function assertHoldOpen(booking) {
  if (booking.deposit_paid) throw new Error('Deposit already paid');
  if (booking.status !== 'HOLD') throw new Error(`Booking is ${booking.status}, not on hold`);
  if (booking.hold_expires_at <= store.now().toISOString() && !booking.payment_pending) throw new Error('Hold expired; please create a new hold');
}

export async function createDepositOrder(bookingId, actor = 'guest_agent') {
  return paymentOperation(bookingId, () => createDepositOrderOnce(bookingId, actor));
}

async function createDepositOrderOnce(bookingId, actor) {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  assertHoldOpen(booking);
  if (booking.paypal?.deposit_order_id) {
    const order = await paypal.getOrder(booking.paypal.deposit_order_id);
    return { order_id: order.id, approve_url: approveLink(order), amount: booking.deposit_amount, currency: booking.currency };
  }
  const order = await paypal.createOrder({ request_key: `${booking.id}:${booking.payment_revision || 0}`, amount: booking.deposit_amount, currency: booking.currency, custom_id: booking.id, reference_id: booking.id, description: `Deposit: ${booking.room_name}, ${booking.check_in} to ${booking.check_out}` });
  store.transaction(() => {
    store.update('bookings', booking.id, (b) => ({ ...b, paypal: { ...b.paypal, deposit_order_id: order.id } }));
    if (!store.findOne('payments', (p) => p.paypal_id === order.id)) store.insert('payments', { booking_id: booking.id, type: 'DEPOSIT', amount: booking.deposit_amount, currency: booking.currency, status: 'PENDING', paypal_id: order.id, paypal_kind: 'order' });
  });
  logAction({ actor, tool: 'create_deposit_order', args: { booking_id: bookingId }, result: `PayPal order ${order.id} for ${booking.currency} ${booking.deposit_amount}`, booking_id: booking.id, paypal_call: 'POST /v2/checkout/orders' });
  return { order_id: order.id, approve_url: approveLink(order), amount: booking.deposit_amount, currency: booking.currency };
}

export async function captureDepositOrder(bookingId, orderId, actor = 'guest') {
  return paymentOperation(bookingId, () => captureDepositOrderOnce(bookingId, orderId, actor));
}

async function captureDepositOrderOnce(bookingId, orderId, actor) {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  if (booking.paypal?.deposit_order_id !== orderId) throw new Error('Order does not belong to this booking');
  if (booking.deposit_paid) return booking;
  assertHoldOpen(booking);
  const pendingOrder = await paypal.getOrder(orderId);
  const unit = pendingOrder.purchase_units?.[0];
  if (pendingOrder.id !== orderId || unit?.custom_id !== booking.id || unit.amount?.currency_code !== booking.currency || Number(unit.amount?.value) !== booking.deposit_amount) throw new Error('Order amount or currency does not match booking');
  store.update('bookings', booking.id, { payment_pending: { kind: 'deposit', order_id: orderId } });
  const order = pendingOrder.status === 'COMPLETED' ? pendingOrder : await paypal.captureOrder(orderId);
  const capture = captureFromOrder(order);
  if (order.status !== 'COMPLETED' || !capture) throw new Error(`Capture not completed (${order.status})`);
  validateCapture(booking, capture);
  logAction({ actor, tool: 'capture_deposit', args: { booking_id: bookingId, order_id: orderId }, result: `Capture ${capture.id} ${capture.status}`, booking_id: bookingId, paypal_call: `POST /v2/checkout/orders/${orderId}/capture` });
  return markDepositPaid(booking.id, { capture_id: capture.id, order_id: orderId, payer: order.payer, via: 'checkout' });
}

export function payDepositWithToken(...args) { return exclusive(() => payDepositWithTokenOnce(...args)); }
async function payDepositWithTokenOnce(bookingId, vaultId, actor = 'traveler_agent', travelerId = null) {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  const traveler = store.get('travelers', travelerId);
  if (!traveler || traveler.payment_token_id !== vaultId || booking.traveler_id !== travelerId || booking.principal_id !== traveler.principal_id) throw new Error('Payment method and booking must belong to the authenticated traveler');
  if (booking.deposit_paid) return booking;
  if (booking.total + travelerTotals(travelerId, booking.id).committed > traveler.budget_total) throw new Error('Booking exceeds remaining traveler budget');
  assertHoldOpen(booking);
  store.update('bookings', booking.id, { payment_pending: { kind: 'vault', traveler_id: travelerId }, balance_consent: { traveler_id: travelerId, maximum: booking.total, at: new Date().toISOString() } });
  const order = await paypal.createOrderWithVault({ amount: booking.deposit_amount, currency: booking.currency, custom_id: booking.id, vault_id: vaultId, description: `Deposit: ${booking.room_name}, ${booking.check_in} to ${booking.check_out}` });
  const capture = captureFromOrder(order);
  if (order.status !== 'COMPLETED' || !capture) throw new Error(`Vaulted payment not completed (${order.status})`);
  validateCapture(booking, capture);
  store.update('bookings', booking.id, (b) => ({ ...b, vault_id: vaultId, traveler_id: travelerId || b.traveler_id, paypal: { ...b.paypal, deposit_order_id: order.id } }));
  logAction({ actor, tool: 'pay_deposit_with_token', args: { booking_id: bookingId, vault_id: vaultId }, result: `Order ${order.id} COMPLETED, capture ${capture.id}`, booking_id: bookingId, paypal_call: 'POST /v2/checkout/orders (payment_source.paypal.vault_id)' });
  return markDepositPaid(booking.id, { capture_id: capture.id, order_id: order.id, payer: order.payer, via: 'vault' });
}

export function markDepositPaid(...args) { return store.transaction(() => markDepositPaidOnce(...args)); }
function markDepositPaidOnce(bookingId, { capture_id, order_id, payer, via }) {
  const booking = store.get('bookings', bookingId);
  if (booking.deposit_paid) return booking;
  assertHoldOpen(booking);
  const pending = store.findOne('payments', (p) => p.booking_id === bookingId && p.type === 'DEPOSIT' && p.status === 'PENDING');
  if (pending) store.update('payments', pending.id, { status: 'COMPLETED', paypal_id: capture_id, paypal_kind: 'capture', via });
  else store.insert('payments', { booking_id: bookingId, type: 'DEPOSIT', amount: booking.deposit_amount, currency: booking.currency, status: 'COMPLETED', paypal_id: capture_id, paypal_kind: 'capture', via });
  const updated = store.update('bookings', bookingId, (b) => ({
    ...b, status: 'CONFIRMED', deposit_paid: true, hold_expires_at: null, payment_pending: null,
    payer_email: payer?.email_address || b.payer_email || null,
    paypal: { ...b.paypal, deposit_order_id: order_id || b.paypal.deposit_order_id, deposit_capture_id: capture_id },
  }));
  syncTraveler(booking.traveler_id);
  timeline(bookingId, `Deposit ${booking.currency} ${booking.deposit_amount} captured (${via}); booking confirmed`);
  return updated;
}

export function markBalancePaid(...args) { return store.transaction(() => markBalancePaidOnce(...args)); }
function markBalancePaidOnce(bookingId, { capture_id, invoice_id, via }) {
  const booking = store.get('bookings', bookingId);
  if (booking.balance_paid) return booking;
  const pending = store.findOne('payments', (p) => p.booking_id === bookingId && p.type === 'BALANCE' && p.status === 'PENDING');
  if (pending) store.update('payments', pending.id, { status: 'COMPLETED', paypal_id: capture_id || pending.paypal_id, via });
  else store.insert('payments', { booking_id: bookingId, type: 'BALANCE', amount: booking.balance_amount, currency: booking.currency, status: 'COMPLETED', paypal_id: capture_id || invoice_id, paypal_kind: capture_id ? 'capture' : 'invoice', via });
  const updated = store.update('bookings', bookingId, (b) => ({ ...b, balance_paid: true, payment_pending: null, paypal: { ...b.paypal, balance_capture_id: capture_id || b.paypal.balance_capture_id, invoice_id: invoice_id || b.paypal.invoice_id } }));
  syncTraveler(booking.traveler_id);
  if (booking.cancellation_pending) {
    const pending = { ...booking.cancellation_pending, paid_total: money(booking.deposit_amount + booking.balance_amount), refund_amount: money((booking.deposit_amount + booking.balance_amount) * booking.cancellation_pending.refund_pct / 100) };
    store.update('bookings', bookingId, { cancellation_pending: pending });
    if (pending.escalation_id) store.update('escalations', pending.escalation_id, { proposed: pending, summary: `Payment arrived during cancellation; revised refund ${booking.currency} ${pending.refund_amount}. Review before approving.` });
  }
  timeline(bookingId, `Balance ${booking.currency} ${booking.balance_amount} received (${via})`);
  return updated;
}

export function settleDepositWebhook(bookingId, capture, orderId) {
  return exclusive(async () => {
    const booking = store.get('bookings', bookingId);
    validateCapture(booking, capture);
    if (booking.paypal?.deposit_order_id !== orderId) throw new Error('Deposit order mismatch');
    if (booking.deposit_paid && !booking.refund_required) return booking;
    const late = ['CANCELLED', 'EXPIRED'].includes(booking.status) || (booking.status === 'HOLD' && !booking.payment_pending && booking.hold_expires_at <= store.now().toISOString());
    if (!late && !booking.refund_required) return markDepositPaid(bookingId, { capture_id: capture.id, order_id: orderId, via: 'webhook' });
    if (!booking.deposit_paid) store.transaction(() => {
      const pending = store.findOne('payments', (p) => p.booking_id === bookingId && p.type === 'DEPOSIT' && p.status === 'PENDING');
      const row = { booking_id: bookingId, type: 'DEPOSIT', amount: booking.deposit_amount, currency: booking.currency, status: 'COMPLETED', paypal_id: capture.id, paypal_kind: 'capture', via: 'late capture' };
      if (pending) store.update('payments', pending.id, row); else store.insert('payments', row);
      store.update('bookings', bookingId, { status: booking.status === 'HOLD' ? 'EXPIRED' : booking.status, deposit_paid: true, refund_required: true, paypal: { ...booking.paypal, deposit_capture_id: capture.id } });
    });
    await executeRefund(bookingId, booking.deposit_amount, 'Late capture refund');
    return store.update('bookings', bookingId, { refund_required: false });
  });
}

export function executeRefund(...args) { return exclusive(() => executeRefundOnce(...args)); }
async function executeRefundOnce(bookingId, amount, note, actor = 'system') {
  const booking = store.get('bookings', bookingId);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid refund amount');
  const prior = store.find('payments', (p) => p.booking_id === bookingId && p.type === 'REFUND');
  if (prior.some((p) => p.status !== 'COMPLETED')) throw new Error('A refund requires reconciliation before proceeding');
  let remaining = money(amount - prior.reduce((sum, p) => sum + p.amount, 0));
  const sources = [
    { capture: booking.paypal?.balance_capture_id, max: booking.balance_paid ? booking.balance_amount : 0 },
    { capture: booking.paypal?.deposit_capture_id, max: booking.deposit_paid ? booking.deposit_amount : 0 },
  ];
  const refunds = [];
  const capacity = sources.reduce((sum, src) => sum + (src.capture ? Math.max(0, src.max - prior.filter((p) => p.refunded_capture === src.capture).reduce((s, p) => s + p.amount, 0)) : 0), 0);
  if (remaining > money(capacity)) throw new Error('Refund needs payment reconciliation: a refundable capture is missing');
  for (const src of sources) {
    if (remaining <= 0 || !src.capture || src.max <= 0) continue;
    const already = store.find('payments', (p) => p.booking_id === bookingId && p.type === 'REFUND' && p.refunded_capture === src.capture).reduce((s, p) => s + p.amount, 0);
    const room = money(src.max - already);
    if (room <= 0) continue;
    const slice = Math.min(remaining, room);
    const refund = booking.source === 'seed'
      ? { id: `SEED-REF-${Date.now().toString(36)}`, status: 'COMPLETED' }
      : await paypal.refundCapture(src.capture, slice, 'Cancellation refund');
    store.transaction(() => {
      store.insert('payments', { booking_id: bookingId, type: 'REFUND', amount: slice, currency: booking.currency, status: refund.status || 'PENDING', paypal_id: refund.id, paypal_kind: 'refund', refunded_capture: src.capture, note });
      syncTraveler(booking.traveler_id);
    });
    if (refund.status !== 'COMPLETED') throw new Error('Refund is pending reconciliation; cancellation is not complete');
    logAction({ actor, tool: 'refund', args: { booking_id: bookingId, amount: slice }, result: `Refund ${refund.id} ${refund.status}`, booking_id: bookingId, paypal_call: `POST /v2/payments/captures/${src.capture}/refund` });
    refunds.push(refund);
    remaining = money(remaining - slice);
  }
  return refunds;
}

export function requestCancellation(...args) { return exclusive(() => requestCancellationOnce(...args)); }
async function requestCancellationOnce(bookingId, reason = '', actor = 'guest_agent', conversation_id = null) {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  if (booking.status === 'CANCELLED') return { booking, outcome: 'ALREADY_CANCELLED' };
  if (booking.payment_pending) throw new Error('Payment requires reconciliation before cancellation');
  const terms = booking.cancellation_pending || cancellationTerms(booking);
  if (booking.status === 'HOLD' || !booking.deposit_paid) {
    const b = store.update('bookings', bookingId, { status: 'CANCELLED', cancellation: { ...terms, reason, refund_amount: 0 } });
    timeline(bookingId, 'Cancelled before deposit; nothing to refund');
    return { booking: b, outcome: 'CANCELLED_NO_PAYMENT', terms };
  }
  if (terms.refund_amount > 0 && !terms.auto_approve) {
    const esc = escalate({ booking_id: bookingId, kind: 'REFUND_APPROVAL', summary: `${booking.guest_name} is cancelling ${terms.days_before} days out. Policy refund ${terms.refund_pct}% = ${booking.currency} ${terms.refund_amount}, above the auto-approve limit of ${store.policy.refund_auto_approve_limit}.`, proposed: { ...terms, reason }, actor, conversation_id });
    const b = store.update('bookings', bookingId, { cancellation_pending: { ...terms, reason, escalation_id: esc.id } });
    timeline(bookingId, `Cancellation requested; refund ${booking.currency} ${terms.refund_amount} awaiting owner approval`);
    return { booking: b, outcome: 'PENDING_OWNER', terms, escalation: esc };
  }
  if (booking.paypal?.invoice_id && !booking.balance_paid) await paypal.cancelInvoice(booking.paypal.invoice_id);
  store.update('bookings', bookingId, { cancellation_pending: { ...terms, reason } });
  const refunds = terms.refund_amount > 0 ? await executeRefund(bookingId, terms.refund_amount, `Cancellation refund (${terms.refund_pct}% per policy)`, actor) : [];
  const b = finishCancellation(bookingId, { status: 'CANCELLED', cancellation: { ...terms, reason, refund_ids: store.find('payments', (p) => p.booking_id === bookingId && p.type === 'REFUND' && p.status === 'COMPLETED').map((p) => p.paypal_id) }, cancellation_pending: null });
  timeline(bookingId, `Cancelled ${terms.days_before} days before check-in; refunded ${booking.currency} ${terms.refund_amount} (${terms.refund_pct}%)`);
  logAction({ actor, tool: 'request_cancellation', args: { booking_id: bookingId, reason }, result: `Cancelled, refund ${terms.refund_amount}`, booking_id: bookingId, conversation_id });
  return { booking: b, outcome: 'CANCELLED_REFUNDED', terms, refunds };
}

export function resolveEscalation(...args) { return exclusive(() => resolveEscalationOnce(...args)); }
async function resolveEscalationOnce(escalationId, decision, note = '') {
  const esc = store.get('escalations', escalationId);
  if (!esc || esc.status !== 'OPEN') throw new Error('Escalation not open');
  const booking = store.get('bookings', esc.booking_id);
  let result = decision;
  if (esc.kind === 'REFUND_APPROVAL') {
    if (decision === 'APPROVE') {
      const t = esc.proposed;
      if (booking.payment_pending) throw new Error('Payment requires reconciliation before cancellation');
      if (booking.paypal?.invoice_id && !booking.balance_paid) await paypal.cancelInvoice(booking.paypal.invoice_id);
      const refunds = await executeRefund(booking.id, t.refund_amount, 'Cancellation refund approved by owner', 'owner');
      finishCancellation(booking.id, { status: 'CANCELLED', cancellation: { ...t, refund_ids: store.find('payments', (p) => p.booking_id === booking.id && p.type === 'REFUND' && p.status === 'COMPLETED').map((p) => p.paypal_id), approved_by: 'owner' }, cancellation_pending: null });
      timeline(booking.id, `Owner approved refund of ${booking.currency} ${t.refund_amount}; booking cancelled`);
      result = `Refunded ${t.refund_amount}`;
    } else {
      store.update('bookings', booking.id, { cancellation_pending: null });
      timeline(booking.id, `Owner declined the refund request${note ? `: ${note}` : ''}`);
    }
  }
  if (esc.kind === 'DISCOUNT_APPROVAL' && decision === 'APPROVE' && booking.status === 'HOLD') {
    const room = store.get('rooms', booking.room_id);
    const quote = quoteStay({ room, check_in: booking.check_in, check_out: booking.check_out, guests: booking.guests, extras: booking.extras, discount_pct: esc.proposed.requested_pct });
    invalidateDepositOrder(booking);
    store.update('bookings', booking.id, { quote, total: quote.total, deposit_amount: quote.deposit, balance_amount: quote.balance, discount_pct: quote.discount_pct });
    timeline(booking.id, `Owner approved ${esc.proposed.requested_pct}% discount; quote updated`);
    result = `Discount ${esc.proposed.requested_pct}% applied`;
  }
  logAction({ actor: 'owner', tool: 'resolve_escalation', args: { escalation_id: escalationId, decision }, result, booking_id: booking?.id || null });
  return store.update('escalations', escalationId, { status: decision === 'APPROVE' ? 'APPROVED' : 'DECLINED', resolved_at: store.now().toISOString(), note });
}

export function requestDiscount(...args) { return store.transaction(() => requestDiscountOnce(...args)); }
function requestDiscountOnce(bookingId, requestedPct, actor = 'guest_agent') {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  assertHoldOpen(booking);
  const room = store.get('rooms', booking.room_id);
  const probe = quoteStay({ room, ...booking, discount_pct: 0 });
  const discount = approveDiscount({ requested_pct: requestedPct, nights: probe.nights, check_in: booking.check_in, has_peak_nights: probe.has_peak_nights });
  const quote = quoteStay({ ...booking, room, discount_pct: discount.approved_pct });
  if (booking.deposit_amount !== quote.deposit) invalidateDepositOrder(booking);
  const updated = store.update('bookings', bookingId, { quote, total: quote.total, deposit_amount: quote.deposit, balance_amount: quote.balance, discount_pct: discount.approved_pct, discount_decision: discount });
  if (discount.needs_owner) escalate({ booking_id: bookingId, kind: 'DISCOUNT_APPROVAL', summary: `Guest requests ${requestedPct}% off; policy approves ${discount.approved_pct}%.`, proposed: { requested_pct: requestedPct, allowed_pct: discount.allowed_pct }, actor, conversation_id: booking.conversation_id });
  else for (const esc of store.find('escalations', (e) => e.booking_id === bookingId && e.kind === 'DISCOUNT_APPROVAL' && e.status === 'OPEN')) store.update('escalations', esc.id, { status: 'WITHDRAWN' });
  timeline(bookingId, `Discount updated to ${discount.approved_pct}%; total ${quote.total}`);
  return { booking: updated, discount };
}

function assertEditable(booking) {
  if (booking.payment_pending || booking.cancellation_pending || booking.balance_paid || booking.paypal?.invoice_id || booking.balance_consent) throw new Error('This booking requires owner reconciliation before changes');
}

export function modifyDates(...args) { return store.transaction(() => modifyDatesOnce(...args)); }
function modifyDatesOnce(bookingId, check_in, check_out, actor = 'guest_agent') {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  assertEditable(booking);
  if (!['HOLD', 'CONFIRMED'].includes(booking.status)) throw new Error(`Cannot modify a ${booking.status} booking`);
  if (!isIsoDate(check_in) || !isIsoDate(check_out)) throw new Error('Dates must be YYYY-MM-DD');
  if (check_in < store.today()) throw new Error('check_in is in the past');
  if (roomsAvailable(booking.room_id, check_in, check_out, booking.id) < 1) throw new Error(`${booking.room_name} is not free for ${check_in} to ${check_out}`);
  const room = store.get('rooms', booking.room_id);
  const quote = quoteStay({ room, check_in, check_out, guests: booking.guests, extras: booking.extras, discount_pct: booking.discount_pct });
  if (booking.deposit_paid && quote.total < booking.deposit_amount) throw new Error('Price reduction requires an owner-approved credit before changes');
  const paid = money((booking.deposit_paid ? booking.deposit_amount : 0) + (booking.balance_paid ? booking.balance_amount : 0));
  const patch = { check_in, check_out, nights: quote.nights, quote, total: quote.total, balance_due_date: addDays(check_in, -store.policy.balance_due_days) };
  if (!booking.deposit_paid) {
    Object.assign(patch, { deposit_amount: quote.deposit, balance_amount: quote.balance });
  } else {
    const newBalance = money(quote.total - booking.deposit_amount);
    Object.assign(patch, { balance_amount: Math.max(0, newBalance), balance_paid: paid >= quote.total, change_credit: paid > quote.total ? money(paid - quote.total) : 0 });
  }
  invalidateDepositOrder(booking);
  const updated = store.update('bookings', bookingId, patch);
  timeline(bookingId, `Dates changed to ${check_in} to ${check_out}; new total ${quote.currency} ${quote.total}`);
  logAction({ actor, tool: 'modify_booking_dates', args: { booking_id: bookingId, check_in, check_out }, result: `New total ${quote.total}`, booking_id: bookingId });
  return updated;
}

export function addExtra(...args) { return store.transaction(() => addExtraOnce(...args)); }
function addExtraOnce(bookingId, extraId, qty = 1, date = null, actor = 'guest_agent') {
  const booking = store.get('bookings', bookingId);
  if (!booking) throw new Error('Booking not found');
  assertEditable(booking);
  if (!['HOLD', 'CONFIRMED'].includes(booking.status)) throw new Error(`Cannot add extras to a ${booking.status} booking`);
  const lines = [...booking.extras, ...resolveExtras([{ id: extraId, qty, date: date || booking.check_in }])];
  const room = store.get('rooms', booking.room_id);
  const quote = quoteStay({ room, check_in: booking.check_in, check_out: booking.check_out, guests: booking.guests, extras: lines, discount_pct: booking.discount_pct });
  const patch = { quote, total: quote.total, extras: quote.extras.map((x, i) => ({ ...x, payout_status: lines[i].payout_status || (x.vendor_id ? 'SCHEDULED' : 'NONE'), payout_id: lines[i].payout_id || null })) };
  if (!booking.deposit_paid) Object.assign(patch, { deposit_amount: quote.deposit, balance_amount: quote.balance });
  else Object.assign(patch, { balance_amount: money(quote.total - booking.deposit_amount), balance_paid: false });
  invalidateDepositOrder(booking);
  const updated = store.update('bookings', bookingId, patch);
  const added = updated.extras[updated.extras.length - 1];
  timeline(bookingId, `Added ${added.qty} x ${added.name}; new total ${quote.currency} ${quote.total}`);
  logAction({ actor, tool: 'add_experience', args: { booking_id: bookingId, extra_id: extraId, qty }, result: `Added ${added.name}`, booking_id: bookingId });
  return updated;
}

export function bookingSummary(b) {
  if (!b) return null;
  return {
    id: b.id, status: b.status, room: b.room_name, check_in: b.check_in, check_out: b.check_out, nights: b.nights, guests: b.guests,
    guest_name: b.guest_name, total: b.total, currency: b.currency, deposit_amount: b.deposit_amount, deposit_paid: b.deposit_paid,
    balance_amount: b.balance_amount, balance_paid: b.balance_paid, balance_due_date: b.balance_due_date, discount_pct: b.discount_pct,
    hold_expires_at: b.hold_expires_at, extras: (b.extras || []).map((x) => ({ name: x.name, qty: x.qty, date: x.date, line_total: x.line_total })),
    cancellation_pending: b.cancellation_pending ? { refund_amount: b.cancellation_pending.refund_amount, awaiting: 'owner approval' } : null,
    paypal: { deposit_order_id: b.paypal?.deposit_order_id || null, deposit_capture_id: b.paypal?.deposit_capture_id || null, invoice_id: b.paypal?.invoice_id || null },
  };
}
