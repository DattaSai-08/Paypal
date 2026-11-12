import { store } from './store.js';

export function logAction({ actor, tool, args = {}, result = '', reasoning = '', booking_id = null, paypal_call = null, conversation_id = null, ok = true }) {
  return store.insert('actions', {
    ts: store.now().toISOString(), actor, tool, args: redact(args), result: String(result).slice(0, 500),
    reasoning: String(reasoning || '').slice(0, 500), booking_id, paypal_call, conversation_id, ok,
  });
}

export function escalate({ booking_id, kind, summary, proposed, actor = 'guest_agent', conversation_id = null }) {
  const existing = store.findOne('escalations', (e) => e.booking_id === booking_id && e.conversation_id === conversation_id && e.kind === kind && e.status === 'OPEN');
  if (existing) return store.update('escalations', existing.id, { summary, proposed });
  const esc = store.insert('escalations', { booking_id, kind, summary, proposed, status: 'OPEN', actor, conversation_id });
  logAction({ actor, tool: 'escalate_to_owner', args: { kind }, result: summary, booking_id, conversation_id });
  return esc;
}

export function timeline(bookingId, event, extra = {}) {
  return store.update('bookings', bookingId, (b) => ({ ...b, timeline: [...(b.timeline || []), { at: store.now().toISOString(), event, ...extra }] }));
}

export function redact(args) {
  if (Array.isArray(args)) return args.map(redact);
  if (!args || typeof args !== 'object') return args;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, /token|vault|secret|password|api.?key|authorization/i.test(key) ? '[REDACTED]' : redact(value)]));
}
