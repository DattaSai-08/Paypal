import 'dotenv/config';

const env = (key, fallback = '') => process.env[key]?.trim() || fallback;

const port = Number(env('PORT', '3000'));

export const config = {
  port,
  baseUrl: env('BASE_URL', `http://localhost:${port}`),
  dataFile: env('DATA_FILE', 'data/innkeeper.json'),
  ownerKey: env('OWNER_KEY'),
  paypal: {
    mode: env('PAYPAL_MODE', 'mock').toLowerCase(),
    clientId: env('PAYPAL_CLIENT_ID'),
    clientSecret: env('PAYPAL_CLIENT_SECRET'),
    webhookId: env('PAYPAL_WEBHOOK_ID'),
    currency: env('CURRENCY', 'USD'),
    brandName: env('BRAND_NAME', 'Cinnamon Ridge Stays'),
  },
  ai: {
    provider: env('AI_PROVIDER', env('ANTHROPIC_API_KEY') ? 'anthropic' : env('OPENAI_API_KEY') ? 'openai' : 'scripted').toLowerCase(),
    anthropicKey: env('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    openaiKey: env('OPENAI_API_KEY'),
    openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModel: env('OPENAI_MODEL', 'gpt-4o-mini'),
    openaiLabel: env('OPENAI_LABEL', 'openai-compatible'),
    maxTurns: Math.min(20, Math.max(1, Number(env('AGENT_MAX_TURNS', '12')) || 12)),
  },
  jobs: {
    intervalMs: Number(env('JOBS_INTERVAL_MS', '60000')),
  },
};

export const paypalBase = () =>
  config.paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

export const isMockPayPal = () => config.paypal.mode === 'mock';

export function validateConfig() {
  if (!['mock', 'sandbox', 'live'].includes(config.paypal.mode)) throw new Error('Invalid PAYPAL_MODE');
  if (!isMockPayPal() && (!config.paypal.clientId || !config.paypal.clientSecret)) {
    throw new Error('PayPal credentials are required outside mock mode');
  }
  if (!isMockPayPal() && (config.ownerKey.length < 32 || !config.paypal.webhookId || !config.baseUrl.startsWith('https://'))) throw new Error('Non-mock mode requires a strong OWNER_KEY, webhook ID and HTTPS BASE_URL');
}
