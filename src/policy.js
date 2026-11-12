import { store } from './store.js';
import { eachNight, nightsBetween, daysBetween, money, isIsoDate } from './dates.js';
import { z } from 'zod';

const pct = z.number().finite().min(0).max(100);
export const policySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/), deposit_pct: z.number().min(1).max(100),
  balance_due_days: z.number().int().min(0).max(365), hold_minutes: z.number().int().min(1).max(1440), tax_pct: pct,
  cancellation_tiers: z.array(z.object({ min_days_before: z.number().int().min(0).max(3650), refund_pct: pct }).strict()).min(1).max(20),
  discount: z.object({ max_pct: pct, min_nights: z.number().int().min(1).max(365), min_lead_days: z.number().int().min(0).max(3650), peak_cap_pct: pct }).strict(),
  refund_auto_approve_limit: z.number().finite().min(0).max(100000), vendor_payout_delay_days: z.number().int().min(0).max(365), no_show_fee_pct: pct,
  agent_tone: z.string().max(500),
}).strict().refine((p) => p.cancellation_tiers.some((t) => t.min_days_before === 0), 'Cancellation tiers must include day zero');

export function peakFor(date) {
  const periods = store.property?.peak_periods || [];
  return periods.find((p) => date >= p.from && date <= p.to) || null;
}

export function quoteStay({ room, check_in, check_out, guests, extras = [], discount_pct = 0 }) {
  const policy = store.policy;
  if (!isIsoDate(check_in) || !isIsoDate(check_out)) throw new Error('Dates must be valid YYYY-MM-DD dates');
  if (!Number.isInteger(guests) || guests < 1) throw new Error('guests must be a positive integer');
  if (!Number.isFinite(discount_pct) || discount_pct < 0 || discount_pct > 100) throw new Error('Discount must be between 0 and 100');
  const nights = nightsBetween(check_in, check_out);
  if (nights < 1) throw new Error('check_out must be after check_in');
  if (nights > 365) throw new Error('Stay cannot exceed 365 nights');
  if (guests > room.max_guests) throw new Error(`${room.name} sleeps at most ${room.max_guests}`);

  const nightly = eachNight(check_in, check_out).map((date) => {
    const peak = peakFor(date);
    const rate = money(room.base_rate * (peak ? peak.multiplier : 1));
    return { date, rate, peak: peak ? peak.label : null };
  });
  const room_subtotal = money(nightly.reduce((s, n) => s + n.rate, 0));

  const extraLines = extras.map((x) => ({
    id: x.id, name: x.name, qty: x.qty || 1, price: x.price, line_total: money(x.price * (x.qty || 1)),
    vendor_id: x.vendor_id || null, vendor_share: x.vendor_share || 0, date: x.date || check_in,
  }));
  const extras_subtotal = money(extraLines.reduce((s, x) => s + x.line_total, 0));

  const discount_amount = money(room_subtotal * (discount_pct / 100));
  const taxable = money(room_subtotal - discount_amount + extras_subtotal);
  const tax = money(taxable * (policy.tax_pct / 100));
  const total = money(taxable + tax);
  const deposit = money(total * (policy.deposit_pct / 100));

  return {
    room_id: room.id, room_name: room.name, check_in, check_out, nights, guests,
    nightly, room_subtotal, extras: extraLines, extras_subtotal,
    discount_pct, discount_amount, tax_pct: policy.tax_pct, tax, total,
    deposit_pct: policy.deposit_pct, deposit, balance: money(total - deposit),
    currency: policy.currency, has_peak_nights: nightly.some((n) => n.peak),
  };
}

export function approveDiscount({ requested_pct, nights, check_in, has_peak_nights }) {
  if (!Number.isFinite(requested_pct) || requested_pct < 0 || requested_pct > 100) throw new Error('Requested discount must be between 0 and 100');
  const d = store.policy.discount;
  const lead_days = daysBetween(store.today(), check_in);
  let allowed = 0;
  if (nights >= d.min_nights || lead_days >= d.min_lead_days) allowed = d.max_pct;
  if (has_peak_nights) allowed = Math.min(allowed, d.peak_cap_pct);
  const approved = Math.max(0, Math.min(requested_pct, allowed));
  const reasons = [];
  if (nights >= d.min_nights) reasons.push(`${nights} nights meets the ${d.min_nights}-night threshold`);
  if (lead_days >= d.min_lead_days) reasons.push(`${lead_days} days lead time meets the ${d.min_lead_days}-day threshold`);
  if (has_peak_nights) reasons.push(`peak nights cap discounts at ${d.peak_cap_pct}%`);
  if (allowed === 0) reasons.push('neither the night nor lead-time threshold is met');
  return {
    requested_pct, approved_pct: approved, allowed_pct: allowed, lead_days,
    needs_owner: requested_pct > allowed, explanation: reasons.join('; '),
  };
}

export function cancellationTerms(booking, onDate = store.today()) {
  const policy = booking.policy_snapshot || store.policy;
  const tiers = [...policy.cancellation_tiers].sort((a, b) => b.min_days_before - a.min_days_before);
  const days_before = daysBetween(onDate, booking.check_in);
  const tier = tiers.find((t) => days_before >= t.min_days_before) || tiers[tiers.length - 1];
  const paid = money((booking.deposit_paid ? booking.deposit_amount : 0) + (booking.balance_paid ? booking.balance_amount : 0));
  const refund_amount = money(paid * (tier.refund_pct / 100));
  return {
    days_before, refund_pct: tier.refund_pct, paid_total: paid, refund_amount,
    auto_approve: refund_amount <= store.policy.refund_auto_approve_limit,
    tiers,
  };
}

export function describePolicy() {
  const p = store.policy;
  const tiers = [...p.cancellation_tiers].sort((a, b) => b.min_days_before - a.min_days_before)
    .map((t) => `${t.min_days_before}+ days before check-in: ${t.refund_pct}% refund`).join('; ');
  return [
    `Deposit ${p.deposit_pct}% at booking, balance due ${p.balance_due_days} days before check-in.`,
    `Cancellation: ${tiers}.`,
    `Taxes ${p.tax_pct}%. Prices in ${p.currency}.`,
    `Discounts: up to ${p.discount.max_pct}% for ${p.discount.min_nights}+ nights or ${p.discount.min_lead_days}+ days lead time; capped at ${p.discount.peak_cap_pct}% on peak dates. Anything beyond needs the owner.`,
  ].join(' ');
}
