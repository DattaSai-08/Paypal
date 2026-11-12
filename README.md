# Innkeeper

An AI front desk for independent stays that runs the whole money loop on PayPal, and that other AI agents can book through.

Built for the PayPal AI Hackathon (Build What's Next with PayPal and AI).

Independent resorts and homestays lose 15 to 25 percent of every booking to online travel agencies and run the rest over chat and bank transfers. Innkeeper gives a property a booking agent that quotes real inventory, negotiates inside the owner's rules, takes the deposit through PayPal, collects the balance automatically, refunds under policy, pays local partners through PayPal Payouts, and assembles chargeback evidence. The same property is exposed as an MCP server, so a traveller's own AI agent can book it and pay from a PayPal payment method the traveller saved once, inside a budget the traveller set.

## What a judge can see in three minutes

1. **Guest side** (`/`): chat with the front desk, get a quote, ask for a discount, pay the deposit with PayPal buttons. The booking confirms on capture; the balance is scheduled.
2. **Agent side** (`/traveler`): a traveller sets a budget, saves PayPal once (Vault), and sends their agent. The agent talks to the property over MCP, negotiates a discount, holds a room, and pays the deposit with the saved token. A spend governor on the traveller's side blocks anything over budget.
3. **Owner side** (`/owner`): AG Grid back office with every booking, every PayPal money event, the agent action log with the PayPal call behind each action, escalations that need a human, the policy console the agents obey, a simulated clock to run the money loop forward, and dispute handling.

## PayPal surfaces used

| Flow | PayPal API | Where in code |
| --- | --- | --- |
| Deposit checkout | Orders v2 create and capture, JS SDK Buttons | `src/paypal/live.js`, `public/guest.js` |
| Agent pays with saved method | Vault v3 setup tokens and payment tokens, Orders v2 with `payment_source.paypal.vault_id` (auto-captured) | `src/paypal/live.js`, `src/agent/traveler.js` |
| Balance collection | Orders v2 with vault id when the guest saved PayPal, otherwise Invoicing v2 create, send, remind, cancel | `src/jobs.js` |
| Refunds under policy | Payments v2 capture refund (partial) | `src/booking-service.js` |
| Partner payouts | Payouts v1 batch | `src/jobs.js` |
| Chargebacks | Disputes v1 list, get, provide evidence | `src/disputes.js` |
| Reconciliation | Webhooks with signature verification (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `INVOICING.INVOICE.PAID`, `CUSTOMER.DISPUTE.*`, `VAULT.PAYMENT-TOKEN.CREATED`) | `src/paypal/webhooks.js` |
| Agentic commerce | MCP server (Streamable HTTP) exposing availability, quotes, holds, deposit orders, token payment, changes, cancellations, extras | `src/mcp/server.js` |

## AI used

Local `.env` and `.env.example` use `AI_PROVIDER=auto` with blank AI API-key fields. Auto selects Anthropic when its key is present, otherwise OpenAI when its key is present, otherwise scripted mode. Set `AI_PROVIDER=scripted`, `anthropic`, or `openai` to choose explicitly. Blank optional model settings fall back to the code defaults. Restart after changing environment settings.

The configured defaults are `claude-sonnet-5-5` and the existing Chat Completions-compatible `gpt-4o-mini`. OpenAI now labels [GPT-4o Mini deprecated](https://developers.openai.com/api/docs/models/gpt-4o-mini); this patch preserves that API-compatible default rather than migrating the model/request format. Anthropic lists [Sonnet 5.5 as active](https://platform.claude.com/docs/en/about-claude/model-deprecations). Model access is account-dependent and external calls have not been tested with blank keys.

Read [the booking/payment security review](docs/SECURITY_REVIEW.md) and [operations guide](docs/OPERATIONS.md) for authentication, consent, supported storage topology and payment recovery. The initial authentication, concurrency and accounting findings are now guarded in code; real-payment deployment still needs merchant-specific sandbox validation.

- Both agents (the property's front desk in `src/agent/guest.js`, the traveller's agent in `src/agent/traveler.js`) run a tool-calling loop in `src/agent/llm.js`. Tools are defined once with zod (`src/agent/tools.js`) and served to the model as JSON schema and to other agents over MCP.
- Provider A: Anthropic Claude through the Messages API (`ANTHROPIC_API_KEY`, model `claude-sonnet-5-5` by default).
- Provider B: any OpenAI-compatible chat completions endpoint with tool calling (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`). Free tiers that work with this shape: Groq (`https://api.groq.com/openai/v1`, `llama-3.3-70b-versatile`) and Google Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`, `gemini-2.5-flash`). The provider in use is shown in the UI and in `/healthz`.
- With no key at all the same tools run through deterministic scripted agents (`src/agent/scripted.js`), so judges can run the full money loop with no AI credentials. Scripted mode is labelled in the UI.

The policy engine is deliberately not an LLM. Discounts, cancellation tiers, auto-approve limits and the traveller's budget are enforced in code (`src/policy.js`, governor in `src/agent/traveler.js`); the models negotiate and explain, they do not decide what money moves.

## Run it in two minutes (mock PayPal, no keys)

```bash
git clone <this repo> && cd innkeeper
npm install
npm start
```

Open http://localhost:3000. `PAYPAL_MODE` defaults to `mock`, which simulates every PayPal call locally with approval pop-ups that stand in for PayPal's pages. This is for running the loop end to end quickly; the sandbox mode below is what the demo video uses.

Run `node scripts/secure-owner-key.js` to configure a strong local owner credential without printing it. `/owner` requires that credential; the former demo default and query-string keys are rejected. Browser guest sessions are established automatically and own their conversations, bookings and travelers.

## Run it against the PayPal sandbox

1. Create a PayPal Developer account and a REST app at https://developer.paypal.com/dashboard/applications/sandbox. Copy the sandbox client id and secret.
2. In the app's Sandbox App Settings, under App feature options, enable Accept payments, and under Advanced options tick Vault. Enable Payouts if it is listed. Save.
3. Note your sandbox business account (the app owner) and create or use a sandbox personal account (the buyer) from Sandbox accounts. You will log in as the personal account when paying in the demo.
4. Copy `.env.example` to `.env` and set:
   ```
   PAYPAL_MODE=sandbox
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   BASE_URL=http://localhost:3000
   ANTHROPIC_API_KEY=...   (or OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL for Groq or Gemini; omit all to run scripted agents)
   ```
5. `npm start`, then open http://localhost:3000.

Mock mode needs no PayPal credentials. Sandbox/live mode requires HTTPS, a strong owner credential and a webhook ID at startup, in addition to client credentials. Configure webhooks as follows:

1. Expose the server publicly (for local runs use `ngrok http 3000` and set `BASE_URL` to the ngrok URL, then restart).
2. In the developer dashboard, open your app, add a webhook with URL `BASE_URL/webhooks/paypal` and subscribe to: Checkout order approved, Payment capture completed, Payment capture refunded, Invoicing invoice paid, Customer dispute created, Customer dispute updated, Vault payment token created.
3. Put the webhook id in `PAYPAL_WEBHOOK_ID` and restart. Unverified events are ignored and logged.

Sandbox notes, stated plainly:

- Saving PayPal (Vault) in sandbox needs the Vault option on the app. In production it additionally needs PayPal's approval for reference transactions.
- Payouts in sandbox succeed against the sandbox business balance; recipients that are not sandbox accounts show as unclaimed, which is expected.
- Disputes can be opened in sandbox by logging into the personal (buyer) account and reporting a problem on the transaction. Innkeeper then lists it, matches it to the booking by capture id, and submits the evidence pack.
- Currency is USD by default because that is what every sandbox account supports. Change `CURRENCY` if your sandbox business account is set up for another currency.

## Let another agent book the property

The property is an MCP server at `BASE_URL/mcp` (Streamable HTTP, stateless). Clients must supply a short-lived authenticated grant. Obtain it through `/api/mcp-token` as described in [OPERATIONS.md](docs/OPERATIONS.md), then configure your client's Authorization header. Payment grants are bound to one traveler, one booking and explicit budget consent.

```bash
# Set MCP_ACCESS_TOKEN privately in your environment, then run the CLI.
npm run traveler -- http://localhost:3000/mcp
```

Tools: `get_property_info`, `check_availability`, `get_quote` (accepts `requested_discount_pct`; policy decides), `create_hold`, `create_deposit_order` (returns a PayPal approve URL for the payer), `pay_deposit_with_token` (saved PayPal payment token, captured immediately), `get_booking`, `request_cancellation`, `modify_booking_dates`, `add_experience`.

The `/traveler` page is a reference client: it creates a traveller, runs the one-time PayPal consent, and then drives a Claude-powered agent against the MCP server with a budget governor that sits outside the model.

## Deploy

Run one Node process on one host with a local persistent data directory. The process lock rejects competing writers; stop the previous process before replacing it. Do not use multiple replicas or shared network filesystems with this store. `render.yaml` is a starting point only: provision a persistent disk, configure HTTPS and all required PayPal settings, and use a deployment strategy that does not overlap writers. Protect data and backups with OS permissions and encrypted storage.

Any Node 20+ host works the same way: `npm ci && npm start`.

## Project layout

```
src/
  server.js            Express app, static UIs, return URLs, scheduler
  routes.js            REST API for the UIs, owner endpoints, webhook entry, mock approval endpoints
  config.js            Environment
  store.js             JSON document store with a simulated clock
  seed.js              The demo property, rooms, partners, policy and sample bookings
  policy.js            Quotes, discount governor, cancellation terms
  inventory.js         Availability and hold expiry
  booking-service.js   Holds, deposit orders, token payments, refunds, cancellations, changes, extras, escalations
  jobs.js              The money loop: balance collection, reminders, partner payouts, completion
  disputes.js          Dispute matching and evidence packs
  paypal/              live.js (REST), mock.js (local simulation), webhooks.js (verify and apply)
  agent/               tools.js (shared tool definitions), llm.js (Claude tool loop), guest.js, traveler.js, scripted.js
  mcp/server.js        MCP server exposing the property tools
public/                Guest chat, owner back office (AG Grid), traveller agent page
test/                  node --test suites covering policy maths and the full mock-mode money loop
```

## Tests

```bash
npm test
```

Nine tests run the policy maths, the OpenAI-compatible tool loop against a fake endpoint, and the full loop in mock mode: chat to deposit to extra, MCP hold and token payment and refund, clock-driven vault capture and invoicing and payouts, invoice webhook settlement, and owner-approved refunds above the auto-approve limit.

## What is deliberately not in scope

- A WhatsApp channel. The agent loop is channel-agnostic; adding a WhatsApp webhook is a transport change, not an agent change.
- A property management system integration. Inventory lives in the local store.
- Real tax logic. A flat configurable rate is applied.
- Authentication beyond a shared owner key.

## License

MIT, see `LICENSE`.
