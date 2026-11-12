import { page, escapeHtml } from './html.js';

const form = (title, intro, endpoint, field, value, label) => page(title, `
  <p class="muted">Mock PayPal, local only. Nothing here talks to PayPal; set PAYPAL_MODE=sandbox to use the real sandbox.</p>
  <p>${intro}</p>
  <p><code>${field}: ${escapeHtml(value)}</code></p>
  <button id="go" class="primary">${label}</button>
  <pre id="out" class="muted"></pre>
  <script src="/session.js"></script><script>
    document.getElementById('go').onclick = async () => {
      const r = await fetch('${endpoint}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ${field}: ${JSON.stringify(value).replace(/</g, '\\u003c')} }) });
      const j = await r.json();
      document.getElementById('out').textContent = JSON.stringify(j, null, 2);
      if (r.ok) setTimeout(() => { if (window.opener) { window.opener.postMessage({ type: 'mock-approved', ${field}: ${JSON.stringify(value).replace(/</g, '\\u003c')} }, location.origin); window.close(); } }, 900);
    };
  </script>`);

export function mockPages(app) {
  app.get('/mock/approve', (req, res) => {
    const order = String(req.query.order || '');
    res.send(form('Approve payment (mock PayPal)', 'You are the sandbox buyer. Approving captures the deposit and confirms the booking.', '/api/mock/approve', 'order_id', order, 'Approve and pay deposit'));
  });
  app.get('/mock/vault', (req, res) => {
    const token = String(req.query.token || '');
    res.send(form('Save PayPal for later (mock)', 'You are the traveller giving one-time consent for your agent to pay from your PayPal within the budget you set.', '/api/mock/vault-approve', 'setup_token_id', token, 'Agree and save PayPal'));
  });
  app.get('/mock/pay-invoice', (req, res) => {
    const invoice = String(req.query.invoice || '');
    res.send(form('Pay balance invoice (mock)', 'You are the guest paying the balance invoice that Innkeeper sent.', '/api/mock/pay-invoice', 'invoice_id', invoice, 'Pay invoice'));
  });
}
