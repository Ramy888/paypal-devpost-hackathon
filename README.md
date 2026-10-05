# paypal-devpost-hackathon

**CollectPilot**: an AI receivables agent that gets freelancers paid through PayPal. Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

Work in progress. Current stage: sandbox spikes.

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
| `/` | Receivables dashboard. `/?synthetic=1000` adds 1,000 clearly fake rows for load testing |
| `POST /webhooks/paypal` | PayPal webhook receiver; each signature is verified with PayPal |
| `/api/stream` | Server-Sent Events feed of verified invoice events |
| `GET /events` | Last 50 verified events (needs `Authorization: Bearer $ADMIN_TOKEN`) |
| `/healthz` | Health check |

```sh
npm install
npm run dev     # http://localhost:3000
npm test        # unit tests (node:test)
```

AG Studio shows a watermark until a licence key is configured.

## Try the client's AI agent (sandbox)

1. Open `/connect`, pick a limit, and click **Continue to PayPal**.
2. Log in with the sandbox **personal** (buyer) account and approve. No money moves.
3. Copy the agent key and the MCP snippet shown on the next page.
4. Add the snippet to an MCP-capable assistant (for example Claude) and ask: "What do I owe through CollectPilot? Pay anything overdue."

Database: Postgres (`DATABASE_URL`); `npm start` applies `db/schema.sql` first.
