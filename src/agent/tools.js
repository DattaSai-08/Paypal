import { z } from 'zod';
import { store } from '../store.js';
import { availability } from '../inventory.js';
import { quoteStay, approveDiscount, describePolicy, cancellationTerms } from '../policy.js';
import { createHold, createDepositOrder, payDepositWithToken, requestCancellation, modifyDates, addExtra, bookingSummary, resolveExtras } from '../booking-service.js';
import { escalate, logAction } from '../actions.js';
import { requestDiscount } from '../booking-service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const extrasInput = z.array(z.object({ id: z.string(), qty: z.number().int().min(1).default(1), date: isoDate.optional() })).optional();

export const toolDefs = [
  {
    name: 'request_discount',
    description: 'Apply a policy-approved discount to an unpaid hold and escalate any excess to the owner. Request a new deposit order afterwards.',
    schema: z.object({ booking_id: z.string(), requested_discount_pct: z.number().min(0).max(100) }),
    run: ({ booking_id, requested_discount_pct }, ctx) => {
      const out = requestDiscount(booking_id, requested_discount_pct, ctx.actor);
      return { booking: bookingSummary(out.booking), discount: out.discount };
    },
  },
  {
    name: 'get_property_info',
    description: 'Property facts: rooms, rates, extras, policies (deposit, balance, cancellation, discounts), FAQs and today\'s date. Call this first.',
    schema: z.object({}),
    run: () => ({
      today: store.today(),
      property: { name: store.property.name, tagline: store.property.tagline, location: store.property.location, description: store.property.description, check_in_time: store.property.check_in_time, check_out_time: store.property.check_out_time, faq: store.property.faq, peak_periods: store.property.peak_periods },
      rooms: store.all('rooms').map(({ id, name, base_rate, max_guests, description }) => ({ id, name, base_rate, max_guests, description })),
      extras: store.all('extras').map(({ id, name, price, unit }) => ({ id, name, price, unit })),
      policy: describePolicy(),
      currency: store.policy.currency,
    }),
  },
  {
    name: 'check_availability',
    description: 'Check which room types are free for a date range and party size. Dates are YYYY-MM-DD; check_out is the departure morning.',
    schema: z.object({ check_in: isoDate, check_out: isoDate, guests: z.number().int().min(1).max(8).default(2) }),
    run: ({ check_in, check_out, guests }) => ({ check_in, check_out, guests, rooms: availability(check_in, check_out, guests) }),
  },
  {
    name: 'get_quote',
    description: 'Price a stay for one room type with optional extras and a requested discount. Returns the full breakdown and how much discount policy allows. Does not reserve anything.',
    schema: z.object({ room_id: z.string(), check_in: isoDate, check_out: isoDate, guests: z.number().int().min(1).default(2), extras: extrasInput, requested_discount_pct: z.number().min(0).max(100).default(0) }),
    run: ({ room_id, check_in, check_out, guests, extras = [], requested_discount_pct = 0 }) => {
      const room = store.get('rooms', room_id);
      if (!room) throw new Error(`Unknown room_id ${room_id}`);
      const lines = resolveExtras(extras);
      const probe = quoteStay({ room, check_in, check_out, guests, extras: lines, discount_pct: 0 });
      const discount = approveDiscount({ requested_pct: requested_discount_pct, nights: probe.nights, check_in, has_peak_nights: probe.has_peak_nights });
      const quote = quoteStay({ room, check_in, check_out, guests, extras: lines, discount_pct: discount.approved_pct });
      return { quote, discount };
    },
  },
  {
    name: 'create_hold',
    description: 'Reserve a room for the hold window so the guest can pay the deposit. Requires the guest\'s name and email. Applies the policy-approved discount and returns the booking id, totals and deposit due.',
    schema: z.object({ room_id: z.string(), check_in: isoDate, check_out: isoDate, guests: z.number().int().min(1).default(2), guest_name: z.string().min(1), guest_email: z.string().email(), extras: extrasInput, requested_discount_pct: z.number().min(0).max(100).default(0) }),
    run: (args, ctx) => {
      if (ctx.traveler_id) {
        const traveler = store.get('travelers', ctx.traveler_id);
        if (!traveler || traveler.principal_id !== ctx.principal_id || args.guest_email.toLowerCase() !== traveler.email.toLowerCase()) throw new Error('Hold must belong to the authenticated traveler');
      }
      const { booking, discount } = createHold({ ...args, principal_id: ctx.principal_id, channel: ctx.channel, conversation_id: ctx.conversation_id, traveler_id: ctx.traveler_id, actor: ctx.actor });
      ctx.onBooking?.(booking.id);
      return { booking: bookingSummary(booking), discount, hold_minutes: store.policy.hold_minutes };
    },
  },
  {
    name: 'create_deposit_order',
    description: 'Create the PayPal order for the deposit of a held booking. For a human guest the chat UI renders PayPal buttons for this order; for an agent caller the approve_url is where the payer approves.',
    schema: z.object({ booking_id: z.string() }),
    run: async ({ booking_id }, ctx) => {
      const out = await createDepositOrder(booking_id, ctx.actor);
      ctx.onPaymentRequest?.({ booking_id, ...out });
      return { ...out, instructions: 'Ask the guest to complete the PayPal payment. The booking confirms automatically on capture.' };
    },
  },
  {
    name: 'pay_deposit_with_token',
    description: 'Pay the deposit for a held booking using a saved PayPal payment token (vault id) that the payer consented to earlier. Captures immediately and confirms the booking.',
    schema: z.object({ booking_id: z.string(), payment_token_id: z.string().optional() }),
    run: async ({ booking_id, payment_token_id }, ctx) => {
      if (!ctx.can_pay || !ctx.traveler_id) throw new Error('Explicit traveler payment consent is required');
      const b = store.get('bookings', booking_id);
      if (!b || b.total > ctx.max_total) throw new Error('Booking exceeds the consented maximum total');
      const grant = store.get('sessions', ctx.session_id);
      if (!grant || grant.expires_at <= new Date().toISOString() || (grant.approved_booking_id && grant.approved_booking_id !== booking_id)) throw new Error('Payment consent has expired or already belongs to another booking');
      store.update('sessions', grant.id, { approved_booking_id: booking_id });
      const traveler = store.get('travelers', ctx.traveler_id);
      if (payment_token_id && payment_token_id !== traveler?.payment_token_id) throw new Error('Payment token does not belong to the authenticated traveler');
      const booking = await payDepositWithToken(booking_id, traveler?.payment_token_id, ctx.actor, ctx.traveler_id);
      ctx.onBooking?.(booking.id);
      return { booking: bookingSummary(booking) };
    },
  },
  {
    name: 'get_booking',
    description: 'Fetch the current state of a booking: status, payments, balance due date, extras, and whether anything awaits the owner.',
    schema: z.object({ booking_id: z.string() }),
    run: ({ booking_id }) => {
      const b = store.get('bookings', booking_id);
      if (!b) throw new Error('Booking not found');
      return { booking: bookingSummary(b), timeline: b.timeline, cancellation_terms_today: b.deposit_paid ? cancellationTerms(b) : null };
    },
  },
  {
    name: 'find_bookings_by_email',
    description: 'Look up a returning guest\'s bookings by email address.',
    schema: z.object({ email: z.string().email() }),
    run: ({ email }) => ({ bookings: store.find('bookings', (b) => b.guest_email?.toLowerCase() === email.toLowerCase()).map(bookingSummary) }),
  },
  {
    name: 'request_cancellation',
    description: 'Cancel a booking under the cancellation policy. Refunds within the owner\'s auto-approve limit are executed on PayPal immediately; larger ones are escalated to the owner.',
    schema: z.object({ booking_id: z.string(), reason: z.string().default('') }),
    run: async ({ booking_id, reason }, ctx) => {
      const out = await requestCancellation(booking_id, reason, ctx.actor, ctx.conversation_id);
      return { outcome: out.outcome, terms: out.terms, booking: bookingSummary(out.booking), refunds: (out.refunds || []).map((r) => ({ id: r.id, status: r.status })) };
    },
  },
  {
    name: 'modify_booking_dates',
    description: 'Move a booking to new dates if the same room type is free. Recomputes totals; a higher total increases the balance due, a lower total creates a credit.',
    schema: z.object({ booking_id: z.string(), check_in: isoDate, check_out: isoDate }),
    run: ({ booking_id, check_in, check_out }, ctx) => ({ booking: bookingSummary(modifyDates(booking_id, check_in, check_out, ctx.actor)) }),
  },
  {
    name: 'add_experience',
    description: 'Add an extra (airport pickup, trek, dinner) to a booking. Vendor-provided extras schedule an automatic PayPal payout to the vendor on the service date.',
    schema: z.object({ booking_id: z.string(), extra_id: z.string(), qty: z.number().int().min(1).default(1), date: isoDate.optional() }),
    run: ({ booking_id, extra_id, qty, date }, ctx) => ({ booking: bookingSummary(addExtra(booking_id, extra_id, qty, date, ctx.actor)) }),
  },
  {
    name: 'escalate_to_owner',
    description: 'Hand a request to the human owner when it falls outside policy (bigger discount, special arrangement, complaint). Tell the guest the owner will respond.',
    schema: z.object({ booking_id: z.string().optional(), summary: z.string().min(5) }),
    run: ({ booking_id, summary }, ctx) => ({ escalation: escalate({ booking_id: booking_id || null, kind: 'GENERAL', summary, proposed: null, actor: ctx.actor, conversation_id: ctx.conversation_id }) }),
  },
];

export const PROPERTY_TOOL_NAMES = toolDefs.map((t) => t.name);

export const toolsForAnthropic = (names = PROPERTY_TOOL_NAMES) => toolDefs
  .filter((t) => names.includes(t.name))
  .map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema) }));

export function jsonSchema(schema) {
  const js = z.toJSONSchema(schema, { target: 'draft-7' });
  delete js.$schema;
  if (!js.properties) js.properties = {};
  return js;
}

export async function runTool(name, rawArgs, ctx) {
  const def = toolDefs.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown tool ${name}`);
  const parsed = def.schema.safeParse(rawArgs || {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    logAction({ actor: ctx.actor, tool: name, args: rawArgs, result: `Invalid arguments: ${msg}`, ok: false, conversation_id: ctx.conversation_id });
    return { error: `Invalid arguments: ${msg}` };
  }
  try {
    if (ctx.principal_id && parsed.data.booking_id) {
      const booking = store.get('bookings', parsed.data.booking_id);
      if (!booking || booking.principal_id !== ctx.principal_id) throw new Error('Booking is not owned by this session');
      if (ctx.traveler_id && booking.traveler_id !== ctx.traveler_id) throw new Error('Booking is outside this traveler grant');
    }
    if (ctx.conversation_id && parsed.data.booking_id) {
      const booking = store.get('bookings', parsed.data.booking_id);
      if (!booking || booking.conversation_id !== ctx.conversation_id) throw new Error('Booking is not part of this conversation');
    }
    if (ctx.conversation_id && name === 'find_bookings_by_email') {
      return { bookings: store.find('bookings', (b) => b.conversation_id === ctx.conversation_id && b.guest_email?.toLowerCase() === parsed.data.email.toLowerCase()).map(bookingSummary) };
    }
    const result = await def.run(parsed.data, ctx);
    if (!['create_hold', 'create_deposit_order', 'pay_deposit_with_token', 'request_cancellation', 'modify_booking_dates', 'add_experience', 'escalate_to_owner'].includes(name)) {
      logAction({ actor: ctx.actor, tool: name, args: parsed.data, result: summarize(result), conversation_id: ctx.conversation_id, booking_id: parsed.data.booking_id || null });
    }
    return result;
  } catch (e) {
    logAction({ actor: ctx.actor, tool: name, args: parsed.data, result: e.message, ok: false, conversation_id: ctx.conversation_id, booking_id: parsed.data.booking_id || null });
    return { error: e.message };
  }
}

function summarize(result) {
  if (result?.rooms) return `${result.rooms.filter((r) => r.available_units > 0).length}/${result.rooms.length} room types available`;
  if (result?.quote) return `Quote ${result.quote.currency} ${result.quote.total} (${result.quote.nights} nights, discount ${result.quote.discount_pct}%)`;
  if (result?.booking) return `Booking ${result.booking.id} ${result.booking.status}`;
  if (result?.bookings) return `${result.bookings.length} bookings`;
  return 'ok';
}
