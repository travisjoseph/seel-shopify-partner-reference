"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");

const { startFakeSeel, startApp, post, SHOP } = require("./helpers");

let seel;
let app;
let trustingApp;

before(async () => {
  seel = await startFakeSeel();
  app = await startApp(seel.url);
  trustingApp = await startApp(seel.url, { TRUST_PROXY: "1" });
});

after(() => {
  app.close();
  trustingApp.close();
  seel.server.close();
});

beforeEach(() => {
  seel.requests.length = 0;
  seel.reply = () => ({ status: 200, body: { quote_id: "q-1", status: "accepted", price: "0.98" } });
});

function widgetQuote(customerInfo = {}) {
  return JSON.stringify({
    admin_domain: SHOP,
    cart_info: { total_price: 2495, items: [{ id: 1, quantity: 1 }] },
    customer_info: { user_id: "u-1", referrer_url: "https://example.com/", timestamp_in_ms: 1, ...customerInfo },
  });
}

test("overwrites a client-supplied browser_ip with the socket address", async () => {
  const res = await post(`${app.url}/seel/quotes`, widgetQuote({ browser_ip: "6.6.6.6" }));
  assert.equal(res.status, 200);
  assert.equal(seel.requests.length, 1);
  assert.equal(seel.requests[0].body.customer_info.browser_ip, "127.0.0.1");
  assert.equal(seel.requests[0].body.customer_info.user_id, "u-1");
});

test("ignores X-Forwarded-For when TRUST_PROXY is not 1", async () => {
  await post(`${app.url}/seel/quotes`, widgetQuote(), { "X-Forwarded-For": "203.0.113.9" });
  assert.equal(seel.requests[0].body.customer_info.browser_ip, "127.0.0.1");
});

test("uses the first X-Forwarded-For hop when TRUST_PROXY=1", async () => {
  await post(`${trustingApp.url}/seel/quotes`, widgetQuote({ browser_ip: "6.6.6.6" }), {
    "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
  });
  assert.equal(seel.requests[0].body.customer_info.browser_ip, "203.0.113.9");
});

test("rejects a shop not in SEEL_ALLOWED_SHOPS with 403 and never calls Seel", async () => {
  const body = JSON.stringify({ admin_domain: "other.myshopify.com", cart_info: {}, customer_info: {} });
  const res = await post(`${app.url}/seel/quotes`, body);
  assert.equal(res.status, 403);
  assert.equal(seel.requests.length, 0);
});

test("sends the Seel headers and defaults type to SEEL_SERVICE_TYPE", async () => {
  await post(`${app.url}/seel/quotes`, widgetQuote());
  const [request] = seel.requests;
  assert.equal(request.path, "/v1/shopify/quotes");
  assert.equal(request.headers["x-seel-api-key"], "test-api-key");
  assert.equal(request.headers["x-seel-api-version"], "2.3.0");
  assert.equal(request.body.type, "acme_shopify-wfp");
  assert.equal(request.body.admin_domain, SHOP);
});

test("passes Seel's status and body through unchanged", async () => {
  seel.reply = () => ({ status: 422, body: { error: "cart_info.items is empty", trace_id: "t-9" } });
  const res = await post(`${app.url}/seel/quotes`, widgetQuote());
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: "cart_info.items is empty", trace_id: "t-9" });
});

test("answers the CORS preflight for an allowed origin only", async () => {
  const allowed = await fetch(`${app.url}/seel/quotes`, {
    method: "OPTIONS",
    headers: { Origin: "https://acme-demo.example" },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://acme-demo.example");

  const other = await fetch(`${app.url}/seel/quotes`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

/**
 * The server answers 413 and closes while the client may still be writing,
 * so fetch can fail with ECONNRESET. Read the response event instead and
 * ignore the write error that follows it.
 */
function oversizedRequest(url, { declareLength }) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (declareLength) headers["Content-Length"] = String(1024 * 1024 + 1);
    const req = http.request(url, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => {});
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("no response"));
    });
    if (declareLength) req.flushHeaders();
    else req.write("x".repeat(1024 * 1024 + 1));
  });
}

test("answers 413 from Content-Length alone, before reading the body", async () => {
  assert.equal(await oversizedRequest(`${app.url}/seel/quotes`, { declareLength: true }), 413);
  assert.equal(seel.requests.length, 0);
});

test("answers 413 for a chunked body that passes 1 MiB", async () => {
  assert.equal(await oversizedRequest(`${app.url}/seel/quotes`, { declareLength: false }), 413);
  assert.equal(seel.requests.length, 0);
});
