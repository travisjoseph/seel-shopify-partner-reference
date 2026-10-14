"use strict";

/**
 * Example partner backend for Seel Worry-Free Delivery in a Shopify app.
 *
 *   POST /seel/quotes       storefront widget -> Seel quote (path: SEEL_QUOTE_PATH)
 *   POST /shopify/webhooks  Shopify order webhooks -> Seel orders
 *   POST /seel/webhooks     Seel contract/claim/merchant events -> partner hooks
 *   GET  /healthz
 *
 * Configuration comes from process.env only. Nothing loads a .env file.
 */

const http = require("node:http");

const { createSeelClient, SANDBOX_BASE_URL, DEFAULT_API_VERSION } = require("./seel-client");
const { createMemoryDedupeStore } = require("./dedupe-store");
const { createQuoteProxy, handleCors } = require("./quote-proxy");
const { createShopifyWebhookHandler } = require("./shopify-webhooks");
const { createSeelWebhookHandler, createDefaultHooks } = require("./seel-webhooks");
const { respond, logLine } = require("./http-util");

const MAX_BODY_BYTES = 1024 * 1024;

const REQUIRED_ENV = [
  "SEEL_API_KEY",
  "SEEL_WEBHOOK_SECRET",
  "SEEL_SERVICE_TYPE",
  "SEEL_ALLOWED_SHOPS",
  "SHOPIFY_API_SECRET",
];

function csv(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Reads and checks configuration. Throws, listing every missing variable. */
function loadConfig(env) {
  const missing = REQUIRED_ENV.filter((name) => !(env[name] || "").trim());
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(", ")}`);
  }
  const allowedShops = csv(env.SEEL_ALLOWED_SHOPS).map((s) => s.toLowerCase());
  if (allowedShops.length === 0) throw new Error("SEEL_ALLOWED_SHOPS lists no shops");
  return {
    seelApiBase: env.SEEL_API_BASE || SANDBOX_BASE_URL,
    seelApiKey: env.SEEL_API_KEY,
    seelApiVersion: env.SEEL_API_VERSION || DEFAULT_API_VERSION,
    seelWebhookSecret: env.SEEL_WEBHOOK_SECRET,
    serviceType: env.SEEL_SERVICE_TYPE,
    allowedShops: new Set(allowedShops),
    allowedOrigins: new Set(csv(env.SEEL_ALLOWED_ORIGINS)),
    shopifyApiSecret: env.SHOPIFY_API_SECRET,
    trustProxy: env.TRUST_PROXY === "1",
    quotePath: env.SEEL_QUOTE_PATH || "/seel/quotes",
    host: env.HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT || "8787", 10),
  };
}

/**
 * Reads the body, or answers 413 and resolves null once it passes the cap.
 * Content-Length is checked up front; the running count catches a chunked
 * body, which declares no length.
 */
function readBody(req, res) {
  const tooLarge = () => {
    res.setHeader("Connection", "close");
    respond(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
  };
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    tooLarge();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on("data", (chunk) => {
      if (received > MAX_BODY_BYTES) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        tooLarge();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Builds the request handler. `hooks`, `dedupe`, `seel` and `log` default
 * to the reference implementations; a partner passes their own.
 */
function createApp(config, overrides = {}) {
  const log = overrides.log || logLine;
  const seel =
    overrides.seel ||
    createSeelClient({ baseUrl: config.seelApiBase, apiKey: config.seelApiKey, apiVersion: config.seelApiVersion });
  const dedupe = overrides.dedupe || createMemoryDedupeStore();
  const hooks = overrides.hooks || createDefaultHooks(log);

  const routes = {
    [`POST ${config.quotePath}`]: createQuoteProxy({
      seel,
      allowedShops: config.allowedShops,
      trustProxy: config.trustProxy,
      serviceType: config.serviceType,
      log,
    }),
    "POST /shopify/webhooks": createShopifyWebhookHandler({ seel, apiSecret: config.shopifyApiSecret, dedupe, log }),
    "POST /seel/webhooks": createSeelWebhookHandler({ webhookSecret: config.seelWebhookSecret, hooks, dedupe, log }),
  };

  async function handleRequest(req, res) {
    const path = req.url.split("?")[0];
    if (path === config.quotePath && handleCors(req, res, config.allowedOrigins)) return;
    if (req.method === "GET" && path === "/healthz") {
      respond(res, 200, { ok: true });
      return;
    }
    const route = routes[`${req.method} ${path}`];
    if (!route) {
      respond(res, 404, { error: "not found" });
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return;
    await route(req, res, body);
  }

  return (req, res) => {
    handleRequest(req, res).catch((err) => {
      log({ msg: "unhandled error", path: req.url, error: String(err) });
      if (!res.headersSent) respond(res, 500, { error: "internal server error" });
    });
  };
}

if (require.main === module) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const server = http.createServer(createApp(config));
  server.listen(config.port, config.host, () => {
    const { address, port } = server.address();
    logLine({ msg: "listening", url: `http://${address}:${port}`, seel_api_base: config.seelApiBase });
  });
}

module.exports = { createApp, loadConfig, MAX_BODY_BYTES };
