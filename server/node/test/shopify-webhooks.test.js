"use strict";

const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");

const { startFakeSeel, startApp, post, signHmacBase64, SHOPIFY_API_SECRET, SHOP } = require("./helpers");

let seel;
let app;
let webhookCounter = 0;

before(async () => {
  seel = await startFakeSeel();
  app = await startApp(seel.url);
});

after(() => {
  app.close();
  seel.server.close();
});

beforeEach(() => {
  seel.requests.length = 0;
  seel.reply = () => ({ status: 200, body: { ok: true } });
});

const ORDER = {
  id: 5804251775208,
  name: "#1001",
  email: "shopper@example.com",
  line_items: [{ id: 13595526103128, quantity: 1, price: "24.95", title: "Ski Wax" }],
  fulfillments: [],
  note_attributes: [],
  total_price: "25.93",
};

function deliver(topic, order = ORDER, { secret = SHOPIFY_API_SECRET, webhookId } = {}) {
  const raw = JSON.stringify(order, null, 2);
  return post(`${app.url}/shopify/webhooks`, raw, {
    "X-Shopify-Hmac-Sha256": signHmacBase64(raw, secret),
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": SHOP,
    "X-Shopify-Webhook-Id": webhookId ?? `wh-${++webhookCounter}`,
  });
}

test("a bad HMAC is 401 and nothing is forwarded", async () => {
  const res = await deliver("orders/create", ORDER, { secret: "wrong-secret" });
  assert.equal(res.status, 401);
  assert.equal(seel.requests.length, 0);
});

test("orders/create posts the unchanged order to /v1/shopify/orders", async () => {
  const res = await deliver("orders/create");
  assert.equal(res.status, 200);
  assert.equal(seel.requests.length, 1);
  assert.equal(seel.requests[0].path, "/v1/shopify/orders");
  assert.deepEqual(seel.requests[0].body, { admin_domain: SHOP, order: ORDER });
});

test("orders/fulfilled posts the unchanged order to /v1/shopify/orders/:id", async () => {
  const fulfilled = { ...ORDER, fulfillment_status: "fulfilled", fulfillments: [{ id: 1, tracking_number: "1Z" }] };
  const res = await deliver("orders/fulfilled", fulfilled);
  assert.equal(res.status, 200);
  assert.equal(seel.requests.length, 1);
  assert.equal(seel.requests[0].path, `/v1/shopify/orders/${ORDER.id}`);
  assert.deepEqual(seel.requests[0].body, { admin_domain: SHOP, order: fulfilled });
});

test("orders/edited is acknowledged and not forwarded", async () => {
  const res = await deliver("orders/edited", { order_edit: { id: 1, order_id: ORDER.id } });
  assert.equal(res.status, 200);
  assert.equal(seel.requests.length, 0);
});

test("a repeated X-Shopify-Webhook-Id is forwarded once", async () => {
  const first = await deliver("orders/updated", ORDER, { webhookId: "wh-dup" });
  const second = await deliver("orders/updated", ORDER, { webhookId: "wh-dup" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(seel.requests.length, 1);
});

test("a Seel 5xx answers 500 so Shopify retries, and the retry is forwarded", async () => {
  seel.reply = () => ({ status: 503, body: { error: "unavailable" } });
  const first = await deliver("orders/paid", ORDER, { webhookId: "wh-retry" });
  assert.equal(first.status, 500);
  seel.reply = () => ({ status: 200, body: { ok: true } });
  const retry = await deliver("orders/paid", ORDER, { webhookId: "wh-retry" });
  assert.equal(retry.status, 200);
  assert.equal(seel.requests.length, 2);
});
