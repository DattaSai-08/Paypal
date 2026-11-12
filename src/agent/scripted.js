import { store } from '../store.js';
import { addDays, nightsBetween } from '../dates.js';
import { describePolicy } from '../policy.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseDates(text, today = store.today()) {
  const iso = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
  if (iso.length >= 2) return { check_in: iso[0], check_out: iso[1] };
  const named = [];
  const re = /\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})|([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?)(?:,?\s*(\d{4}))?\b/gi;
  for (const m of text.matchAll(re)) {
    const day = Number(m[1] || m[4]);
    const monName = (m[2] || m[3] || '').slice(0, 3).toLowerCase();
    const mon = MONTHS.indexOf(monName);
    if (mon < 0 || day < 1 || day > 31) continue;
    let year = m[5] ? Number(m[5]) : Number(today.slice(0, 4));
    let d = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!m[5] && d < today) { year += 1; d = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
    named.push(d);
  }
  if (named.length >= 2) return { check_in: named[0], check_out: named[1] };
  const nights = text.match(/\b(\d+)\s*nights?\b/i);
  if (named.length === 1 && nights) return { check_in: named[0], check_out: addDays(named[0], Number(nights[1])) };
  if (iso.length === 1 && nights) return { check_in: iso[0], check_out: addDays(iso[0], Number(nights[1])) };
  if (named.length === 1) return { check_in: named[0], check_out: null };
  if (iso.length === 1) return { check_in: iso[0], check_out: null };
  return null;
}

export function parseGuests(text) {
  const m = text.match(/\b(\d+)\s*(?:guests?|people|persons?|adults?|pax|of us)\b/i) || text.match(/\bfor\s+(\d{1,2})\b(?![-\d]|\s*nights?)/i) || text.match(/\b(two|three|four)\s+(?:guests?|people|adults?|of us)\b/i);
  if (!m) return null;
  const words = { two: 2, three: 3, four: 4 };
  return words[m[1]?.toLowerCase()] || Number(m[1]);
}

export const parseEmail = (text) => text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] || null;

export function parseName(text) {
  const m = text.match(/\b(?:my name is|i am|i'm|this is|name:?)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})/i);
  if (m) return m[1].trim();
  const bare = text.match(/^([A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+)\s*,?\s*[\w.+-]+@/);
  return bare ? bare[1] : null;
}

export function parseRoom(text) {
  const t = text.toLowerCase();
  const rooms = store.all('rooms');
  const byId = rooms.find((r) => t.includes(r.id));
  if (byId) return byId.id;
  const keys = [['treehouse', 'room_treehouse'], ['loft', 'room_treehouse'], ['cottage', 'room_planters_cottage'], ['planter', 'room_planters_cottage'], ['family', 'room_family_suite'], ['suite', 'room_family_suite'], ['estate view', 'room_estate_view'], ['estate', 'room_estate_view']];
  return keys.find(([k]) => t.includes(k))?.[1] || null;
}

export function parseDiscount(text) {
  const m = text.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent\b)/i);
  if (m) return Number(m[1]);
  if (/\b(no discount|without (?:a )?discount|full price)\b/i.test(text)) return 0;
  return /\b(discount|cheaper|better price|deal|lower)\b/i.test(text) ? 10 : null;
}

export function parseExtra(text) {
  const t = text.toLowerCase();
  if (/pick\s?up|airport|transfer|cab/.test(t)) return 'xp_airport_pickup';
  if (/trek|hike|tadiandamol/.test(t)) return 'xp_tadiandamol_trek';
  if (/dinner|kodava|meal/.test(t)) return 'xp_kodava_dinner';
  if (/estate walk|coffee walk|tasting/.test(t)) return 'xp_estate_walk';
  return null;
}

const fmt = (n) => Number(n).toFixed(2);

export async function scriptedGuestReply(conversation, message, exec) {
  const slots = { ...(conversation.slots || {}) };
  const text = message.trim();
  const lower = text.toLowerCase();
  const dates = parseDates(text);
  if (dates?.check_in && !dates.check_out && slots.check_in && !slots.check_out) slots.check_out = dates.check_in;
  else if (dates?.check_in) { slots.check_in = dates.check_in; slots.check_out = dates.check_out; }
  if (dates?.check_out) slots.check_out = dates.check_out;
  const guests = parseGuests(text); if (guests) slots.guests = guests;
  const email = parseEmail(text); if (email) slots.guest_email = email;
  const name = parseName(text); if (name) slots.guest_name = name;
  const room = parseRoom(text); if (room) slots.room_id = room;
  const extraId = parseExtra(text);
  const discount = parseDiscount(text);
  const cur = store.policy.currency;
  const done = (reply, patch = {}) => ({ reply, slots: { ...slots, ...(conversation.slots?.booking_id ? Object.fromEntries(['check_in', 'check_out', 'room_id', 'guests'].map((key) => [key, conversation.slots[key]])) : {}), ...patch } });

  if (discount !== null && (!Number.isFinite(discount) || discount < 0 || discount > 100)) return done('Please request a discount between 0% and 100%.');
  if (discount !== null) slots.requested_discount_pct = discount;
  if (/\b(policy|policies|cancellation terms)\b/.test(lower)) return done(describePolicy());
  const faq = matchFaq(lower);
  if (faq && !dates && !room && !email && discount === null) return done(faq);
  if (/^(thanks|thank you|ok|okay|great)[!.\s]*$/i.test(text)) return done(slots.booking_id ? 'You’re welcome. I can show your booking or help with another request.' : 'You’re welcome. Send the remaining booking details when you’re ready.');

  if (slots.booking_id && /\b(cancel|refund)\b/.test(lower)) {
    const r = await exec('request_cancellation', { booking_id: slots.booking_id, reason: text });
    if (r.error) return done(`I couldn't process that: ${r.error}`);
    if (r.outcome === 'PENDING_OWNER') return done(`Cancelling ${r.terms.days_before} days out entitles you to ${r.terms.refund_pct}% back, which is ${cur} ${fmt(r.terms.refund_amount)}. That is above the amount I can approve myself, so I've sent it to the owner. You'll hear back shortly and the refund goes straight to your PayPal.`);
    if (r.outcome === 'CANCELLED_REFUNDED') return done(`Done. Your booking is cancelled and ${cur} ${fmt(r.terms.refund_amount)} (${r.terms.refund_pct}% per the policy you accepted) is on its way back to your PayPal. Sorry we won't see you this time.`);
    if (r.outcome === 'CANCELLED_NO_PAYMENT') return done('Cancelled. Nothing was charged, so nothing to refund. The dates are released.');
    return done('That booking is already cancelled.');
  }

  if (slots.booking_id && extraId && /\b(add|book|arrange|include|want|need)\b/.test(lower)) {
    const perTrip = store.get('extras', extraId)?.unit === 'per trip';
    const qty = perTrip ? 1 : (parseGuests(text) || slots.guests || 1);
    const r = await exec('add_experience', { booking_id: slots.booking_id, extra_id: extraId, qty, date: slots.check_in });
    if (r.error) return done(`I couldn't add that: ${r.error}`);
    const line = r.booking.extras[r.booking.extras.length - 1];
    return done(`Added ${line.qty} x ${line.name} (${cur} ${fmt(line.line_total)}). Your new total is ${cur} ${fmt(r.booking.total)}; the extra is collected with your balance on ${r.booking.balance_due_date}. Our partner is paid automatically on the day through PayPal, so there's nothing to settle in cash.`);
  }

  if (slots.booking_id && /\b(status|my booking|confirm|receipt|balance)\b/.test(lower)) {
    const r = await exec('get_booking', { booking_id: slots.booking_id });
    if (r.error) return done(`I couldn't fetch that booking: ${r.error}`);
    const b = r.booking;
    return done(`${b.room}, ${b.check_in} to ${b.check_out}, ${b.nights} nights for ${b.guests}. Status: ${b.status}. Total ${cur} ${fmt(b.total)}; deposit ${b.deposit_paid ? 'paid' : 'pending'} (${cur} ${fmt(b.deposit_amount)}); balance ${cur} ${fmt(b.balance_amount)} due ${b.balance_due_date}.`);
  }

  if (slots.booking_id && slots.deposit_paid) {
    const faq = matchFaq(lower);
    return done(faq || 'Your room is confirmed. I can add an airport pickup, a trek or a Kodava dinner, change your dates, or help with a cancellation. What would you like?');
  }

  if (slots.booking_id) {
    if (discount !== null) {
      const r = await exec('request_discount', { booking_id: slots.booking_id, requested_discount_pct: discount });
      if (r.error) return done(`I couldn't update the discount: ${r.error}`);
      const order = await exec('create_deposit_order', { booking_id: slots.booking_id });
      return done(`Policy approves ${r.discount.approved_pct}% of your requested ${discount}%: ${r.discount.explanation}. Total ${cur} ${fmt(r.booking.total)}, deposit ${cur} ${fmt(r.booking.deposit_amount)}.${r.discount.needs_owner ? ' The additional discount has been sent to the owner.' : ''} ${order.error ? 'Please ask to retry payment.' : 'Use the updated PayPal payment below.'}`);
    }
    if (dates || room || guests) return done('You already have a room on hold. Cancel that hold before changing the room, dates or party size.');
    if (/\b(pay|payment|paypal|deposit|retry)\b/.test(lower)) {
      const order = await exec('create_deposit_order', { booking_id: slots.booking_id });
      return done(order.error ? `I couldn't prepare payment: ${order.error}` : 'Your existing room is held. Pay the deposit with PayPal below to confirm it.');
    }
    return done('Your room is already on hold, awaiting the deposit. You can pay below, ask about the property, show your booking, or cancel.');
  }

  if (!slots.check_in || !slots.check_out) {
    const faq = matchFaq(lower);
    const intro = conversation.messages.length <= 1 ? `Welcome to ${store.property.name}. ${store.property.tagline}. ` : '';
    if (faq) return done(`${faq} When you're ready, tell me your dates and how many of you are coming.`);
    return done(`${intro}Tell me your check-in and check-out dates (for example 2026-12-20 to 2026-12-23) and how many guests, and I'll check what's free.`);
  }

  if (!slots.guests) return done('How many guests will be staying?');
  const availabilityKey = `${slots.check_in}|${slots.check_out}|${slots.guests}`;
  if (slots.availability_shown_for !== availabilityKey) {
    const r = await exec('check_availability', { check_in: slots.check_in, check_out: slots.check_out, guests: slots.guests || 2 });
    if (r.error) return done(`I can't check those dates: ${r.error}. Could you give me dates as YYYY-MM-DD?`, { check_in: null, check_out: null });
    const nights = nightsBetween(slots.check_in, slots.check_out);
    const free = r.rooms.filter((x) => x.available_units > 0 && x.fits_party);
    slots.availability_shown_for = availabilityKey;
    if (!free.length) return done(`Nothing fits ${slots.guests || 2} guests on those dates, sorry. Want me to try the week before or after?`, { room_id: null });
    if (slots.room_id && free.some((x) => x.room_id === slots.room_id)) {
      return continueToHold();
    }
    const list = free.map((x) => `${x.name} from ${cur} ${x.base_rate}/night (sleeps ${x.max_guests}): ${x.description}`).join('\n');
    return done(`For ${slots.check_in} to ${slots.check_out} (${nights} nights, ${slots.guests || 2} guests) we have:\n${list}\nWhich one would you like? I can also price a discount if you ask.`, { room_id: null });
  }

  if (!slots.room_id) return done('Which room would you like from the available options? You can say Estate View, Treehouse, Cottage or Family Suite.');

  return continueToHold();

  async function continueToHold() {
    const q = await exec('get_quote', { room_id: slots.room_id, check_in: slots.check_in, check_out: slots.check_out, guests: slots.guests, requested_discount_pct: slots.requested_discount_pct ?? 0 });
    if (q.error) return done(`I couldn't price that: ${q.error}`);
    const d = q.discount;
    const pricing = `${q.quote.room_name}: total ${cur} ${fmt(q.quote.total)}, deposit ${cur} ${fmt(q.quote.deposit)}.${d.requested_pct > 0 ? ` Policy approves ${d.approved_pct}% of your requested ${d.requested_pct}%: ${d.explanation}.${d.needs_owner ? ' The remaining discount needs owner approval.' : ''}` : ''} `;
    if (!slots.guest_name || !slots.guest_email) {
      return done(`${pricing}To hold it I need ${!slots.guest_name ? 'the full name for the booking' : ''}${!slots.guest_name && !slots.guest_email ? ' and ' : ''}${!slots.guest_email ? 'an email address for the PayPal receipt' : ''}.`);
    }
    const hold = await exec('create_hold', { room_id: slots.room_id, check_in: slots.check_in, check_out: slots.check_out, guests: slots.guests || 2, guest_name: slots.guest_name, guest_email: slots.guest_email, requested_discount_pct: slots.requested_discount_pct || 0 });
    if (hold.error) return done(`I couldn't hold the room: ${hold.error}`);
    const b = hold.booking;
    slots.booking_id = b.id;
    const order = await exec('create_deposit_order', { booking_id: b.id });
    if (order.error) return done(`The room is held (${b.id}) but PayPal didn't give me an order: ${order.error}`);
    const disc = hold.discount;
    const discLine = disc.requested_pct > 0
      ? (disc.approved_pct > 0 ? ` I applied ${disc.approved_pct}% off because ${disc.explanation}.` : ` I couldn't apply a discount: ${disc.explanation}.`) + (disc.needs_owner ? ' Your request for more has been sent to the owner; the current price uses only the approved discount.' : '')
      : '';
    const peak = q.quote.has_peak_nights ? ' Some of those nights are peak season, so the rate is higher than the base.' : '';
    return done(`${b.room} is held for ${b.nights} nights, ${b.check_in} to ${b.check_out}.${peak}${discLine} Total ${cur} ${fmt(b.total)} including ${store.policy.tax_pct}% tax. A ${store.policy.deposit_pct}% deposit of ${cur} ${fmt(b.deposit_amount)} confirms it; the balance of ${cur} ${fmt(b.balance_amount)} is due ${b.balance_due_date}. Pay the deposit with PayPal below; the hold lasts ${hold.hold_minutes} minutes.`, { booking_id: b.id });
  }
}

function matchFaq(lower) {
  const faq = store.property?.faq || [];
  const words = new Set(lower.split(/\W+/).filter((w) => w.length > 3));
  let best = null; let score = 0;
  for (const f of faq) {
    const hits = f.q.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && words.has(w)).length;
    if (hits > score) { score = hits; best = f; }
  }
  return score >= 1 ? best.a : null;
}
