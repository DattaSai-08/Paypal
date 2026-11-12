# Authentication and payment recovery

## Local setup

Run `node scripts/secure-owner-key.js` once. It configures `OWNER_KEY` in `.env` without printing it and removes owner credentials from `.env.example`. Read the key privately when signing in to `/owner`; do not put it in URLs or logs. AI API-key fields remain blank. The example uses mock PayPal.

Browser pages bootstrap `/api/session`, retain an HttpOnly cookie and attach the returned CSRF token to writes. Guest identities expire after 24 hours. Legacy bookings without `principal_id` are not claimable by ID/email; the owner can inspect them through administrative endpoints. Verified email accounts and cross-device recovery would require a separate identity design.

## MCP and consent

From an authenticated browser session, POST `/api/mcp-token` with its CSRF header. An empty body issues a booking-only grant. For payment include `traveler_id`, `payment_consent: true` and `max_total`; the traveler must belong to the session and have approved saving PayPal. Send the returned access token only as an Authorization Bearer header to `/mcp`. It expires after 15 minutes and cannot call REST APIs.

A payment grant permits one booking and the consented maximum total. `pay_deposit_with_token` needs only `booking_id`; the server resolves the saved method. The traveler authorization button consents to the deposit and subsequent balance within the budget. The CLI reads `MCP_ACCESS_TOKEN` without printing it. Logout revokes outstanding grants.

## Storage topology

Run one application process with a local persistent `DATA_FILE`. Do not run a second scheduler or seed process against that file. A second writer fails at startup. Stop the old process before replacing it; do not use shared/network filesystems.

Clean exit removes the process lock. A dead owner's lock is recovered under an exclusive acquisition gate. If a `.lock.gate` remains after a crash during acquisition, stop all processes using that directory and inspect the owner before removing only the gate. Never remove an active process lock. Back up while stopped, or use a filesystem snapshot; protect backups like credentials.

## Uncertain payments

Use authenticated owner requests with `x-owner-key`, never a query key:

1. GET `/api/owner/operations` lists unresolved operation IDs, methods, statuses and start times without credential values.
2. POST `/api/owner/operations/:id/reconcile` with a `paypal_id` from the provider to resolve an unknown response. The server fetches it and checks it against the persisted intent. Capture/send/cancel operations use the original stored order/invoice ID. Unsupported/mismatched records remain blocked.
3. POST `/api/owner/bookings/:id/reconcile` with `{}` to apply recovered checkout/vault/balance results or refresh pending refunds. A confirmed refund is required before cancellation completes. Owner-approved refund escalations can be retried after reconciliation.
4. A paid invoice with an unknown refundable capture can be reconciled with a `capture_id`. The capture must appear in the invoice transaction list and pass a provider amount/currency/status check. If it is not a supported Payments v2 capture, automatic refund remains blocked; resolve it with PayPal support instead of marking a refund complete without evidence.

Supported payment mutations are automatically retried for at most five hours from the intent, then require reconciliation. Never delete uncertain operations to force another charge. Failed/pending payouts are not marked paid; investigate before scheduling replacements.

## Booking changes and deployment

Unpaid holds can be repriced and require a new order when prices change. Deposit-paid checkout bookings can add extras before invoicing/settlement. Changes after invoicing, full settlement, saved-method balance consent or cancellation initiation are rejected until separately resolved. Settled amounts are never silently reset and credits are not invented.

Sandbox/live startup requires an HTTPS `BASE_URL`, strong `OWNER_KEY`, PayPal credentials and `PAYPAL_WEBHOOK_ID`. Demo reset/clock/seed bookings are confined to mock mode. Complete merchant-specific sandbox tests before using real money.
