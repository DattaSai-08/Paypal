import { store } from './store.js';
import { eachNight, overlaps, isIsoDate } from './dates.js';

const BLOCKING = new Set(['HOLD', 'CONFIRMED']);

export function activeHolds() {
  const now = store.now().toISOString();
  return store.find('bookings', (b) => b.status === 'HOLD' && b.hold_expires_at > now);
}

export function roomsAvailable(roomId, check_in, check_out, ignoreBookingId = null) {
  const room = store.get('rooms', roomId);
  if (!room) return 0;
  const now = store.now().toISOString();
  const blocking = store.find('bookings', (b) =>
    b.room_id === roomId && b.id !== ignoreBookingId && BLOCKING.has(b.status) &&
    (b.status !== 'HOLD' || b.hold_expires_at > now || b.payment_pending) && overlaps(b.check_in, b.check_out, check_in, check_out));
  let minFree = room.count;
  for (const night of eachNight(check_in, check_out)) {
    const used = blocking.filter((b) => b.check_in <= night && night < b.check_out).length;
    minFree = Math.min(minFree, room.count - used);
  }
  return Math.max(0, minFree);
}

export function availability(check_in, check_out, guests = 2) {
  if (!isIsoDate(check_in) || !isIsoDate(check_out)) throw new Error('Dates must be YYYY-MM-DD');
  if (check_out <= check_in) throw new Error('check_out must be after check_in');
  if (check_in < store.today()) throw new Error('check_in is in the past');
  return store.all('rooms').map((room) => ({
    room_id: room.id, name: room.name, base_rate: room.base_rate, max_guests: room.max_guests,
    description: room.description, available_units: roomsAvailable(room.id, check_in, check_out),
    fits_party: guests <= room.max_guests,
  }));
}

export function expireHolds() {
  const now = store.now().toISOString();
  const expired = store.find('bookings', (b) => b.status === 'HOLD' && b.hold_expires_at <= now && !b.deposit_paid && !b.payment_pending);
  for (const b of expired) {
    store.update('bookings', b.id, (row) => ({ ...row, status: 'EXPIRED', timeline: [...row.timeline, { at: now, event: 'Hold expired without deposit' }] }));
  }
  return expired.length;
}
