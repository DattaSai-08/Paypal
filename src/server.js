import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isMockPayPal, validateConfig } from './config.js';
import { store } from './store.js';
import { seedIfEmpty } from './seed.js';
import { api, webhookHandler } from './routes.js';
import { mountMcp } from './mcp/server.js';
import { startScheduler } from './jobs.js';
import { llmAvailable, modelLabel } from './agent/llm.js';
import { paypalMode } from './paypal/index.js';
import { captureDepositOrder, bookingSummary } from './booking-service.js';
import { mockPages } from './mock-pages.js';
import { page, escapeHtml } from './html.js';
import { authenticate, protectRequests, mountSessions, assertOwned } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  validateConfig();
  seedIfEmpty();
  const app = express();
  app.disable('x-powered-by');
  app.use(authenticate);
  app.use(protectRequests);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  mountSessions(app);

  app.use('/api', api);
  app.post('/webhooks/paypal', webhookHandler);
  mountMcp(app);
  if (isMockPayPal()) mockPages(app);

  app.get('/paypal/return', async (req, res) => {
    const bookingId = String(req.query.booking || '');
    const orderId = String(req.query.token || '');
    try {
      assertOwned(req.auth, 'bookings', bookingId);
      const booking = await captureDepositOrder(bookingId, orderId, 'guest');
      res.send(page('Payment received', `<p>Deposit captured. Booking <b>${escapeHtml(booking.id)}</b> for ${escapeHtml(booking.room_name)} is confirmed.</p><pre>${escapeHtml(JSON.stringify(bookingSummary(booking), null, 2))}</pre><p><a href="/">Back to the front desk</a></p>`));
    } catch (e) {
      res.status(400).send(page('Payment not completed', '<p>Payment could not be completed. Please return to your booking and try again.</p><p><a href="/">Back</a></p>'));
    }
  });
  app.get('/paypal/cancel', (req, res) => res.send(page('Payment cancelled', '<p>No charge was made. Your hold stays open until it expires.</p><p><a href="/">Back to the front desk</a></p>')));

  app.get('/healthz', (req, res) => res.json({ ok: true, today: store.today(), paypal: paypalMode(), ai: modelLabel() }));
  app.use((err, req, res, next) => { if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'Request could not be completed' }); });
  return app;
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Innkeeper listening on ${config.baseUrl} (PayPal: ${paypalMode()}, AI: ${llmAvailable() ? modelLabel() : 'scripted fallback'})`);
    console.log(`Guest chat: ${config.baseUrl}/   Owner: ${config.baseUrl}/owner   Traveller agent: ${config.baseUrl}/traveler   MCP: ${config.baseUrl}/mcp`);
    startScheduler(config.jobs.intervalMs);
  });
}
