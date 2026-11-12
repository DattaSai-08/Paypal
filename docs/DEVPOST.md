# Devpost submission text

Paste into the submission form. Replace the bracketed items.

## Project name

Innkeeper

## Tagline

An AI front desk for independent stays that runs the whole money loop on PayPal, and that other AI agents can book through.

## Inspiration

Boutique resorts and homestays pay online travel agencies 15 to 25 percent of every booking, then handle direct enquiries over chat with manual bank transfers, manual refunds, and cash to the taxi driver. We work with properties like this. The money is the hard part, not the conversation. We wanted the agent to own the money loop end to end on PayPal, and we wanted the property itself to be bookable by the next generation of travel agents, which will be software.

## What it does

Innkeeper gives a property three things.

A guest-facing front desk agent that answers from the property's own facts, quotes real inventory with seasonal pricing, negotiates discounts only within the owner's rules, holds a room, takes a 30 percent deposit through PayPal checkout, confirms on capture, collects the balance automatically before check-in, applies tiered cancellation refunds on PayPal, adds experiences, and pays local partners through PayPal Payouts on the day of service.

A machine-facing endpoint: the property is an MCP server. A traveller saves PayPal once (Vault), sets a budget, and their own AI agent checks availability, negotiates, holds and pays the deposit with the saved payment token. A spend governor on the traveller's side, written in code rather than prompted, blocks anything over budget. In the demo two agents complete a real PayPal sandbox payment with no human in the checkout.

An owner back office: AG Grid tables of bookings, every PayPal money event, payouts, and an agent action log showing the PayPal API call behind each action; an escalation queue for anything outside policy (refunds above the owner's limit, discounts beyond the cap); a policy console that both agents obey; a simulated clock to run the money loop forward; and a disputes view that matches chargebacks to bookings and assembles the evidence pack for the Disputes API.

## How we built it

Node 22 and Express, no build step. [Your model] runs both agents through a tool-calling loop (the code supports Anthropic's Messages API and any OpenAI-compatible endpoint); tools are defined once with zod and served to Claude as JSON schema and to other agents through the official MCP TypeScript SDK over Streamable HTTP. PayPal is integrated directly against the REST APIs: Orders v2 (checkout, and vault-id orders that capture in one call), Vault v3 setup and payment tokens, Invoicing v2 with reminders, Payments v2 refunds, Payouts v1, Disputes v1, and webhook signature verification. The policy engine, inventory, and spend governor are plain code. The back office uses AG Grid Community with the Theming API and AG Charts Community for the cash-flow view. A mock PayPal mode mirrors every call so the full loop runs with no credentials, and the test suite drives it end to end.

## Challenges we ran into

Keeping the model away from money decisions. Early versions let the agent decide refund amounts; the fix was to make every monetary rule a function the model can call but not override, and to log the result with the PayPal call. Judges can read the action log and see that no price, refund or discount came from the model.

Agent-to-agent payment without a redirect. The clean answer was PayPal's saved payment methods: one consent, then orders created with `payment_source.paypal.vault_id` return `COMPLETED` with the capture inside, which is what makes a seller-side agent endpoint practical.

Demo robustness. Webhooks are the right reconciliation path but fragile in a live demo, so the browser captures and polls, and webhooks reconcile when configured.

## Accomplishments we are proud of

A complete money loop, not a checkout: deposit, balance, refund, payout, dispute, all on PayPal, all driven by agents inside human-set rules. A property that any MCP-capable assistant can book today.

## What we learned

Seller-side agent endpoints are underbuilt. Everyone is writing shopping agents; very few are making businesses bookable by them. PayPal's vault and order APIs make the seller side straightforward once the consent model is right.

## What's next

WhatsApp as a second channel for the same agent, a property management system adapter for inventory, dynamic pricing suggestions the owner approves, and multi-property support for small groups.

## Built with

node.js, express, [anthropic-claude or groq or gemini], paypal-orders-api, paypal-vault, paypal-invoicing, paypal-payouts, paypal-disputes, paypal-webhooks, model-context-protocol, ag-grid, ag-charts, zod, render

## Tools (AI and services) and how they were used

- [Model you actually ran, e.g. Anthropic Claude claude-sonnet-5-5 via the Messages API, or Llama 3.3 70B via Groq, or Gemini 2.5 Flash] with tool calling: the property's front desk agent and the traveller's booking agent. Both call the same typed tools; neither sets prices or moves money directly. The code supports Anthropic and any OpenAI-compatible endpoint; name the one in the demo.
- PayPal Developer Platform (sandbox): Orders v2, Vault v3, Invoicing v2, Payments v2 refunds, Payouts v1, Disputes v1, Webhooks, JS SDK Buttons.
- Model Context Protocol (official TypeScript SDK): the property's agent-facing endpoint and the traveller agent's client.
- AG Grid Community and AG Charts Community: the owner back office.
- Render: hosting for the demo URL.

## Links

- Hosted demo: [URL]
- Repository: [URL] (MIT licence at repo root)
- Video: [YouTube URL]
- Owner back office key for judges: [key]
- Sandbox buyer for judges: [sandbox personal account email and password, or state that judges can use their own sandbox personal account]
