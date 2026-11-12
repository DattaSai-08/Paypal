# Booking and payment security review

Updated 2026-11-01. The authentication, concurrency and accounting findings from the initial review have been addressed with enforced ownership, durable payment operations and conservative restrictions on unsupported changes. This describes implemented controls, not an independent security certification.

## Authentication and authorization

- Guest browsers receive a cryptographically random, HttpOnly, SameSite session cookie. Only a hash of the credential is stored; sessions expire after 24 hours. These are guest session identities, not verified email accounts. A new browser cannot claim bookings by knowing an ID or email.
- Every private REST endpoint checks authentication. Conversations, bookings, travelers, checkout capture, vault exchange and mock approval enforce ownership. Legacy records without an owner remain accessible only through owner administration.
- Browser mutations require CSRF tokens and reject foreign origins. Bootstrap requires a custom header and never accepts a supplied identity. Logout revokes delegated grants. Basic per-IP request limits and no-store headers protect private APIs.
- MCP grants expire after 15 minutes, are restricted to MCP, and cannot mint credentials or invoke browser APIs. Payment requires explicit consent bound to a linked traveler, maximum total and one booking. The server resolves the saved token; the LLM never needs it. The payment service enforces budget commitments, including uncertain charges.
- Owner administration accepts only a configured header credential of at least 32 characters. Query credentials and the former demo default no longer work. `scripts/secure-owner-key.js` creates a strong local credential without printing it. Demo clock/reset controls are disabled outside mock mode; policy updates are validated. Untrusted owner-panel and mock-popup content is escaped.

## Concurrency and recovery

- Supported topology: **one Node process on one host with a local persistent data directory**. A process lock rejects a second writer. Dead process locks are checked under an acquisition gate. A stale gate fails closed for administrator inspection. Network filesystems, multiple replicas and overlapping deployments are not supported.
- Local transactions write complete snapshots through flushed temporary files and atomic rename. Failed synchronous transactions roll back in memory. Corrupt data is rejected rather than replaced. Money operations, webhooks, cancellations and the scheduler share a reentrant exclusive queue.
- Provider mutation intents and stable request IDs reach disk before the request. Successful results are cached durably. Supported payment retries reuse the same request ID and stop after five hours. Invoice and vault setup/token operations with uncertain outcomes require reconciliation instead of assuming deduplication. See PayPal's [idempotency guidance](https://developer.paypal.com/api/make-api-requests) and [Orders request-ID header](https://developer.paypal.com/api/orders/v2/orders-create).
- Uncertain captures reserve inventory and block edits/cancellation. Confirmed late captures on expired/cancelled holds are refunded without reopening inventory. Refund arguments remain stable across retries. Invoice and payout local application is idempotent; payouts are marked paid only after provider item success.
- Owner recovery endpoints fetch provider records and validate association and amount before resolving operations. They do not accept an unverified instruction to mark money received. See [OPERATIONS.md](OPERATIONS.md).

## Accounting

- Captures validate ownership, amount, currency and completed status. Changed unpaid prices invalidate old orders. Webhook IDs are deduplicated; invoice settlement retrieves and verifies the invoice.
- Edits after balance payment, invoicing, saved-method consent, cancellation initiation or uncertain charges are rejected. Price reductions below a paid deposit are rejected. This prevents duplicate collection and unrecorded credits; this patch does not add a general post-settlement amendment ledger.
- Refund capacity is checked before any refund begins. Missing capture sources, pending refunds and uncertain outcomes cannot be reported as completed cancellations. Paid invoices without verified refundable captures remain blocked for reconciliation. Recording an invoice refund is not treated as moving money.
- Completed receipts/refunds drive traveler spend and commitments; cancellations release refunded commitments. Owner totals exclude pending and superseded records. Cancellation terms are snapshotted at booking; later payment during cancellation updates the proposal.
- Payouts require full balance collection and no pending cancellation. Unsettled stays are not automatically marked completed.

## Verification and deployment boundary

The suite uses isolated databases, synthetic credentials, local fake LLM responses and mock PayPal. It covers authorization bypasses, CSRF, grants/consent, concurrent operations, process locks, intents surviving process termination, late captures, lost responses, refunds and payouts. No sandbox/live payment or external model call was made.

Non-mock startup requires HTTPS, a strong owner credential, PayPal credentials and a webhook ID. Validate merchant-specific Orders, Vault, Invoicing, Refund and Payout contracts in sandbox before real payments. Protect the data directory and backups with OS permissions and encrypted storage: local JSON contains personal data, operation evidence and saved tokens. Never serve it publicly or commit it. Retention and independent penetration testing remain deployment responsibilities.
