# Node backend

A reference backend for a partner's Shopify app that offers Seel Worry-Free Delivery (WFD). It does four jobs:

- Proxies the storefront widget's quote request to Seel and adds the shopper's IP.
- Forwards Shopify order webhooks to Seel unchanged.
- Verifies Seel webhooks and calls your refund hooks.
- Registers a shop with Seel (`scripts/create-merchant.js`).

It uses Node 18+ built-ins only. There is nothing to install.

## Run it

```sh
export SEEL_API_KEY=...            # from Seel
export SEEL_WEBHOOK_SECRET=...     # from Seel
export SEEL_SERVICE_TYPE=acme_shopify-wfp
export SEEL_ALLOWED_SHOPS=acme-demo.myshopify.com
export SHOPIFY_API_SECRET=...      # your Shopify app's API secret key
node server/node/example-server.js
curl http://127.0.0.1:8787/healthz
```

The server refuses to start when a required variable is missing. It reads `process.env` only and never loads a `.env` file. `.env.example` lists every variable.

Run the tests:

```sh
node --test server/node/test/*.test.js
```

The tests start a fake Seel API on an ephemeral port and assert what reaches it. Node 21 and later treat a bare directory argument to `--test` as a file, so pass the glob.

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SEEL_API_BASE` | No | `https://api-test.seel.com` | Seel API root. Production is `https://api.seel.com`. |
| `SEEL_API_KEY` | Yes | | Sent as `X-Seel-API-Key`. Never logged. |
| `SEEL_API_VERSION` | No | `2.3.0` | Sent as `X-Seel-Api-Version`. |
| `SEEL_WEBHOOK_SECRET` | Yes | | Verifies `X-Seel-Hmac-SHA256` on Seel webhooks. |
| `SEEL_SERVICE_TYPE` | Yes | | Quote `type` when the widget sends none, for example `acme_shopify-wfp`. |
| `SEEL_ALLOWED_SHOPS` | Yes | | Comma-separated `*.myshopify.com` domains. The quote proxy answers 403 for any other `admin_domain`. |
| `SEEL_ALLOWED_ORIGINS` | No | none | Comma-separated storefront origins allowed by CORS on the quote route. |
| `SEEL_QUOTE_PATH` | No | `/seel/quotes` | Path of the quote route. |
| `SHOPIFY_API_SECRET` | Yes | | Verifies `X-Shopify-Hmac-Sha256` on Shopify webhooks. |
| `TRUST_PROXY` | No | `0` | Set to `1` only behind a proxy you control that sets `X-Forwarded-For`. |
| `HOST` | No | `127.0.0.1` | Listen address. |
| `PORT` | No | `8787` | Listen port. |

## Routes

| Route | Caller | Behaviour |
|---|---|---|
| `POST /seel/quotes` | Storefront widget | Checks `admin_domain` against `SEEL_ALLOWED_SHOPS`, sets `customer_info.browser_ip`, defaults `type`, calls `POST /v1/shopify/quotes`, and returns Seel's status and body unchanged. |
| `OPTIONS /seel/quotes` | Browser | CORS preflight for `SEEL_ALLOWED_ORIGINS`. |
| `POST /shopify/webhooks` | Shopify | Verifies the HMAC, dedupes on `X-Shopify-Webhook-Id`, and forwards order topics to Seel. |
| `POST /seel/webhooks` | Seel | Verifies the HMAC over the raw body, dedupes on `id:type`, and calls the matching hook. |
| `GET /healthz` | Load balancer | Returns `{"ok":true}`. |

Every route rejects a body over 1 MiB with 413.

## Quote proxy

The widget sends `{type?, admin_domain, cart_info, customer_info: {user_id, referrer_url, timestamp_in_ms}}`. It never sends `browser_ip`. The proxy writes `customer_info.browser_ip` itself and overwrites any value the client sent, because Seel needs the shopper's real IP.

- With `TRUST_PROXY=1`, the IP is the first `X-Forwarded-For` hop.
- Otherwise it is the socket's remote address. Any client can forge `X-Forwarded-For`, so it is ignored unless your own proxy sets it.

`admin_domain` must be the shop's `*.myshopify.com` domain, not its storefront domain. Seel answers 404 "merchant not found" for the wrong one.

## Shopify order webhooks

Subscribe your app to the topics below and point them at `POST /shopify/webhooks`. `X-Shopify-Shop-Domain` becomes `admin_domain`.

| Shopify topic | Seel call |
|---|---|
| `orders/create` | `POST /v1/shopify/orders` |
| `orders/updated` | `POST /v1/shopify/orders/:id` |
| `orders/cancelled` | `POST /v1/shopify/orders/:id` |
| `orders/fulfilled` | `POST /v1/shopify/orders/:id` |
| `orders/partially_fulfilled` | `POST /v1/shopify/orders/:id` |
| `orders/paid` | `POST /v1/shopify/orders/:id` |

The table is `ORDER_TOPIC_ACTIONS` in `shopify-webhooks.js`. Any other topic gets 200 and is ignored.

Only topics whose payload is a full order are listed, because the payload is forwarded as Seel's `order`. Two order-related topics are left out on purpose:

- `orders/edited` carries an `order_edit` object, not an order.
- `refunds/create` carries a refund, not an order.

Shopify also fires `orders/updated` with the full order after an edit or a refund, so Seel still sees both changes.

The order is forwarded byte for byte. The server splices the raw webhook body into `{"admin_domain": ..., "order": <raw body>}`. Seel answers an empty HTTP 200 to a trimmed or reshaped order and silently drops it, so never rebuild the order from selected fields. The server logs a warning when Seel returns an empty 200.

Reply codes to Shopify:

- 200 once Seel accepts the order.
- 200 when Seel returns 4xx. A retry would send the same payload and fail the same way, so the server logs Seel's error instead.
- 500 when Seel returns 5xx or does not answer within 4 seconds. Shopify retries, and the webhook id is not marked as seen, so the retry is forwarded.

Shopify expects a reply within 5 seconds, which is why the Seel client times out at 4.

## Seel webhooks

Register `POST /seel/webhooks` with Seel. Each event is `{id, created_ts, type, data}`, signed with `X-Seel-Hmac-SHA256 = base64(HMAC-SHA256(raw body, SEEL_WEBHOOK_SECRET))`. Delivery is at least once. Seel retries any reply other than 200 within 10 seconds, with the same `id`, for up to 24 hours.

The table in `buildEventHandlers` (`seel-webhooks.js`) maps each event to a hook:

| Event | Hook |
|---|---|
| `contract.failed` | `refundWfdLine` |
| `contract.cancelled` | `refundWfdLineIfNotRefunded` |
| `contract.created`, `contract.activated`, `contract.expired` | `recordEvent` |
| `claim.created`, `claim.accepted`, `claim.rejected`, `claim.action_required` | `recordEvent` |
| `merchant.created`, `merchant.updated` | `recordEvent` |

An unknown type gets 200 and a log line.

### Hook interface

Pass your hooks to `createApp(config, { hooks })`. Each hook receives one object:

```js
{
  event,       // the full envelope: { id, created_ts, type, data }
  contractId,  // data.contract_id or null
  orderId,     // data.order_id or null
  merchantId,  // data.merchant_id or null
  reason,      // data.reason or null
}
```

The default hooks log one JSON line and do nothing else. A hook may be async. The server waits for it before replying:

- If the hook resolves, the server replies 200 and marks `id:type` as seen.
- If the hook throws, the server replies 500 and Seel redelivers the event.

Seel stops waiting after 10 seconds. A hook that may take longer must enqueue the work and return.

## What you must implement

- **Refunds.** Implement `refundWfdLine` and `refundWfdLineIfNotRefunded` with the Shopify Admin API. Refund the Worry-Free Delivery line on the order. Make both safe to run twice: check for an existing refund first.
- **Durable dedupe.** The default store keeps the last 10,000 keys in memory. It forgets them on restart and is not shared between instances. Pass a store with the same `{ has(key), add(key) }` interface to `createApp(config, { dedupe })`. Both methods may return promises, so Redis or a database table works.
- **Merchant lifecycle.**
  - On install or when a merchant turns WFD on, call `createMerchant` (see `scripts/create-merchant.js` and `examples/create-merchant.json`) and store the returned `merchant_id`.
  - Then backfill the last 30 days of orders with `batchSyncOrders(adminDomain, orders)`.
  - When a merchant turns WFD off or uninstalls, call `updateMerchant(merchantId, { seel_services: [{ type, is_enabled: false, disabled_reason, coverages }] })`.
- **Allowed shops.** Keep `SEEL_ALLOWED_SHOPS` in step with your installed shops, or replace the `Set` with a lookup against your shop table.

## Register a merchant

```sh
SEEL_API_KEY=... node server/node/scripts/create-merchant.js server/node/examples/create-merchant.json
```

The script prints the new `merchant_id` and exits 0. On any error it prints the HTTP status and Seel's body and exits 1. Replace every placeholder in the example first.

## Files

| File | Contents |
|---|---|
| `seel-client.js` | One function per Seel Shopify endpoint. Each resolves to `{status, body, text}` and does not throw on 4xx or 5xx. |
| `quote-proxy.js` | Quote route and CORS. |
| `shopify-webhooks.js` | Shopify webhook verification and the topic table. |
| `seel-webhooks.js` | Seel webhook verification, the event table, and the default hooks. |
| `dedupe-store.js` | In-memory dedupe store. |
| `hmac.js` | Constant-time base64 HMAC-SHA256 check shared by both webhook routes. |
| `example-server.js` | Configuration, routing, and the 1 MiB body limit. |
