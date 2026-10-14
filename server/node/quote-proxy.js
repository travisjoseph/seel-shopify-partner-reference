"use strict";

const { respond, parseJson, isPlainObject, logLine } = require("./http-util");

/**
 * The shopper's IP as Seel needs it in customer_info.browser_ip.
 *
 * X-Forwarded-For is client-controlled unless a proxy you run overwrites
 * it, so it is read only when trustProxy is set. Its first hop is the
 * original client.
 */
function shopperIp(req, trustProxy) {
  const forwarded = req.headers["x-forwarded-for"];
  if (trustProxy && typeof forwarded === "string" && forwarded.trim() !== "") {
    return forwarded.split(",")[0].trim();
  }
  // An IPv4 client on a dual-stack socket shows up as ::ffff:a.b.c.d.
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

/** CORS for the storefront widget. Returns true when it answered a preflight. */
function handleCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204, {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  });
  res.end();
  return true;
}

/**
 * Handles the widget's POST. The widget sends
 * { type?, admin_domain, cart_info, customer_info: { user_id, referrer_url, timestamp_in_ms } }
 * and never browser_ip: this server sets it, overwriting anything the
 * client sent, because Seel prices and screens on the shopper's IP.
 */
function createQuoteProxy({ seel, allowedShops, trustProxy, serviceType, log = logLine }) {
  return async function handleQuote(req, res, rawBody) {
    const quote = parseJson(rawBody);
    if (!isPlainObject(quote)) {
      respond(res, 400, { error: "body must be a JSON object" });
      return;
    }
    const adminDomain = typeof quote.admin_domain === "string" ? quote.admin_domain.toLowerCase() : "";
    if (!allowedShops.has(adminDomain)) {
      respond(res, 403, { error: "admin_domain is not an allowed shop" });
      return;
    }
    quote.admin_domain = adminDomain;
    if (!quote.type) quote.type = serviceType;
    quote.customer_info = {
      ...(isPlainObject(quote.customer_info) ? quote.customer_info : {}),
      browser_ip: shopperIp(req, trustProxy),
    };

    let result;
    try {
      result = await seel.createQuote(quote);
    } catch (err) {
      log({ msg: "seel quote request failed", admin_domain: adminDomain, error: String(err) });
      respond(res, 502, { error: "Seel did not respond" });
      return;
    }
    respond(res, result.status, result.text);
  };
}

module.exports = { createQuoteProxy, handleCors, shopperIp };
