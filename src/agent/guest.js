import { store } from '../store.js';
import { describePolicy } from '../policy.js';
import { runToolLoop, llmAvailable, provider, modelLabel, trimHistory } from './llm.js';
import { toolsForAnthropic, runTool } from './tools.js';
import { scriptedGuestReply } from './scripted.js';
import { bookingSummary } from '../booking-service.js';

const GUEST_TOOLS = ['get_property_info', 'check_availability', 'get_quote', 'create_hold', 'create_deposit_order', 'get_booking', 'find_bookings_by_email', 'request_discount', 'request_cancellation', 'modify_booking_dates', 'add_experience', 'escalate_to_owner'];

export function getConversation(id, channel = 'web', principalId = null) {
  const existing = id ? store.get('conversations', id) : null;
  if (existing) return existing;
  return store.insert('conversations', { principal_id: principalId, channel, messages: [], llm_messages: [], slots: {}, booking_id: null });
}

export function systemPrompt() {
  const p = store.property;
  const rooms = store.all('rooms').map((r) => `${r.name} (id ${r.id}): ${r.max_guests} guests, from ${store.policy.currency} ${r.base_rate}/night. ${r.description}`).join('\n');
  const extras = store.all('extras').map((x) => `${x.name} (id ${x.id}): ${store.policy.currency} ${x.price} ${x.unit}`).join('\n');
  return `You are the front desk agent for ${p.name}, ${p.tagline}. Today is ${store.today()}. Tone: ${store.policy.agent_tone}. Keep replies short, plain and specific; no marketing fluff.

Property: ${p.description}
Check-in ${p.check_in_time}, check-out ${p.check_out_time}.
Rooms:
${rooms}
Extras:
${extras}
Policy: ${describePolicy()}

Rules you must follow:
- Never state a price, availability or refund figure you did not get from a tool in this conversation.
- Collect check-in, check-out (YYYY-MM-DD) and party size before checking availability. Collect the guest's full name and email before create_hold.
- A discount request goes through get_quote or create_hold with requested_discount_pct; for an existing unpaid hold use request_discount then create_deposit_order. Apply only what the tool approves and explain why in one sentence. If needs_owner is true, explain that the excess is awaiting owner approval.
- Reuse the existing booking and order. Answer policy questions without creating or cancelling bookings. Only cancel when the guest explicitly asks to cancel their booking.
- To take payment: create_hold, then create_deposit_order. The chat shows PayPal buttons for that order automatically; tell the guest to pay the deposit below and that the booking confirms the moment PayPal captures it. Do not invent payment links.
- Cancellations go through request_cancellation; relay the exact outcome (refunded now, awaiting owner, or nothing to refund) with the amounts the tool returned.
- Extras are added with add_experience. Mention that partner services are paid automatically via PayPal Payouts, so the guest never pays vendors in cash.
- If you cannot help, say so plainly and offer to escalate.`;
}

const pendingTurns = new Map();
export async function chat(conversationId, message, options = {}) {
  const conversation = getConversation(conversationId, options.channel, options.principalId);
  const previous = pendingTurns.get(conversation.id) || Promise.resolve();
  const turn = previous.catch(() => {}).then(() => chatTurn(conversation.id, message, options));
  pendingTurns.set(conversation.id, turn);
  try { return await turn; } finally { if (pendingTurns.get(conversation.id) === turn) pendingTurns.delete(conversation.id); }
}

async function chatTurn(conversationId, message, { channel = 'web' } = {}) {
  const conversation = getConversation(conversationId, channel);
  const ts = store.now().toISOString();
  let paymentRequest = null;
  let bookingId = conversation.booking_id;
  const slots = { ...(conversation.slots || {}) };
  if (bookingId) {
    const b = store.get('bookings', bookingId);
    if (b?.deposit_paid) slots.deposit_paid = true;
    if (!b || ['CANCELLED', 'EXPIRED'].includes(b.status) || (b.status === 'HOLD' && b.hold_expires_at <= ts)) {
      bookingId = null;
      for (const key of Object.keys(slots)) delete slots[key];
    } else { slots.booking_id = b.id; }
  }
  const ctx = {
    principal_id: conversation.principal_id,
    actor: 'guest_agent', channel, conversation_id: conversation.id, traveler_id: null,
    onBooking: (id) => { bookingId = id; },
    onPaymentRequest: (req) => { paymentRequest = req; },
  };
  const exec = (name, args) => GUEST_TOOLS.includes(name) ? runTool(name, args, ctx) : Promise.resolve({ error: 'Tool is not available to the guest agent' });

  let reply;
  let llmMessages = conversation.llm_provider === provider() ? (conversation.llm_messages || []) : [];
  let nextSlots = slots;
  if (llmAvailable()) {
    const userTurn = { role: 'user', content: message };
    const out = await runToolLoop({ system: systemPrompt(), messages: [...llmMessages, userTurn], tools: toolsForAnthropic(GUEST_TOOLS), execute: exec });
    reply = out.text || 'I did that. Anything else?';
    llmMessages = trimHistory(out.history);
  } else {
    const out = await scriptedGuestReply({ ...conversation, slots }, message, exec);
    reply = out.reply;
    nextSlots = out.slots;
    if (nextSlots.booking_id) bookingId = nextSlots.booking_id;
  }

  const updated = store.update('conversations', conversation.id, (c) => ({
    ...c,
    booking_id: bookingId,
    slots: { ...nextSlots, booking_id: bookingId || nextSlots.booking_id || null },
    llm_messages: llmMessages,
    llm_provider: provider(),
    messages: [...c.messages, { role: 'user', content: message, ts }, { role: 'assistant', content: reply, ts: store.now().toISOString(), payment_request: paymentRequest }],
  }));
  const booking = bookingId ? bookingSummary(store.get('bookings', bookingId)) : null;
  return { conversation_id: updated.id, reply, payment_request: paymentRequest, booking, provider: modelLabel() };
}
