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
