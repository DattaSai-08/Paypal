import crypto from 'node:crypto';
import { store } from './store.js';
import { config, isMockPayPal } from './config.js';
import { exclusive } from './locks.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const authError = (message = 'Authentication required', status = 401) => Object.assign(new Error(message), { status });
export function issueSession({ principalId = crypto.randomUUID(), travelerId = null, paymentConsent = false, maxTotal = null, kind = 'browser' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const session = store.insert('sessions', { id: hash(token), principal_id: principalId, csrf, traveler_id: travelerId, can_pay: paymentConsent, max_total: maxTotal, kind, expires_at: new Date(Date.now() + (kind === 'mcp' ? 15 * 60000 : 24 * 3600000)).toISOString() });
  return { token, session };
}

export function authenticate(req, _res, next) {
  const ownerKey = req.get('x-owner-key');
  if (ownerKey && config.ownerKey.length >= 32 && equal(ownerKey, config.ownerKey)) req.auth = { role: 'owner', principal_id: 'owner' };
  else {
    const bearer = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    const cookie = req.get('cookie')?.split(';').map((v) => v.trim()).find((v) => v.startsWith('innkeeper_session='))?.slice(18);
    const token = bearer || cookie;
    const session = token && store.get('sessions', hash(token));
    if (session && session.expires_at > new Date().toISOString()) req.auth = { ...session, role: 'guest', cookie: !bearer };
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
  if (req.auth.kind === 'mcp' && req.path !== '/mcp') return res.status(403).json({ error: 'This credential is restricted to MCP' });
  return next();
}
export function ownerOnly(req, res, next) {
  if (req.auth?.role !== 'owner') return res.status(401).json({ error: 'Owner authentication required' });
  return next();
}
export function assertOwned(principal, collection, id) {
  const row = store.get(collection, id);
  if (!row || !principal || (principal.role !== 'owner' && (!row.principal_id || row.principal_id !== principal.principal_id))) throw authError('Not found', 404);
  return row;
}

const buckets = new Map();
export function protectRequests(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api') || req.path === '/mcp') res.setHeader('Cache-Control', 'no-store');
  const webhook = ['/webhooks/paypal', '/api/webhooks/paypal'].includes(req.path);
  const origin = req.get('origin');
  if (!webhook && origin && origin !== new URL(config.baseUrl).origin) return res.status(403).json({ error: 'Origin not allowed' });
  if (!webhook && req.get('sec-fetch-site') === 'cross-site' && !['GET', 'HEAD'].includes(req.method)) return res.status(403).json({ error: 'Cross-site request rejected' });
  if (!webhook && req.path !== '/api/session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.auth?.cookie && !equal(req.get('x-csrf-token'), req.auth.csrf)) return res.status(403).json({ error: 'CSRF token required' });
  const now = Date.now();
  for (const [key, value] of buckets) if (value.until < now) buckets.delete(key);
  const key = req.ip;
  const bucket = buckets.get(key) || { count: 0, until: now + 60000 };
  bucket.count += 1; buckets.set(key, bucket);
  if (!webhook && bucket.count > 600) return res.status(429).json({ error: 'Too many requests; try again later' });
  next();
}

export function mountSessions(app) {
  app.post('/api/session', async (req, res, next) => {
    try {
      if (req.get('x-session-bootstrap') !== '1') throw authError('Session bootstrap header required', 403);
      if (req.auth?.kind === 'mcp') throw authError('This credential is restricted to MCP', 403);
      if (req.auth?.role === 'guest' && req.auth.kind === 'browser') return res.json({ csrf: req.auth.csrf });
      const { token, session } = await exclusive(() => issueSession());
      res.cookie('innkeeper_session', token, { httpOnly: true, sameSite: 'lax', secure: !isMockPayPal(), maxAge: 86400000, path: '/' });
      res.json({ csrf: session.csrf });
    } catch (e) { next(e); }
  });
  app.post('/api/logout', requireAuth, async (req, res, next) => {
    try {
      await exclusive(() => { for (const s of store.find('sessions', (s) => s.principal_id === req.auth.principal_id)) store.remove('sessions', s.id); });
      res.clearCookie('innkeeper_session', { path: '/' }); res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
