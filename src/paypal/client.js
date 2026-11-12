import { config, paypalBase } from '../config.js';
import crypto from 'node:crypto';
import { operationId } from './operations.js';

let cached = { token: null, expires: 0 };

async function fetchToken(extraParams = '') {
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    signal: AbortSignal.timeout(20000),
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials${extraParams}`,
  });
  const json = await res.json();
  if (!res.ok) throw new PayPalError('oauth', res.status, json);
  return json;
}

export async function accessToken() {
  if (cached.token && Date.now() < cached.expires - 60000) return cached.token;
  const json = await fetchToken();
  cached = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export async function idToken(customerId) {
  const json = await fetchToken(`&response_type=id_token${customerId ? `&target_customer_id=${encodeURIComponent(customerId)}` : ''}`);
  return json.id_token;
}

export class PayPalError extends Error {
  constructor(op, status, body) {
    super(`PayPal ${op} failed (${status})`);
    this.status = status;
    this.body = body;
    this.op = op;
  }
}

export async function request(op, method, path, body, headers = {}) {
  const token = await accessToken();
  const init = {
    signal: AbortSignal.timeout(20000),
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
  };
  if (body !== undefined) init.body = body instanceof FormData ? body : JSON.stringify(body);
  if (body instanceof FormData) delete init.headers['Content-Type'];
  const res = await fetch(`${paypalBase()}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new PayPalError(op, res.status, json);
  return { status: res.status, json, headers: res.headers };
}

export const requestId = (seed) => operationId() || crypto.createHash('sha256').update(seed).digest('hex').slice(0, 36);
