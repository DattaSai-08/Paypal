const $ = (s) => document.querySelector(s);
const state = { key: sessionStorage.getItem('innkeeper.ownerKey') || '', data: null, grids: {}, chart: null };
const money = (n, c = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(Number(n || 0)); } catch { return `${c} ${Number(n || 0).toFixed(2)}`; } };
const headers = () => ({ 'Content-Type': 'application/json', 'x-owner-key': state.key });
const get = (url) => fetch(url, { headers: headers() }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const post = (url, body = {}) => fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });

const theme = agGrid.themeQuartz.withParams({
  accentColor: '#2f5d3a', backgroundColor: '#ffffff', foregroundColor: '#1e2a22', headerBackgroundColor: '#f3f5f0', borderColor: '#d7ded6',
  fontFamily: { googleFont: 'Instrument Sans' }, headerFontWeight: 600, fontSize: 13, rowHeight: 36, headerHeight: 38, wrapperBorderRadius: 10,
});
const statusPill = (p) => { const v = p.value || ''; const cls = v === 'CONFIRMED' || v === 'COMPLETED' || v === 'SUCCESS' ? '' : v === 'HOLD' || v === 'PENDING' || v === 'SENT' ? 'warn' : v === 'CANCELLED' || v === 'FAILED' || v === 'EXPIRED' ? 'bad' : 'neutral'; return `<span class="pill ${cls}">${v}</span>`; };
const yesNo = (p) => (p.value ? 'yes' : 'no');
const when = (p) => (p.value ? String(p.value).replace('T', ' ').slice(0, 16) : '');

function grid(id, options) {
  if (state.grids[id]) { state.grids[id].setGridOption('rowData', options.rowData); return state.grids[id]; }
  state.grids[id] = agGrid.createGrid(document.getElementById(id), { theme, animateRows: false, defaultColDef: { sortable: true, filter: true, resizable: true, flex: 1, minWidth: 90 }, ...options });
  return state.grids[id];
}

function renderGrids(d) {
  grid('grid-bookings', {
    rowData: d.bookings, onRowClicked: (e) => openBooking(e.data.id),
    columnDefs: [
      { field: 'id', headerName: 'Booking', width: 150, flex: 0 }, { field: 'status', cellRenderer: statusPill, width: 130, flex: 0 }, { field: 'guest_name', headerName: 'Guest', minWidth: 140 },
      { field: 'room', minWidth: 150 }, { field: 'check_in', headerName: 'Check-in', width: 115, flex: 0 }, { field: 'nights', width: 80, flex: 0 }, { field: 'channel', headerName: 'Via', width: 110, flex: 0, valueFormatter: (p) => (p.value === 'mcp' ? 'agent' : p.value) },
      { field: 'total', width: 120, flex: 0, valueFormatter: (p) => money(p.value, p.data.currency) }, { field: 'deposit_paid', headerName: 'Deposit', width: 95, flex: 0, valueFormatter: yesNo, cellDataType: 'text' },
      { field: 'balance_amount', headerName: 'Balance', width: 120, flex: 0, valueFormatter: (p) => money(p.value, p.data.currency) }, { field: 'balance_paid', headerName: 'Settled', width: 90, flex: 0, valueFormatter: yesNo, cellDataType: 'text' },
      { field: 'balance_due_date', headerName: 'Balance due', width: 125, flex: 0 }, { field: 'discount_pct', headerName: 'Disc. %', width: 90, flex: 0 }, { field: 'vault', headerName: 'Saved PayPal', width: 120, flex: 0, valueFormatter: yesNo, cellDataType: 'text' },
    ],
  });
  grid('grid-payments', {
    rowData: d.payments,
    columnDefs: [
      { field: 'created_at', headerName: 'When', valueFormatter: when, minWidth: 150 }, { field: 'type', cellRenderer: statusPill, maxWidth: 120 }, { field: 'booking_id', headerName: 'Booking', minWidth: 150 },
      { field: 'amount', valueFormatter: (p) => money(p.value, p.data.currency) }, { field: 'status', cellRenderer: statusPill, maxWidth: 130 }, { field: 'paypal_kind', headerName: 'PayPal object', maxWidth: 130 }, { field: 'paypal_id', headerName: 'PayPal id', minWidth: 200 }, { field: 'via', maxWidth: 160 },
    ],
  });
  grid('grid-payouts', {
    rowData: d.payouts,
    columnDefs: [{ field: 'vendor_name', headerName: 'Partner', valueGetter: (p) => p.data.vendor_name || p.data.vendor_id }, { field: 'extra_name', headerName: 'Service' }, { field: 'amount', valueFormatter: (p) => money(p.value, p.data.currency) }, { field: 'status', cellRenderer: statusPill }, { field: 'paypal_batch_id', headerName: 'Payout batch', minWidth: 170 }],
  });
  grid('grid-actions', {
    rowData: d.actions,
    columnDefs: [
      { field: 'ts', headerName: 'When', valueFormatter: when, minWidth: 150 }, { field: 'actor', maxWidth: 130 }, { field: 'tool', minWidth: 170 }, { field: 'booking_id', headerName: 'Booking', minWidth: 140 },
      { field: 'result', minWidth: 300, flex: 2 }, { field: 'paypal_call', headerName: 'PayPal call', minWidth: 260, flex: 2 }, { field: 'ok', maxWidth: 80, valueFormatter: yesNo, cellDataType: 'text' },
    ],
  });
}

function renderKpis(k, d) {
  const items = [[money(k.collected), 'Collected via PayPal'], [money(k.deposits_held), 'Deposits held for upcoming stays'], [money(k.balance_outstanding), 'Balances still to collect'], [money(k.paid_out), 'Paid to partners'], [money(k.refunded), 'Refunded under policy'], [`${k.agent_bookings} of ${d.bookings.length}`, 'Bookings made by other agents']];
  $('#kpis').innerHTML = items.map(([n, l]) => `<div><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}

function renderChart(rows) {
  const el = $('#cash-chart');
  if (window.agCharts?.AgCharts) {
    const options = { container: el, data: rows, series: [{ type: 'bar', xKey: 'week_start', yKey: 'balance_due', yName: 'Balance due', fill: '#2f5d3a', cornerRadius: 4 }], axes: [{ type: 'category', position: 'bottom', label: { rotation: 0, formatter: (p) => p.value.slice(5) } }, { type: 'number', position: 'left', label: { formatter: (p) => `$${p.value}` } }], background: { fill: 'transparent' }, padding: { top: 8, right: 8, bottom: 4, left: 4 } };
    if (state.chart) state.chart.update(options); else state.chart = agCharts.AgCharts.create(options);
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.balance_due));
  el.innerHTML = `<div class="cash">${rows.map((r) => `<div class="col"><div class="bar" style="height:${Math.round((r.balance_due / max) * 150)}px" title="${money(r.balance_due)}"></div>${r.week_start.slice(5)}</div>`).join('')}</div>`;
}

function renderEscalations(list) {
  const open = list.filter((e) => e.status === 'OPEN');
  const closed = list.filter((e) => e.status !== 'OPEN');
  const item = (e) => `<div class="esc"><div class="row"><span class="kind">${escapeHtml(label(e.kind))}</span><span class="pill">${escapeHtml(e.status)}</span><span class="small muted">${escapeHtml(e.booking_id || '')}</span></div><p style="margin-top:6px">${escapeHtml(e.summary)}</p>${e.status === 'OPEN' ? `<div class="actions"><button class="primary" data-approve="${escapeHtml(e.id)}">Approve</button><button data-decline="${escapeHtml(e.id)}">Decline</button></div>` : `<p class="small muted">${escapeHtml(e.note || '')}</p>`}</div>`;
  $('#esc-list').innerHTML = (open.length ? open.map(item).join('') : '<p class="muted">Nothing waiting on you. The agent is handling everything inside policy.</p>') + (closed.length ? `<h3 style="margin:18px 0 8px">Resolved</h3>${closed.map(item).join('')}` : '');
  $('#esc-list').querySelectorAll('[data-approve]').forEach((b) => { b.onclick = () => decide(b.dataset.approve, 'APPROVE'); });
  $('#esc-list').querySelectorAll('[data-decline]').forEach((b) => { b.onclick = () => decide(b.dataset.decline, 'DECLINE'); });
  const tab = $('[data-tab="escalations"]'); tab.textContent = open.length ? `Needs you (${open.length})` : 'Needs you';
}
const label = (k) => ({ REFUND_APPROVAL: 'Refund above your limit', DISCOUNT_APPROVAL: 'Discount above policy', GENERAL: 'Guest request' }[k] || k);
async function decide(id, decision) { await post(`/api/owner/escalations/${id}`, { decision }); await refresh(); }

function renderPolicy(p, text) {
  const f = $('#policy-form');
  f.deposit_pct.value = p.deposit_pct; f.balance_due_days.value = p.balance_due_days; f.tax_pct.value = p.tax_pct; f.refund_auto_approve_limit.value = p.refund_auto_approve_limit; f.agent_tone.value = p.agent_tone || '';
  f['discount.max_pct'].value = p.discount.max_pct; f['discount.min_nights'].value = p.discount.min_nights; f['discount.min_lead_days'].value = p.discount.min_lead_days; f['discount.peak_cap_pct'].value = p.discount.peak_cap_pct;
  $('#tiers').innerHTML = p.cancellation_tiers.map((t, i) => `<div class="row" style="margin-bottom:6px"><input data-tier="${i}" data-k="min_days_before" type="number" value="${t.min_days_before}" style="max-width:110px"> <span class="small muted">days or more before check-in refunds</span> <input data-tier="${i}" data-k="refund_pct" type="number" value="${t.refund_pct}" style="max-width:90px"> <span class="small muted">%</span></div>`).join('');
  $('#policy-text').textContent = text;
  $('#mcp-url').textContent = `${location.origin}/mcp`;
}

async function savePolicy(e) {
  e.preventDefault();
  const f = e.target;
  const tiers = [...$('#tiers').querySelectorAll('input')].reduce((acc, i) => { acc[i.dataset.tier] = acc[i.dataset.tier] || {}; acc[i.dataset.tier][i.dataset.k] = Number(i.value); return acc; }, []);
  const body = { deposit_pct: f.deposit_pct.value, balance_due_days: f.balance_due_days.value, tax_pct: f.tax_pct.value, refund_auto_approve_limit: f.refund_auto_approve_limit.value, agent_tone: f.agent_tone.value, discount: { max_pct: f['discount.max_pct'].value, min_nights: f['discount.min_nights'].value, min_lead_days: f['discount.min_lead_days'].value, peak_cap_pct: f['discount.peak_cap_pct'].value }, cancellation_tiers: tiers };
  const out = await post('/api/owner/policy', body);
  $('#policy-saved').textContent = 'Saved. The agent uses the new rules from the next message.';
  renderPolicy(out.policy, out.policy_text);
}

async function openBooking(id) {
  const d = await get(`/api/owner/booking/${id}`);
  const b = escapeStrings(d.booking);
  $('#drawer-body').innerHTML = `
    <h2>${b.room_name}</h2><p class="muted">${b.guest_name} (${b.guest_email}), ${b.check_in} to ${b.check_out}, ${b.nights} nights, ${b.guests} guests</p>
    <p><span class="pill">${b.status}</span> <span class="pill neutral">${b.channel === 'mcp' ? 'booked by an agent over MCP' : b.channel}</span>${b.vault_id ? ' <span class="pill neutral">saved PayPal on file</span>' : ''}</p>
    <div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div><div class="n">${money(b.total, b.currency)}</div><div class="l">Total, ${b.discount_pct}% discount</div></div><div><div class="n">${money(b.deposit_amount, b.currency)}</div><div class="l">Deposit ${b.deposit_paid ? 'paid' : 'unpaid'}</div></div><div><div class="n">${money(b.balance_amount, b.currency)}</div><div class="l">Balance ${b.balance_paid ? 'paid' : `due ${b.balance_due_date}`}</div></div></div>
    ${b.extras?.length ? `<h3>Extras</h3><ul class="timeline">${b.extras.map((x) => `<li>${x.qty} x ${x.name} on ${x.date}: ${money(x.line_total, b.currency)}${x.vendor_id ? ` (partner payout ${x.payout_status.toLowerCase()})` : ''}</li>`).join('')}</ul>` : ''}
    <h3 style="margin-top:14px">PayPal objects</h3><pre>${JSON.stringify(b.paypal, null, 2)}</pre>
    <h3 style="margin-top:14px">Timeline</h3><ul class="timeline">${(b.timeline || []).map((t) => `<li><time>${t.at.replace('T', ' ').slice(0, 16)}</time>${t.event}</li>`).join('')}</ul>
    ${d.conversation.length ? `<h3 style="margin-top:14px">Guest transcript</h3><div class="transcript">${d.conversation.map((m) => `<div class="m ${m.role}">${escapeHtml(m.content)}</div>`).join('')}</div>` : ''}`;
  $('#drawer').classList.add('open');
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeStrings = (v) => typeof v === 'string' ? escapeHtml(v) : Array.isArray(v) ? v.map(escapeStrings) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escapeStrings(x)])) : v;

async function loadDisputes() {
  $('#dispute-list').innerHTML = '<p class="muted">Loading from PayPal…</p>';
  const d = escapeStrings(await get('/api/owner/disputes'));
  if (d.error) { $('#dispute-list').innerHTML = `<p class="muted">PayPal returned: ${d.error}</p>`; return; }
  if (!d.items.length) { $('#dispute-list').innerHTML = '<p class="muted">No open disputes on this account.</p>'; return; }
  $('#dispute-list').innerHTML = d.items.map((x) => `<div class="esc"><div class="row"><span class="kind">${x.dispute_id}</span><span class="pill warn">${x.status}</span><span class="small muted">${x.reason}</span><span class="grow"></span><b>${money(x.dispute_amount?.value, x.dispute_amount?.currency_code)}</b></div><p style="margin-top:6px">${x.messages?.[0]?.content || ''}</p><p class="small muted">${x.booking ? `Matched to booking ${x.booking.id}: ${x.booking.guest_name}, ${x.booking.room_name}, ${x.booking.check_in}` : 'No matching booking found'}</p>${x.booking ? `<div class="actions"><button data-preview="${x.dispute_id}">Preview evidence pack</button><button class="primary" data-submit="${x.dispute_id}">Submit evidence to PayPal</button></div><pre class="small" id="ev-${x.dispute_id}" hidden></pre>` : ''}</div>`).join('');
  $('#dispute-list').querySelectorAll('[data-preview]').forEach((b) => { b.onclick = async () => { const p = await get(`/api/owner/disputes/${b.dataset.preview}/evidence`); const pre = $(`#ev-${b.dataset.preview}`); pre.hidden = false; pre.textContent = p.text; }; });
  $('#dispute-list').querySelectorAll('[data-submit]').forEach((b) => { b.onclick = async () => { b.disabled = true; const r = await post(`/api/owner/disputes/${b.dataset.submit}/evidence`); b.textContent = 'Submitted'; const pre = $(`#ev-${b.dataset.submit}`); pre.hidden = false; pre.textContent = r.pack.text; }; });
}

async function refresh() {
  const d = await get('/api/owner/overview');
  state.data = d;
  $('#prop-name').textContent = `${d.property.name} back office`;
  $('#date-line').textContent = `Today ${d.today}${d.clock.offset_days ? ` (simulated, +${d.clock.offset_days} days)` : ''}`;
  $('#mode-pill').textContent = `PayPal ${d.paypal_mode}`;
  $('#ai-pill').textContent = `Agent: ${d.ai}`;
  renderKpis(d.kpis, d); renderGrids(d); renderChart(d.cashflow); renderEscalations(d.escalations);
  if (!$('#policy-form').contains(document.activeElement)) renderPolicy(d.policy, d.policy_text || '');
}

async function clock(body) { const out = await post('/api/owner/clock', body); await refresh(); toast(summarise(out.report)); }
function summarise(r) { const parts = []; if (r.balances?.length) parts.push(`${r.balances.length} balance action(s): ${r.balances.map((b) => b.action).join(', ')}`); if (r.payouts?.length) parts.push(`${r.payouts.length} partner payout(s)`); if (r.expired_holds) parts.push(`${r.expired_holds} hold(s) expired`); if (r.completed?.length) parts.push(`${r.completed.length} stay(s) completed`); if (r.errors?.length) parts.push(`${r.errors.length} error(s): ${r.errors.map((e) => e.error).join('; ')}`); return parts.length ? parts.join('. ') : 'Nothing was due.'; }
function toast(text) { const t = document.createElement('div'); t.className = 'esc'; t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);max-width:640px;z-index:30;border-color:#2f5d3a'; t.textContent = text; document.body.appendChild(t); setTimeout(() => t.remove(), 6000); }

async function init() {
  $('#key').value = state.key;
  try { await refresh(); $('#app').hidden = false; } catch (e) { $('#auth').hidden = false; }
  localStorage.removeItem('innkeeper.ownerKey');
  $('#unlock').onclick = async () => { state.key = $('#key').value.trim(); sessionStorage.setItem('innkeeper.ownerKey', state.key); try { await refresh(); $('#auth').hidden = true; $('#app').hidden = false; } catch (e) { toast(e.message); } };
  $('#tabs').querySelectorAll('button').forEach((b) => { b.onclick = () => { $('#tabs .active').classList.remove('active'); b.classList.add('active'); document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active')); $(`#panel-${b.dataset.tab}`).classList.add('active'); }; });
  $('#plus7').onclick = () => clock({ days: 7 }); $('#plus1').onclick = () => clock({ days: 1 }); $('#reset-clock').onclick = () => clock({ reset: true });
  $('#run-jobs').onclick = async () => { const r = await post('/api/owner/run-jobs'); await refresh(); toast(summarise(r)); };
  $('#reset-demo').onclick = async () => { if (confirm('Reset all demo data? Bookings, logs and clock go back to the seed.')) { await post('/api/owner/reset-demo'); location.reload(); } };
  $('#policy-form').addEventListener('submit', savePolicy);
  $('#drawer-close').onclick = () => $('#drawer').classList.remove('open');
  $('#load-disputes').onclick = loadDisputes;
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 8000);
}
init();
