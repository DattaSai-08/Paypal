const $ = (s) => document.querySelector(s);
const state = { conversationId: localStorage.getItem('innkeeper.cid') || null, property: null, booking: null, poll: null, paypalReady: null };

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const get = (url) => fetch(url).then((r) => r.json());
const money = (n, c) => `${c || 'USD'} ${Number(n).toFixed(2)}`;

function addMessage(role, text, extra = {}) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  if (extra.paymentRequest) el.appendChild(payBox(extra.paymentRequest));
  $('#messages').appendChild(el);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return el;
}

function payBox(req) {
  const box = document.createElement('div');
  box.className = 'paybox';
  box.innerHTML = `<div class="small muted">Deposit for booking ${req.booking_id}</div><div class="amount">${money(req.amount, req.currency)}</div><div class="mount" id="pp-${req.order_id}"></div><div class="small muted status">Waiting for payment</div>`;
  setTimeout(() => mountPayment(req, box), 0);
  return box;
}

async function mountPayment(req, box) {
  const mount = box.querySelector('.mount');
  const status = box.querySelector('.status');
  if (state.property.paypal.mode === 'mock') {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Pay deposit with PayPal (sandbox mock)';
    b.onclick = () => { window.open(req.approve_url, 'paypal-mock', 'width=520,height=560'); status.textContent = 'Approve in the PayPal window, this updates automatically.'; };
    mount.appendChild(b);
    return;
  }
  await loadPayPalSdk();
  window.paypal.Buttons({
    style: { layout: 'horizontal', color: 'gold', shape: 'rect', label: 'pay', tagline: false },
    createOrder: () => req.order_id,
    onApprove: async () => {
      status.textContent = 'Capturing with PayPal…';
      try {
        const out = await post(`/api/paypal/orders/${req.order_id}/capture`, { booking_id: req.booking_id });
        status.textContent = `Captured. Booking ${out.booking.id} is confirmed.`;
        mount.innerHTML = '';
        setBooking(out.booking);
        renderChips();
        addMessage('system', 'PayPal capture complete. The owner dashboard and the balance schedule updated the moment the capture landed.');
      } catch (e) { status.textContent = `Capture failed: ${e.message}`; }
    },
    onCancel: () => { status.textContent = 'Payment cancelled. The hold stays open until it expires.'; },
    onError: (err) => { status.textContent = `PayPal error: ${err?.message || err}`; },
  }).render(mount);
}

function loadPayPalSdk() {
  if (state.paypalReady) return state.paypalReady;
  const { client_id, currency } = state.property.paypal;
  state.paypalReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(client_id)}&currency=${currency}&intent=capture&components=buttons`;
    s.onload = resolve; s.onerror = () => reject(new Error('PayPal SDK failed to load'));
    document.head.appendChild(s);
  });
  return state.paypalReady;
}

function setBooking(b) {
  state.booking = b;
  const steps = $('#loop').querySelectorAll('div');
  steps.forEach((s) => s.classList.remove('done', 'now'));
  if (!b) return;
  const mark = (k, cls) => $(`#loop [data-step="${k}"]`).classList.add(cls);
  if (['HOLD', 'CONFIRMED', 'COMPLETED'].includes(b.status)) mark('hold', 'done');
  if (b.deposit_paid) { mark('deposit', 'done'); mark('confirmed', 'done'); } else if (b.status === 'HOLD') mark('deposit', 'now');
  if (b.balance_paid) mark('balance', 'done'); else if (b.deposit_paid) mark('balance', 'now');
  if ((b.extras || []).length && b.balance_paid) mark('payout', 'now');
  if (b.status === 'CANCELLED') steps.forEach((s) => s.classList.remove('now'));
  if (b.status === 'HOLD' && !b.deposit_paid) startPolling(b.id); else stopPolling();
}

function startPolling(id) {
  stopPolling();
  state.poll = setInterval(async () => {
    const j = await get(`/api/bookings/${id}`);
    if (j.booking?.deposit_paid) {
      setBooking(j.booking);
      renderChips();
      document.querySelectorAll('.paybox .status').forEach((s) => { s.textContent = `Deposit received. Booking ${j.booking.id} is confirmed.`; });
      document.querySelectorAll('.paybox .mount').forEach((m) => { m.innerHTML = ''; });
      addMessage('system', `Deposit captured for ${j.booking.room}. Balance of ${money(j.booking.balance_amount, j.booking.currency)} is scheduled for ${j.booking.balance_due_date}.`);
    }
  }, 2500);
}
function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = null; }

async function send(text) {
  if (!text.trim() || $('#send').disabled) return;
  addMessage('user', text);
  $('#input').value = '';
  $('#send').disabled = true;
  const thinking = addMessage('assistant', '…');
  try {
    const out = await post('/api/chat', { conversation_id: state.conversationId, message: text });
    state.conversationId = out.conversation_id;
    localStorage.setItem('innkeeper.cid', out.conversation_id);
    thinking.remove();
    addMessage('assistant', out.reply, { paymentRequest: out.payment_request });
    if (out.booking) setBooking(out.booking);
    renderChips();
  } catch (e) {
    thinking.textContent = `Something went wrong: ${e.message}`;
  } finally {
    $('#send').disabled = false;
    $('#input').focus();
  }
}

function renderChips() {
  const today = state.property.today;
  const plus = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const b = state.booking;
  let chips;
  if (!b) chips = [`Anything free from ${plus(today, 21)} to ${plus(today, 24)} for 2 guests?`, `Family suite 2026-12-20 to 2026-12-23 for 4, can you do 10% off?`, 'Is breakfast included?', 'Do you allow pets?'];
  else if (b.status === 'HOLD') chips = ['What is the cancellation policy?', 'Add an airport pickup', 'Show my booking'];
  else if (b.status === 'CONFIRMED') chips = ['Add a Tadiandamol trek for 2', 'Add a Kodava dinner for 2', 'Show my booking', 'I need to cancel'];
  else chips = ['Start a new booking'];
  $('#chips').innerHTML = '';
  chips.forEach((c) => { const el = document.createElement('button'); el.type = 'button'; el.className = 'chip'; el.textContent = c; el.onclick = () => (c === 'Start a new booking' ? newConversation() : send(c)); $('#chips').appendChild(el); });
}

function newConversation() {
  localStorage.removeItem('innkeeper.cid');
  state.conversationId = null; state.booking = null;
  $('#messages').innerHTML = '';
  setBooking(null);
  greet();
  renderChips();
}

function greet() {
  addMessage('assistant', `Welcome to ${state.property.property.name}. Tell me your dates and how many of you are coming, and I'll check what's free and hold it for you.`);
}

async function restore() {
  if (!state.conversationId) return greet();
  const c = await get(`/api/conversations/${state.conversationId}`).catch(() => null);
  if (!c || !c.messages) return greet();
  const latestPayment = c.messages.findLastIndex((m) => m.payment_request);
  c.messages.forEach((m, i) => addMessage(m.role, m.content, { paymentRequest: i === latestPayment && c.booking?.status === 'HOLD' ? m.payment_request : null }));
  if (c.booking) setBooking(c.booking);
  if (!c.messages.length) greet();
}

async function init() {
  state.property = await get('/api/property');
  const p = state.property;
  $('#prop-name').textContent = p.property.name;
  $('#prop-tagline').textContent = p.property.location;
  $('#prop-desc').textContent = p.property.description;
  $('#rooms').innerHTML = p.rooms.map((r) => `<li><div>${r.name}<small>${r.description} Sleeps ${r.max_guests}.</small></div><b>from ${money(r.base_rate, p.policy.currency)}</b></li>`).join('');
  $('#policy').textContent = p.policy_text;
  $('#mode-line').textContent = `Payments: PayPal ${p.paypal.mode}. Agent: ${p.ai.provider === 'scripted' ? 'scripted fallback, add an LLM key for the real agent' : p.ai.model}. Simulated date: ${p.today}.`;
  await restore();
  renderChips();
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#input').value); });
  window.addEventListener('message', (e) => { if (e.data?.type === 'mock-approved') setTimeout(() => state.booking && startPolling(state.booking.id), 200); });
}

init();
