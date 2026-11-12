import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { runToolLoop, llmAvailable } from './llm.js';
import { logAction, redact } from '../actions.js';
import { money, nightsBetween } from '../dates.js';

export async function runTravelerAgent({ travelerId, brief, serverUrl, accessToken, onEvent = () => {} }) {
  const traveler = store.get('travelers', travelerId);
  if (!traveler) throw new Error('Traveler not found');
  if (!traveler.payment_token_id) throw new Error('Traveler has not linked PayPal yet (no saved payment token)');
  const remaining = money(traveler.budget_total - (traveler.committed || 0));
  const policy = { budget_total: traveler.budget_total, remaining, max_nightly: brief.max_nightly || null, min_refund_pct: brief.min_refund_pct ?? 50 };
  const emit = (e) => {
    const safe = JSON.stringify(redact(e)).split(traveler.payment_token_id).join('[REDACTED]');
    onEvent({ ts: new Date().toISOString(), ...JSON.parse(safe) });
  };
  emit({ type: 'policy', text: `Spend governor armed: total budget ${traveler.budget_total}, remaining ${remaining}${policy.max_nightly ? `, nightly cap ${policy.max_nightly}` : ''}. The agent may negotiate freely but cannot pay beyond these limits.` });

  const client = new Client({ name: 'traveler-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  await client.connect(transport);
  const { tools } = await client.listTools();
  emit({ type: 'mcp', text: `Connected to property MCP server at ${serverUrl}; ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}` });

  const spentBefore = traveler.spent || 0;
  let paidBooking = null;
  const guarded = async (name, args) => {
    const check = governor(name, args, policy, traveler);
    if (!check.ok) {
      emit({ type: 'policy_block', text: check.reason, name, args });
      logAction({ actor: 'traveler_agent', tool: name, args, result: `BLOCKED by spend governor: ${check.reason}`, ok: false });
      return { error: `Blocked by the traveller's spend policy: ${check.reason}` };
    }
    if (check.note) emit({ type: 'policy', text: check.note });
    emit({ type: 'tool_call', name, args });
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.find((c) => c.type === 'text')?.text || '{}';
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    emit({ type: 'tool_result', name, result: parsed });
    if (name === 'create_hold' && parsed.booking) policy.pending_total = parsed.booking.total;
    if (name === 'pay_deposit_with_token' && parsed.booking?.deposit_paid) {
      paidBooking = parsed.booking;
      logAction({ actor: 'traveler_agent', tool: 'pay_deposit_with_token', args: { booking_id: parsed.booking.id }, result: `Deposit ${parsed.booking.deposit_amount} paid within budget (${remaining} available)`, booking_id: parsed.booking.id });
    }
    return parsed;
  };

  try {
    let summary;
    if (llmAvailable()) summary = await llmTraveler({ traveler, brief, tools, guarded, emit, policy });
    else summary = await scriptedTraveler({ traveler, brief, guarded, emit, policy });
    emit({ type: 'done', text: summary, booking: paidBooking, spent_delta: money((store.get('travelers', traveler.id).spent || 0) - spentBefore) });
    return { summary, booking: paidBooking };
  } finally {
    await client.close().catch(() => {});
  }
}

function governor(name, args, policy, traveler) {
  if (name === 'pay_deposit_with_token') {
    if (args.payment_token_id && args.payment_token_id !== traveler.payment_token_id) return { ok: false, reason: 'Payment token does not belong to this traveller' };
    const booking = store.get('bookings', args.booking_id);
    if (!booking) return { ok: false, reason: 'Unknown booking' };
    if (booking.total > policy.remaining) return { ok: false, reason: `Booking total ${booking.total} exceeds remaining budget ${policy.remaining}` };
    if (policy.max_nightly && booking.total / booking.nights > policy.max_nightly) return { ok: false, reason: `Average nightly ${money(booking.total / booking.nights)} exceeds cap ${policy.max_nightly}` };
    return { ok: true, note: `Governor check passed: total ${booking.total} within remaining ${policy.remaining}; paying deposit ${booking.deposit_amount}.` };
  }
  if (name === 'create_hold') {
    if (args.guest_email !== traveler.email) return { ok: false, reason: 'Hold must be in the traveller\'s own name and email' };
  }
  return { ok: true };
}

async function llmTraveler({ traveler, brief, tools, guarded, emit, policy }) {
  const system = `You are ${traveler.name}'s personal travel agent, booking on their behalf through a property's MCP tools. Today is ${store.today()}.
Brief: ${JSON.stringify(brief)}.
Hard limits enforced by code (you cannot override them): total budget ${policy.budget_total}, remaining ${policy.remaining}${policy.max_nightly ? `, nightly cap ${policy.max_nightly}` : ''}.
Steps: check availability for the dates and party, quote the best-fitting room (honour the traveller's preferences), always request a discount of 10% via requested_discount_pct and accept whatever policy approves, create_hold with guest_name "${traveler.name}" and guest_email "${traveler.email}", then pay the deposit with pay_deposit_with_token using only the booking_id. The server resolves the consented payment method; never request or provide a payment token. Prefer the cheapest room that meets the preferences if the first choice exceeds budget. Finish with a two-sentence summary for the traveller including the booking id, total, deposit paid and balance due date. Never claim a payment happened unless the tool confirmed it.`;
  const anthropicTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const out = await runToolLoop({ system, messages: [{ role: 'user', content: 'Please book this trip within my limits.' }], tools: anthropicTools, execute: guarded, maxTurns: 14, onEvent: (e) => { if (e.type === 'assistant_text') emit({ type: 'thought', text: e.text }); } });
  return out.text;
}

async function scriptedTraveler({ traveler, brief, guarded, emit, policy }) {
  const { check_in, check_out, guests = 2, preference = '' } = brief;
  emit({ type: 'thought', text: `Looking for ${guests} guests, ${check_in} to ${check_out}${preference ? `, preference: ${preference}` : ''}.` });
  const avail = await guarded('check_availability', { check_in, check_out, guests });
  if (avail.error) return `Could not check availability: ${avail.error}`;
  const free = avail.rooms.filter((r) => r.available_units > 0 && r.fits_party);
  if (!free.length) return 'No rooms fit the party on those dates.';
  const nights = nightsBetween(check_in, check_out);
  const pref = preference.toLowerCase();
  const scored = free.map((r) => ({ r, score: (pref && (r.name + ' ' + r.description).toLowerCase().split(/\W+/).some((w) => w && pref.includes(w)) ? 1 : 0), est: r.base_rate * nights }))
    .sort((a, b) => b.score - a.score || a.est - b.est);
  emit({ type: 'thought', text: `${free.length} options. Ranking by preference match then price: ${scored.map((s) => s.r.name).join(' > ')}.` });
  for (const { r } of scored) {
    const q = await guarded('get_quote', { room_id: r.room_id, check_in, check_out, guests, requested_discount_pct: 10 });
    if (q.error) continue;
    emit({ type: 'thought', text: `${r.name}: ${q.quote.currency} ${q.quote.total} after ${q.discount.approved_pct}% approved discount (${q.discount.explanation}).` });
    if (q.quote.total > policy.remaining) { emit({ type: 'policy', text: `${r.name} at ${q.quote.total} exceeds remaining budget ${policy.remaining}; trying the next option.` }); continue; }
    if (policy.max_nightly && q.quote.total / nights > policy.max_nightly) { emit({ type: 'policy', text: `${r.name} averages ${money(q.quote.total / nights)}/night, above the ${policy.max_nightly} cap.` }); continue; }
    const hold = await guarded('create_hold', { room_id: r.room_id, check_in, check_out, guests, guest_name: traveler.name, guest_email: traveler.email, requested_discount_pct: 10 });
    if (hold.error) continue;
    const paid = await guarded('pay_deposit_with_token', { booking_id: hold.booking.id });
    if (paid.error) return `Hold ${hold.booking.id} created but payment was refused: ${paid.error}`;
    const b = paid.booking;
    return `Booked ${b.room} at ${store.property.name}, ${b.check_in} to ${b.check_out} for ${b.guests}, booking ${b.id}. Total ${b.currency} ${b.total} with ${b.discount_pct}% negotiated off; deposit ${b.currency} ${b.deposit_amount} paid from your saved PayPal, balance ${b.currency} ${b.balance_amount} auto-collected on ${b.balance_due_date}.`;
  }
  return 'Every option that fit the dates broke the budget or the nightly cap. Nothing was paid.';
}

export const travelerServerUrl = () => `${config.baseUrl.replace(/\/$/, '')}/mcp`;
