# paypal-devpost-hackathon

**CollectPilot**: an AI receivables agent that gets freelancers paid through PayPal. Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

CollectPilot is one freelancer's own collections assistant, connected to their own PayPal account. Clients pay the freelancer directly through PayPal; CollectPilot never holds the money. It turns a voice note into a PayPal invoice, keeps a live receivables dashboard, chases politely, and lets a client's own AI agent pay its invoices over MCP within a limit the client sets.

Live demo (PayPal sandbox): https://collectpilot-webhooks.onrender.com. Judges' sign-in details are in the Devpost testing instructions. Demo video: https://youtu.be/CRf65zAV12Q

**Built with:** PayPal Invoicing v2, Subscriptions, Vault and Orders v2 (through the PayPal Server SDK), PayPal webhooks · Claude (Anthropic) · AG Studio (AG Grid) with its AI module · APIMatic Context Plugin for PayPal · MCP · Next.js, React, TypeScript, Postgres, Render.

**Roadmap:** many freelancers, each with their own PayPal, through PayPal partner onboarding. The demo uses a US sandbox seller, since an Egypt sandbox account can't receive payments.

## Try it (sandbox)

1. Sign in at `/login` with the freelancer passcode.
2. **Receivables** (`/`): the live AG Studio dashboard. Ask the AI Assistant "Which clients are at risk?".
3. **New invoice**: type or speak the job; Claude drafts the PayPal invoice and checks it before it's sent.
4. **Connect a client agent**: open `/connect`, set a limit, approve with the sandbox buyer, and add the MCP snippet to an MCP-capable assistant (for example Claude). Ask it "What do I owe through CollectPilot? Pay anything overdue." The dashboard updates live from PayPal's webhook.
5. **Schedules**, **Retainers** and **Digest**: milestones with "Not done yet" holds, monthly PayPal Subscriptions, and what the agent collected.

## Run it yourself

You need a PayPal sandbox REST app (with Invoicing and Vault enabled), a sandbox personal (buyer) account, an Anthropic API key and Postgres.

```sh
npm install
cp .env.example .env   # fill in PayPal sandbox, Anthropic, DATABASE_URL, SESSION_SECRET, FREELANCER_PASSCODE
npm run dev            # http://localhost:3000; webhooks need a public URL (WEBHOOK_URL)
node --env-file=.env scripts/demo-reset.mjs   # dry run; --apply hides test invoices and zeroes counters
```

## Spike 1: PayPal money path (Postman / Newman)

```sh
npm install
cp .env.example .env   # fill in PayPal sandbox credentials
npm run spike1:send    # create, send and remind an invoice; prints the buyer pay link
npm run spike1:paid -- invoice_id=INV2-XXXX   # after paying as the sandbox buyer
npm run spike1:webhooks                       # needs WEBHOOK_URL
```

The collection is in `postman/` and can also be imported into the Postman app.

## App

A Next.js app (`app/`) with an AG Studio receivables dashboard. PayPal webhooks update it live through Server-Sent Events.

| Route | Purpose |
|---|---|
| `/connect` | Client page: connect your AI agent to pay invoices (PayPal approval, agent key shown once, revoke) |
| `/mcp` | MCP server for the client's AI agent: `what_do_i_owe`, `pay_invoice` (`Authorization: Bearer <agent key>`) |
| `/` | Receivables dashboard: cash-panel tiles, risk and expected pay date per invoice. `/?synthetic=1000` adds 1,000 clearly fake rows for load testing |
| `/schedules` | Payment schedules: a job split into milestones (one PayPal invoice each) or chunks (one invoice paid in parts). Holds and new dates |
| `/pay/<link>` | Client page for a schedule: approve the dates once, turn on auto-pay, mark a part "Not done yet", approve a new date |
| `/digest` | Payback digest: money collected by clients' agents and after reminders, recurring revenue created, against the $12 plan |
| `POST /webhooks/paypal` | PayPal webhook receiver; each signature is verified with PayPal |
| `/api/stream` | Server-Sent Events feed of verified invoice events |
| `GET /events` | Last 50 verified events (needs `Authorization: Bearer $ADMIN_TOKEN`) |
| `/healthz` | Health check |

```sh
npm install
npm run dev     # http://localhost:3000
npm test        # unit tests (node:test)
```

AG Studio shows a watermark until `NEXT_PUBLIC_AG_STUDIO_LICENSE` holds a licence key (it is inlined into the client bundle at build time).

### Payment schedules and auto-pay

The freelancer picks **In full**, **Milestones** or **Chunks** when reviewing an invoice and dates each part upfront. The client approves the schedule once at `/pay/<link>` and can turn on auto-pay. That approval uses a PayPal vault setup token with a per-charge limit of the largest part. The 10-minute agent tick (`lib/server/schedules.ts`, on the demo clock) then:

- sends each milestone's PayPal invoice 3 days before its date (chunks get one invoice with `partial_payment` allowed, minimum = smallest part);
- charges each due part once with the client's saved PayPal token through the Server SDK, recording every attempt in `autopay_charges`;
- skips any part the client marked "Not done yet". The freelancer proposes a new date, and it applies only after the client approves it. Reminders skip held parts too.

A failed or over-limit charge is shown to both sides and never retried blindly. Normal reminders take over. The logic is in `lib/schedules.mjs` (pure) and `lib/scheduleOps.mjs`.

### PayPal APIs and SDKs

- **Agent payments use the official [PayPal Server SDK](https://github.com/paypal/PayPal-TypeScript-Server-SDK)** (`@paypal/paypal-server-sdk`, generated by APIMatic): `lib/paypalOrders.mjs` builds the `OrdersController`, and `payInvoice` in `lib/agentPay.mjs` creates and captures the order with the client's vaulted PayPal token. We wrote that integration in Claude Code with the **[APIMatic Context Plugin for PayPal](https://github.com/paypaldev/server-sdk-context-plugin-preview)** (`npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`), whose TypeScript skills grounded the client setup, auth, error handling and the transport stub used in `test/agentPay.test.mjs`.
- Invoicing, Subscriptions, Vault setup tokens and webhooks use PayPal's REST APIs directly (`lib/paypal.mjs`); the Server SDK has no Invoicing controller.

## Try the client's AI agent (sandbox)

1. Open `/connect`, pick a limit, and click **Continue to PayPal**.
2. Log in with the sandbox **personal** (buyer) account and approve. No money moves.
3. Copy the agent key and the MCP snippet shown on the next page.
4. Add the snippet to an MCP-capable assistant (for example Claude) and ask: "What do I owe through CollectPilot? Pay anything overdue."

Database: Postgres (`DATABASE_URL`); `npm start` applies `db/schema.sql` first.
