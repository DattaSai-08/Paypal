# Innkeeper

An AI front desk for independent stays, with guest booking, policy-controlled discounts, PayPal payment workflows, and an MCP endpoint for traveler agents.

Built as a PayPal AI Hackathon project.

## The idea

Independent stays often manage direct bookings, deposits, changes and refunds across separate conversations and payment tools. Innkeeper brings these workflows together: guests can book through chat, travelers can authorize an agent to book for them, and property owners can review payments and requests outside their policies.

## What you can try

- **Guest front desk (`/`)**: check availability, get a quote, request a discount, hold a room and pay a deposit. Follow-up questions reuse the existing booking.
- **Traveler agent (`/traveler`)**: set a budget, approve a saved payment method and authorize the agent to book through MCP. The server enforces ownership, payment consent and budget limits.
- **Owner dashboard (`/owner`)**: inspect bookings, payment records, agent actions, policy settings, escalations and dispute evidence. Mock mode also provides clock controls for demonstrating scheduled workflows.

## Implementation and verification status

The project includes PayPal REST adapters for Orders, Vault, Invoicing, Refunds, Payouts, Disputes and Webhooks, plus a local mock backend for demonstrations without credentials.

**The latest verified run passed 47 tests, with JavaScript syntax checks passing.** Tests use mock PayPal and a local fake OpenAI-compatible endpoint. Real PayPal sandbox transactions and external model calls were not part of that verification. Mock transactions do not demonstrate successful sandbox or live payments.

The distributed configuration uses mock PayPal and blank AI API-key fields. With no model key, the chatbot uses a labeled deterministic fallback. Add a supported provider credential privately to demonstrate model-driven conversations.

## Quick start: mock payments

Requirements: Node.js 20 or later and npm. The verified development runtime was Node.js 24.

Download or clone this repository and open a terminal in the folder containing `package.json`.

1. Copy `.env.example` to `.env`. In PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   If you already configured `.env`, preserve that file instead of overwriting it.

2. Install dependencies, configure a local owner credential and run the tests:

   ```bash
   npm ci
   node scripts/secure-owner-key.js
   npm test
   ```

3. Start the application:

   ```bash
   npm start
   ```

4. Open [the front desk](http://localhost:3000), [traveler agent](http://localhost:3000/traveler) or [owner dashboard](http://localhost:3000/owner).

The owner setup script writes a strong `OWNER_KEY` to your local `.env` without printing it. Read it privately to sign in to the dashboard. Browser guest sessions are created automatically.

Never commit `.env`, booking data, payment tokens or passwords. `.env.example` contains configuration names with blank credential fields. The repository's `.gitignore` excludes local environment files, data, dependencies and logs.

## AI configuration

Both agents use typed tools defined with Zod. The tool loop supports Anthropic's Messages API and OpenAI-compatible Chat Completions endpoints with function calling.

| Setting | Purpose |
| --- | --- |
| `AI_PROVIDER=auto` | Select Anthropic when its key is present, otherwise OpenAI when its key is present, otherwise scripted mode |
| `AI_PROVIDER=scripted` | Force the deterministic demonstration flow |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic credentials and model selection |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | OpenAI-compatible credentials, endpoint and model selection |

The checked-in model defaults are `claude-sonnet-5-5` and `gpt-4o-mini`. These are configuration values, not guarantees of current availability: choose a model supported by your provider account. Restart the server after changing settings. The active provider is shown in the UI and `/healthz`.

Pricing, discount limits, cancellation amounts and payment authorization are enforced in code. A model can request an action through a tool; it cannot override those checks.

## PayPal integration

| Workflow | API adapter |
| --- | --- |
| Deposit checkout | Orders v2 create/capture and JS SDK Buttons |
| Saved-method payment | Vault v3 setup/payment tokens and Orders v2 |
| Balance collection | Saved-method orders or Invoicing v2 |
| Cancellation refunds | Payments v2 capture refunds |
| Partner payouts | Payouts v1 |
| Dispute evidence | Disputes v1 |
| Payment reconciliation | Verified PayPal webhooks and owner recovery endpoints |

Adapters live in `src/paypal/`; booking rules live in `src/booking-service.js` and `src/policy.js`.

### Sandbox setup

1. Create a PayPal Developer sandbox application and buyer account. Confirm that your application's enabled capabilities cover the flows you plan to demonstrate, especially Vault and Payouts.
2. Obtain a stable HTTPS address for the application through your hosting setup or a development tunnel.
3. Register `https://YOUR-HOST/webhooks/paypal` for the order approval, capture completion/refund, invoice payment, dispute and vault events handled in `src/paypal/webhooks.js`.
4. Configure these values privately in `.env` or your host's environment settings:

   ```dotenv
   PAYPAL_MODE=sandbox
   BASE_URL=https://YOUR-HOST
   PAYPAL_CLIENT_ID=
   PAYPAL_CLIENT_SECRET=
   PAYPAL_WEBHOOK_ID=
   OWNER_KEY=
   ```

   Fill the credential fields with your sandbox values. Preserve the strong owner key generated during local setup.

5. Restart and open the application through the configured HTTPS address. Test a deposit and refund first, then validate saved-method payments, invoices and payouts for your merchant account.

Sandbox/live startup rejects missing PayPal credentials, a missing webhook ID, a weak owner key or a non-HTTPS base URL. Demo reset and simulated clock controls are available only in mock mode. Existing seeded mock data should not be reused as a sandbox/live payment database; configure a separate persistent `DATA_FILE`.

## Agent access through MCP

The MCP endpoint is `BASE_URL/mcp`, using Streamable HTTP. It requires authentication.

An authenticated browser session can obtain a short-lived grant through `/api/mcp-token`. Payment grants require a linked traveler, explicit consent and a maximum total; each grant is limited to one booking. The server resolves the saved payment method, so the agent does not need the payment token.

For the CLI demonstration, configure `MCP_ACCESS_TOKEN` privately, then run:

```bash
npm run traveler -- http://localhost:3000/mcp
```

See [the operations guide](docs/OPERATIONS.md) for grant issuance and request details.

## Security and payment recovery

- Guest session authentication, record ownership checks and CSRF protection.
- Strong owner authentication and restricted MCP payment grants.
- Durable payment intents, stable request IDs and provider-verified reconciliation.
- Serialized money operations and a process lock preventing competing file writers.
- Guards against duplicate charges, incomplete refunds and unsupported edits after invoicing or settlement.

Read [the security review](docs/SECURITY_REVIEW.md) and [operations guide](docs/OPERATIONS.md) for the supported behavior and recovery procedures.

Guest sessions are not verified email accounts. Post-settlement amendments and invoice refunds without a verified refundable capture require reconciliation; the application does not silently invent credits or report an unverified refund as complete.

## Deployment

Run **one Node process on one host with a local persistent data directory**. Stop the old process before replacing it. Multiple replicas, overlapping writers and shared network filesystems are not supported by this store.

Use HTTPS, keep credentials in environment settings, and protect data and backups with OS permissions and encrypted storage. `render.yaml` is a deployment starting point; persistence and required environment settings must be configured for your host. Complete merchant-specific PayPal sandbox testing before using real money.

## Tests

```bash
npm test
```

The 47-test suite covers pricing and discount policy, chatbot regressions, the model tool loop, authenticated guest/traveler booking, MCP grants and consent, CSRF and ownership checks, payment races, durable recovery across process termination, refunds, late captures, invoices and payout status.

## Project layout

```text
src/
  agent/               Guest/traveler agents, tools and model adapters
  paypal/              Live/mock adapters, durable operations and webhooks
  mcp/                 Authenticated MCP server
  auth.js              Sessions, ownership checks and request protection
  booking-service.js   Booking and payment rules
  policy.js            Quotes, discounts and cancellation policy
  reconciliation.js    Provider-verified recovery
  locks.js             Operation serialization
  store.js             Persistent local store and process lock
  jobs.js              Scheduled balance collection and payouts
  server.js            Express application
public/                Guest, traveler and owner interfaces
scripts/               Owner credential setup and MCP CLI demo
test/                  Automated tests
docs/                  Security review, operations and submission drafts
```

## Scope

This prototype uses local inventory and a configurable flat tax rate. It does not include a property-management-system integration, WhatsApp channel, verified-account recovery or a general accounting system for post-settlement amendments.

## License

[MIT](LICENSE).
