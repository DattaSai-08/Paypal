const $ = (s) => document.querySelector(s);
const state = { property: null, traveler: null, setupToken: null };
const post = (url, body = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const get = (url) => fetch(url).then((r) => r.json());
const plus = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function init() {
  state.property = await get('/api/property');
  $('#b-in').value = plus(state.property.today, 27);
  $('#b-out').value = plus(state.property.today, 30);
  $('#t-create').onclick = createTraveler;
  $('#run').onclick = run;
  const saved = localStorage.getItem('innkeeper.traveler');
  if (saved) { const t = await get(`/api/travelers/${saved}`).catch(() => null); if (t && t.id) { state.traveler = t; $('#t-name').value = t.name; $('#t-email').value = t.email; $('#t-budget').value = t.budget_total; afterTraveler(t); } }
  window.addEventListener('message', async (e) => { if (e.origin === location.origin && e.data?.type === 'mock-approved' && e.data.setup_token_id) exchange(e.data.setup_token_id); });
}

async function createTraveler() {
  const t = await post('/api/travelers', { name: $('#t-name').value, email: $('#t-email').value, budget_total: Number($('#t-budget').value) });
  state.traveler = t;
  localStorage.setItem('innkeeper.traveler', t.id);
  afterTraveler(t);
}

function afterTraveler(t) {
  $('#t-status').textContent = `Traveller ${t.id}: budget ${t.budget_total}, spent ${t.spent || 0}.`;
  if (t.linked) { $('#vault-status').textContent = `PayPal saved${t.paypal_email ? ` (${t.paypal_email})` : ''}. The agent can pay inside the budget.`; $('#run').disabled = false; $('#vault-mount').innerHTML = ''; return; }
  mountVault();
}

async function mountVault() {
  const mount = $('#vault-mount');
  mount.innerHTML = '';
  if (state.property.paypal.mode === 'mock') {
    const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Save PayPal for my agent (sandbox mock)';
    b.onclick = async () => { const s = await post('/api/vault/setup-token', { traveler_id: state.traveler.id }); state.setupToken = s.id; window.open(s.approve_url, 'paypal-vault', 'width=520,height=560'); $('#vault-status').textContent = 'Consent window open. This updates automatically once you agree.'; };
    mount.appendChild(b);
    return;
  }
  const { client_id } = state.property.paypal;
  const tok = await get(`/api/paypal/id-token?traveler_id=${encodeURIComponent(state.traveler.id)}`).catch(() => ({}));
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(client_id)}&components=buttons`;
    if (tok.id_token) s.setAttribute('data-user-id-token', tok.id_token);
    s.onload = resolve; s.onerror = () => reject(new Error('PayPal SDK failed to load'));
    document.head.appendChild(s);
  });
  window.paypal.Buttons({
    style: { layout: 'horizontal', color: 'blue', shape: 'rect', label: 'paypal', tagline: false },
    createVaultSetupToken: async () => { const s = await post('/api/vault/setup-token', { traveler_id: state.traveler.id }); return s.id; },
    onApprove: async ({ vaultSetupToken }) => exchange(vaultSetupToken),
    onError: (err) => { $('#vault-status').textContent = `PayPal error: ${err?.message || err}`; },
  }).render(mount);
}

async function exchange(setupTokenId) {
  $('#vault-status').textContent = 'Exchanging consent for a payment token…';
  try {
    const out = await post('/api/vault/payment-token', { traveler_id: state.traveler.id, setup_token_id: setupTokenId });
    state.traveler = await get(`/api/travelers/${state.traveler.id}`);
    $('#vault-status').textContent = `PayPal saved${out.paypal_email ? ` (${out.paypal_email})` : ''}. Customer ${out.customer_id}. The agent can now pay inside the budget.`;
    $('#vault-mount').innerHTML = '';
    $('#run').disabled = false;
  } catch (e) { $('#vault-status').textContent = `Could not save PayPal: ${e.message}`; }
}

function event(e) {
  const el = document.createElement('div');
  el.className = `ev ${e.type}`;
  const who = { policy: 'Spend governor (traveller side)', policy_block: 'Spend governor blocked this', mcp: 'MCP', thought: 'Traveller\'s agent', tool_call: 'Traveller\'s agent calls the property', tool_result: 'Property agent replies', done: 'Done', error: 'Error' }[e.type] || e.type;
  let body = e.text || '';
  if (e.type === 'tool_call') body = `${e.name}(${JSON.stringify(e.args || e.input || {})})`;
  if (e.type === 'tool_result') body = `${e.name}`;
  el.innerHTML = `<div class="who">${who}</div><div>${escapeHtml(body)}</div>`;
  if (e.type === 'tool_result') { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(e.result, null, 1).slice(0, 1800); el.appendChild(pre); }
  if (e.type === 'done' && e.booking) { const p = document.createElement('p'); p.className = 'small'; p.style.marginTop = '8px'; p.innerHTML = `Booking <b>${e.booking.id}</b> is <b>${e.booking.status}</b>. Deposit ${e.booking.currency} ${Number(e.booking.deposit_amount).toFixed(2)} paid from the saved PayPal; balance ${e.booking.currency} ${Number(e.booking.balance_amount).toFixed(2)} auto-collects on ${e.booking.balance_due_date}. <a href="/owner">See it land in the owner's back office.</a>`; el.appendChild(p); }
  $('#feed').appendChild(el);
  el.scrollIntoView({ block: 'nearest' });
}
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function run() {
  $('#run').disabled = true;
  $('#feed').innerHTML = '';
  $('#feed-intro').textContent = 'Live transcript between two agents. The property side runs the same tools a human guest gets; the traveller side cannot exceed the budget.';
  const brief = { check_in: $('#b-in').value, check_out: $('#b-out').value, guests: Number($('#b-guests').value), preference: $('#b-pref').value, max_nightly: Number($('#t-cap').value) || null };
  const res = await fetch('/api/traveler/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ traveler_id: state.traveler.id, brief, payment_consent: true }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const p of parts) { const line = p.replace(/^data: /, '').trim(); if (line) event(JSON.parse(line)); }
  }
  state.traveler = await get(`/api/travelers/${state.traveler.id}`);
  $('#t-status').textContent = `Traveller ${state.traveler.id}: budget ${state.traveler.budget_total}, spent ${state.traveler.spent || 0}.`;
  $('#run').disabled = false;
}

init();
