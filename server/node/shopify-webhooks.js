"use strict";

const { verifyHmacBase64 } = require("./hmac");
const { respond, parseJson, isPlainObject, logLine } = require("./http-util");

/**
 * Shopify webhook topic -> Seel order call.
 *
 * Only topics whose payload is a full Shopify order belong here, because
 * the payload is forwarded to Seel unchanged. orders/edited (an order_edit
 * object) and refunds/create (a refund object) are left out on purpose:
 * Shopify also fires orders/updated for edits and refunds, with the full
 * order, so those changes still reach Seel.
 */
const ORDER_TOPIC_ACTIONS = {
  "orders/create": "create",
  "orders/updated": "update",
  "orders/cancelled": "update",
  "orders/fulfilled": "update",
  "orders/partially_fulfilled": "update",
  "orders/paid": "update",
};

const SEEL_CALLS = {
  create: (seel, adminDomain, orderId, rawOrder) => seel.createOrder(adminDomain, rawOrder),
  update: (seel, adminDomain, orderId, rawOrder) => seel.updateOrder(adminDomain, orderId, rawOrder),
};

function createShopifyWebhookHandler({ seel, apiSecret, dedupe, log = logLine }) {
  return async function handleShopifyWebhook(req, res, rawBody) {
    if (!verifyHmacBase64(rawBody, req.headers["x-shopify-hmac-sha256"], apiSecret)) {
      respond(res, 401, { error: "invalid signature" });
      return;
    }
    const topic = req.headers["x-shopify-topic"] || "";
    const adminDomain = req.headers["x-shopify-shop-domain"] || "";
    const webhookId = req.headers["x-shopify-webhook-id"] || "";

    const action = ORDER_TOPIC_ACTIONS[topic];
    if (!action) {
      respond(res, 200, { ok: true, ignored: topic });
      return;
    }
    if (webhookId && (await dedupe.has(webhookId))) {
      respond(res, 200, { ok: true, duplicate: true });
      return;
    }
    const order = parseJson(rawBody);
    if (!isPlainObject(order) || order.id === undefined || !adminDomain) {
      respond(res, 400, { error: "expected an order payload and X-Shopify-Shop-Domain" });
      return;
    }

    let result;
    try {
      result = await SEEL_CALLS[action](seel, adminDomain, order.id, rawBody.toString("utf8"));
    } catch (err) {
      log({ msg: "seel order request failed", topic, admin_domain: adminDomain, order_id: order.id, error: String(err) });
      respond(res, 500, { error: "Seel did not respond" });
      return;
    }

    const logged = { topic, admin_domain: adminDomain, order_id: order.id, seel_status: result.status };
    if (result.status >= 500) {
      // Not marked as seen, so Shopify's retry forwards it again.
      log({ msg: "seel order request failed", ...logged });
      respond(res, 500, { error: "Seel returned a server error" });
      return;
    }
    if (result.status >= 400) {
      // A retry would send the same payload and get the same answer.
      log({ msg: "seel rejected order", ...logged, seel_body: result.body });
    } else if (result.body === null) {
      log({ msg: "seel returned an empty 200; the order was not recorded", ...logged });
    }
    if (webhookId) await dedupe.add(webhookId);
    respond(res, 200, { ok: true });
  };
}

module.exports = { createShopifyWebhookHandler, ORDER_TOPIC_ACTIONS };
