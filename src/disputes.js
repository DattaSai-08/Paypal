import { store } from './store.js';
import { paypal } from './paypal/index.js';
import { logAction } from './actions.js';
import { describePolicy } from './policy.js';

export async function listDisputes() {
  const live = await paypal.listDisputes().catch((e) => ({ error: e.message, items: [] }));
  const items = (live.items || []).map((d) => ({ ...d, booking: matchBooking(d) }));
  return { items, error: live.error || null };
}

export function matchBooking(dispute) {
  const txIds = (dispute.disputed_transactions || []).map((t) => t.seller_transaction_id);
  const b = store.findOne('bookings', (x) => txIds.includes(x.paypal?.deposit_capture_id) || txIds.includes(x.paypal?.balance_capture_id));
  return b ? { id: b.id, guest_name: b.guest_name, room_name: b.room_name, check_in: b.check_in, check_out: b.check_out, status: b.status } : null;
}

export function buildEvidencePack(dispute) {
  const txIds = (dispute.disputed_transactions || []).map((t) => t.seller_transaction_id);
  const booking = store.findOne('bookings', (x) => txIds.includes(x.paypal?.deposit_capture_id) || txIds.includes(x.paypal?.balance_capture_id));
  if (!booking) throw new Error('No booking matches the disputed transaction');
  const conv = booking.conversation_id ? store.get('conversations', booking.conversation_id) : null;
  const payments = store.find('payments', (p) => p.booking_id === booking.id);
  const lines = [
    `EVIDENCE PACK for PayPal dispute ${dispute.dispute_id} (${dispute.reason})`,
    `Prepared by Innkeeper on ${store.now().toISOString()} for ${store.property.name}`,
    '',
    `Booking ${booking.id}: ${booking.room_name}, ${booking.check_in} to ${booking.check_out}, ${booking.nights} nights, ${booking.guests} guests`,
    `Guest: ${booking.guest_name} <${booking.guest_email}>; PayPal payer email on file: ${booking.payer_email || 'n/a'}`,
    `Status: ${booking.status}. Total ${booking.currency} ${booking.total}; deposit ${booking.deposit_amount} (${booking.deposit_paid ? 'paid' : 'unpaid'}); balance ${booking.balance_amount} (${booking.balance_paid ? 'paid' : 'unpaid'})`,
    '',
    'Policy shown to the guest before payment:',
    describePolicy(),
    '',
    'Room described to the guest at booking:',
    `${booking.room_name}: ${store.get('rooms', booking.room_id)?.description || ''}`,
    '',
    'Payments:',
    ...payments.map((p) => `- ${p.created_at} ${p.type} ${p.currency} ${p.amount} ${p.status} (${p.paypal_kind || ''} ${p.paypal_id})`),
    '',
    'Booking timeline:',
    ...(booking.timeline || []).map((t) => `- ${t.at} ${t.event}`),
    '',
    'Conversation transcript:',
    ...(conv?.messages || []).map((m) => `- [${m.ts}] ${m.role}: ${m.content}`),
  ];
  const note = `Booking ${booking.id} for ${booking.guest_name} was made through our booking agent with the room description, dates, price and cancellation policy shown before payment. The guest paid ${booking.deposit_paid ? `a deposit of ${booking.currency} ${booking.deposit_amount}` : 'nothing'}${booking.balance_paid ? ` and the balance of ${booking.currency} ${booking.balance_amount}` : ''}. Full transcript, timeline and policy attached.`;
  return { booking_id: booking.id, note, text: lines.join('\n') };
}

export async function submitEvidence(disputeId) {
  const dispute = await paypal.getDispute(disputeId);
  if (!dispute) throw new Error('Dispute not found');
  const pack = buildEvidencePack(dispute);
  const res = await paypal.provideEvidence(disputeId, { note: pack.note, evidenceText: pack.text });
  store.insert('disputes', { dispute_id: disputeId, status: 'EVIDENCE_SUBMITTED', booking_id: pack.booking_id, submitted_at: store.now().toISOString(), note: pack.note });
  logAction({ actor: 'owner', tool: 'submit_dispute_evidence', args: { dispute_id: disputeId }, result: 'Evidence pack submitted', booking_id: pack.booking_id, paypal_call: `POST /v1/customer/disputes/${disputeId}/provide-evidence` });
  return { pack, response: res };
}
