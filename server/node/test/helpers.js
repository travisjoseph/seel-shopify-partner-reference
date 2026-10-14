"use strict";

const http = require("node:http");

const { createApp, loadConfig } = require("../example-server");
const { signHmacBase64 } = require("../hmac");

const SEEL_WEBHOOK_SECRET = "test-seel-webhook-secret";
const SHOPIFY_API_SECRET = "test-shopify-api-secret";
const SHOP = "acme-demo.myshopify.com";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/**
 * A stand-in for Seel. Records every request; `reply` decides the answer
 * and can be swapped per test.
 */
async function startFakeSeel() {
  const fake = {
    requests: [],
    reply: () => ({ status: 200, body: { ok: true } }),
  };
  fake.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded = { method: req.method, path: req.url, headers: req.headers, text, body: JSON.parse(text) };
      fake.requests.push(recorded);
      const { status, body } = fake.reply(recorded);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  fake.url = await listen(fake.server);
  return fake;
}

async function startApp(seelUrl, env = {}, overrides = {}) {
  const config = loadConfig({
    SEEL_API_BASE: seelUrl,
    SEEL_API_KEY: "test-api-key",
    SEEL_WEBHOOK_SECRET,
    SEEL_SERVICE_TYPE: "acme_shopify-wfp",
    SEEL_ALLOWED_SHOPS: SHOP,
    SEEL_ALLOWED_ORIGINS: "https://acme-demo.example",
    SHOPIFY_API_SECRET,
    ...env,
  });
  const server = http.createServer(createApp(config, { log: () => {}, ...overrides }));
  const url = await listen(server);
  return {
    url,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function post(url, rawBody, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody,
  });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers, body: text ? JSON.parse(text) : null };
}

module.exports = {
  startFakeSeel,
  startApp,
  post,
  signHmacBase64,
  SEEL_WEBHOOK_SECRET,
  SHOPIFY_API_SECRET,
  SHOP,
};
