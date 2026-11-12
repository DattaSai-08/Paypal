import { store } from './store.js';
import { addDays } from './dates.js';
import { isMockPayPal } from './config.js';

export const defaultPolicy = () => ({
  currency: 'USD',
  deposit_pct: 30,
  balance_due_days: 7,
  hold_minutes: 30,
  tax_pct: 12,
  cancellation_tiers: [
    { min_days_before: 14, refund_pct: 100 },
    { min_days_before: 7, refund_pct: 50 },
    { min_days_before: 0, refund_pct: 0 },
  ],
  discount: { max_pct: 10, min_nights: 3, min_lead_days: 14, peak_cap_pct: 5 },
  refund_auto_approve_limit: 250,
  vendor_payout_delay_days: 0,
  no_show_fee_pct: 100,
  agent_tone: 'warm, precise, never pushy',
});

const property = () => ({
  id: 'prop_cinnamon_ridge',
  name: 'Cinnamon Ridge Stays',
  tagline: 'Eight rooms on a working coffee estate in Coorg, Karnataka',
  location: 'Madikeri, Kodagu, Karnataka, India',
  timezone: 'Asia/Kolkata',
  check_in_time: '14:00',
  check_out_time: '11:00',
  owner_name: 'Meera Kuttappa',
  owner_email: 'owner@cinnamonridge.example',
  currency: 'USD',
  description:
    'A family-run estate stay with eight rooms, estate walks, a plantation breakfast, and guided treks to Tadiandamol. Nearest airport is Mangalore (3.5 h) or Bengaluru (6 h). Pets allowed in the cottages only.',
  faq: [
    { q: 'Is breakfast included?', a: 'Yes, a plantation breakfast is included for all rooms.' },
    { q: 'Do you have Wi-Fi?', a: 'Yes in all rooms, though speeds drop during heavy rain.' },
    { q: 'Can you arrange airport pickup?', a: 'Yes, from Mangalore or Bengaluru airports, charged as an extra and paid to our transport partner.' },
    { q: 'Is the property child friendly?', a: 'Yes. Children under 6 stay free; a cot can be added to any room.' },
    { q: 'What is the best season?', a: 'October to March is dry and cool. Monsoon (June to September) is lush but wet.' },
  ],
  peak_periods: [
    { from: '2026-12-20', to: '2027-01-03', multiplier: 1.35, label: 'Christmas and New Year' },
    { from: '2026-11-01', to: '2026-11-08', multiplier: 1.2, label: 'Diwali week' },
    { from: '2027-04-10', to: '2027-04-18', multiplier: 1.15, label: 'Spring break' },
  ],
});

const rooms = () => ([
  { id: 'room_estate_view', name: 'Estate View Room', count: 3, base_rate: 95, max_guests: 2, description: 'Queen bed, private balcony over the coffee bushes.' },
  { id: 'room_family_suite', name: 'Family Suite', count: 2, base_rate: 160, max_guests: 4, description: 'Two bedrooms, sitting area, valley view.' },
  { id: 'room_planters_cottage', name: "Planter's Cottage", count: 2, base_rate: 210, max_guests: 3, description: 'Standalone cottage with fireplace and private garden. Pet friendly.' },
  { id: 'room_treehouse', name: 'Treehouse Loft', count: 1, base_rate: 240, max_guests: 2, description: 'Elevated loft among silver oaks, outdoor shower.' },
]);

const vendors = () => ([
  { id: 'vnd_coorg_cabs', name: 'Coorg Hill Cabs', service: 'Airport and local transfers', paypal_email: 'coorg-cabs@example.com' },
  { id: 'vnd_trek_guides', name: 'Kodagu Trek Collective', service: 'Guided treks', paypal_email: 'kodagu-treks@example.com' },
  { id: 'vnd_estate_kitchen', name: 'Thimmaiah Home Kitchen', service: 'Kodava dinners', paypal_email: 'thimmaiah-kitchen@example.com' },
]);

const extras = () => ([
  { id: 'xp_airport_pickup', name: 'Airport pickup from Mangalore', price: 70, vendor_id: 'vnd_coorg_cabs', vendor_share: 60, unit: 'per trip' },
  { id: 'xp_tadiandamol_trek', name: 'Guided Tadiandamol trek', price: 45, vendor_id: 'vnd_trek_guides', vendor_share: 35, unit: 'per person' },
  { id: 'xp_kodava_dinner', name: 'Traditional Kodava dinner', price: 30, vendor_id: 'vnd_estate_kitchen', vendor_share: 22, unit: 'per person' },
  { id: 'xp_estate_walk', name: 'Coffee estate walk and tasting', price: 15, vendor_id: null, vendor_share: 0, unit: 'per person' },
]);

export function seedIfEmpty({ reset = false } = {}) {
  return store.transaction(() => seedOnce(reset));
}

function seedOnce(reset) {
  if (reset && !isMockPayPal()) throw new Error('Demo reset is disabled outside mock mode');
  if (reset) store.reset();
  if (store.property) return false;

  store.setProperty(property());
  store.setPolicy(defaultPolicy());
  rooms().forEach((r) => store.insert('rooms', r));
  vendors().forEach((v) => store.insert('vendors', v));
  extras().forEach((x) => store.insert('extras', x));
  if (isMockPayPal()) seedBookings();
  store.flush();
  return true;
}

function seedBookings() {
  const today = store.today();
  const mk = (b) => store.insert('bookings', { source: 'seed', channel: 'web', currency: 'USD', extras: [], timeline: [{ at: store.now().toISOString(), event: 'Seeded demo booking' }], balance_due_date: addDays(b.check_in, -7), ...b });
  const pay = (p) => store.insert('payments', { currency: 'USD', status: 'COMPLETED', source: 'seed', ...p });

  const b1 = mk({
    room_id: 'room_family_suite', room_name: 'Family Suite', check_in: addDays(today, 3), check_out: addDays(today, 6), nights: 3,
    guests: 4, guest_name: 'Hannah Brooks', guest_email: 'hannah.brooks@example.com', status: 'CONFIRMED',
    total: 537.6, deposit_amount: 161.28, balance_amount: 376.32, deposit_paid: true, balance_paid: true,
    paypal: { deposit_order_id: 'SEED-ORD-1', deposit_capture_id: 'SEED-CAP-1', balance_capture_id: 'SEED-CAP-1B' },
    discount_pct: 0,
  });
  pay({ booking_id: b1.id, type: 'DEPOSIT', amount: 161.28, paypal_id: 'SEED-CAP-1' });
  pay({ booking_id: b1.id, type: 'BALANCE', amount: 376.32, paypal_id: 'SEED-CAP-1B' });

  const b2 = mk({
    room_id: 'room_estate_view', room_name: 'Estate View Room', check_in: addDays(today, 12), check_out: addDays(today, 14), nights: 2,
    guests: 2, guest_name: 'Tomás Herrera', guest_email: 'tomas.herrera@example.com', status: 'CONFIRMED',
    total: 212.8, deposit_amount: 63.84, balance_amount: 148.96, deposit_paid: true, balance_paid: false,
    paypal: { deposit_order_id: 'SEED-ORD-2', deposit_capture_id: 'SEED-CAP-2' },
    discount_pct: 0,
  });
  pay({ booking_id: b2.id, type: 'DEPOSIT', amount: 63.84, paypal_id: 'SEED-CAP-2' });

  const b3 = mk({
    room_id: 'room_planters_cottage', room_name: "Planter's Cottage", check_in: addDays(today, 20), check_out: addDays(today, 24), nights: 4,
    guests: 2, guest_name: 'Aiko Tanaka', guest_email: 'aiko.tanaka@example.com', status: 'CANCELLED',
    total: 846.72, deposit_amount: 254.02, balance_amount: 592.7, deposit_paid: true, balance_paid: false,
    paypal: { deposit_order_id: 'SEED-ORD-3', deposit_capture_id: 'SEED-CAP-3', refund_id: 'SEED-REF-3' },
    discount_pct: 10, cancellation: { days_before: 21, refund_pct: 100, refund_amount: 254.02, reason: 'Flight cancelled' },
  });
  pay({ booking_id: b3.id, type: 'DEPOSIT', amount: 254.02, paypal_id: 'SEED-CAP-3' });
  pay({ booking_id: b3.id, type: 'REFUND', amount: 254.02, paypal_id: 'SEED-REF-3' });

  const b4 = mk({
    room_id: 'room_treehouse', room_name: 'Treehouse Loft', check_in: addDays(today, -5), check_out: addDays(today, -2), nights: 3,
    guests: 2, guest_name: 'Lena Fischer', guest_email: 'lena.fischer@example.com', status: 'COMPLETED',
    total: 1013.6, deposit_amount: 304.08, balance_amount: 709.52, deposit_paid: true, balance_paid: true,
    paypal: { deposit_order_id: 'SEED-ORD-4', deposit_capture_id: 'SEED-CAP-4', balance_capture_id: 'SEED-CAP-4B' },
    discount_pct: 0,
    extras: [{ id: 'xp_tadiandamol_trek', name: 'Guided Tadiandamol trek', qty: 2, price: 45, vendor_id: 'vnd_trek_guides', vendor_share: 35, date: addDays(today, -4), payout_status: 'PAID', payout_id: 'SEED-PO-4' }],
  });
  pay({ booking_id: b4.id, type: 'DEPOSIT', amount: 304.08, paypal_id: 'SEED-CAP-4' });
  pay({ booking_id: b4.id, type: 'BALANCE', amount: 709.52, paypal_id: 'SEED-CAP-4B' });
  pay({ booking_id: b4.id, type: 'PAYOUT', amount: 70, paypal_id: 'SEED-PO-4', vendor_id: 'vnd_trek_guides' });
  store.insert('payouts', { booking_id: b4.id, vendor_id: 'vnd_trek_guides', amount: 70, currency: 'USD', status: 'SUCCESS', paypal_batch_id: 'SEED-PO-4', source: 'seed' });

  const b5 = mk({
    room_id: 'room_estate_view', room_name: 'Estate View Room', check_in: addDays(today, 40), check_out: addDays(today, 43), nights: 3,
    guests: 2, guest_name: 'Priya Natarajan', guest_email: 'priya.n@example.com', status: 'CONFIRMED',
    total: 319.2, deposit_amount: 95.76, balance_amount: 223.44, deposit_paid: true, balance_paid: false,
    paypal: { deposit_order_id: 'SEED-ORD-5', deposit_capture_id: 'SEED-CAP-5' },
    discount_pct: 0,
  });
  pay({ booking_id: b5.id, type: 'DEPOSIT', amount: 95.76, paypal_id: 'SEED-CAP-5' });
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const reset = process.argv.includes('--reset');
  const did = seedIfEmpty({ reset });
  console.log(did ? 'Seeded demo data.' : 'Data already present; use --reset to start over.');
}
