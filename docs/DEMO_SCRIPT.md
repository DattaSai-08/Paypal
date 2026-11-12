# Demo video script (under 3 minutes)

Record at 1440x900 in sandbox mode with `ANTHROPIC_API_KEY` set, webhook configured, and the demo data freshly reset (Owner, Reset demo data). Have a sandbox personal account logged in on a second browser profile for PayPal approvals. Close every other tab. No background music.

Timing targets are hard. If a segment runs long, cut from segment 4, never from 2 or 3.

## 0:00 to 0:20, the problem

Screen: the owner back office KPI strip.

Voice: "Independent stays pay online travel agencies fifteen to twenty-five percent of every booking, then run the rest over chat and bank transfers. Innkeeper is an AI front desk that runs the whole money loop on PayPal. Guests book with it, other AI agents book through it, and the owner sets the rules it cannot break."

## 0:20 to 1:05, a guest books and pays

Screen: `/`. Type: "Family suite 2026-12-20 to 2026-12-23 for 4, can you do 10% off?"

Voice over the reply: "The agent prices real inventory. The guest asked for ten percent; policy caps peak dates at five, so it applies five and says why. Anything beyond that goes to the owner, not to the model's judgment."

Type: "Asha Menon, asha@example.com". PayPal buttons appear.

Voice: "It creates a PayPal order for the thirty percent deposit." Click PayPal, approve in the sandbox buyer window, return.

Voice: "Capture lands, booking confirmed, balance scheduled for seven days before check-in. The strip at the bottom is the loop we are about to run."

## 1:05 to 1:55, two agents, one payment (the part that matters)

Screen: `/traveler`. Show the budget field set to 900, click Create traveller, click the PayPal button, approve the one-time consent in the buyer window.

Voice: "Now the other side of agentic commerce. A traveller saves PayPal once and sets a budget. The property is an MCP server; the traveller's own agent books through it."

Click Send my agent to book. Let the transcript stream.

Voice over the events: "Real MCP calls. The traveller's agent asks for a discount, the property agent applies what the owner's policy allows, holds the cottage, and the spend governor checks the total against the budget before the agent pays the deposit with the saved payment token. No redirect, no card form. The property never saw the traveller's PayPal login."

Pause on the Done card. Point at the booking id.

## 1:55 to 2:35, the owner's back office

Screen: `/owner`. Bookings tab, point at the row marked agent. Click it, scroll the drawer to PayPal objects and the timeline.

Voice: "Every booking, every PayPal object, every agent action with the exact API call behind it."

Click Needs you. Approve the pending discount or refund escalation.

Voice: "Outside policy, the human decides, and the refund executes on PayPal when they approve."

Click Advance 7 days. Toast shows balance actions and payouts. Click Money tab.

Voice: "Advance the clock: the vaulted guest's balance is captured automatically, the card guest gets a PayPal invoice with escalating reminders, and the trek guide is paid through PayPal Payouts the day the trek happens."

## 2:35 to 2:55, disputes and close

Screen: Disputes tab, Load disputes, Preview evidence pack.

Voice: "When a chargeback arrives, Innkeeper matches it to the booking and assembles the evidence pack from the transcript, policy and payments, ready to submit through the Disputes API."

Screen: README on GitHub, licence visible.

Voice: "Innkeeper. Claude for the conversation, PayPal for every dollar, code for the rules. Repo and setup in the description."

## Pre-flight checklist

- Reset demo data, then make one guest booking off camera so the Money tab has a live PayPal capture row.
- Confirm the sandbox buyer window is already logged in; the approval screen must not show a login form on camera.
- Confirm `Advance 7 days` produces at least one VAULT_CAPTURED and one INVOICE_SENT in the toast on a dry run.
- Record the traveller segment twice and keep the take where the stream is uninterrupted.
