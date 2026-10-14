"use strict";

const { verifyHmacBase64 } = require("./hmac");
const { respond, parseJson, isPlainObject, logLine } = require("./http-util");

/**
 * Default hooks. Each logs one structured line and does nothing else.
 *
 * The partner replaces refundWfdLine and refundWfdLineIfNotRefunded with
 * code that refunds the Worry-Free Delivery line through the Shopify Admin
 * API. Seel delivers at least once, so both must be safe to run twice.
 */
function createDefaultHooks(log = logLine) {
  const logOnly = (hook) => (input) => log({ msg: "seel webhook hook", hook, ...input });
  return {
    refundWfdLine: logOnly("refundWfdLine"),
    refundWfdLineIfNotRefunded: logOnly("refundWfdLineIfNotRefunded"),
    recordEvent: logOnly("recordEvent"),
  };
}

/**
 * Seel event type -> hook. Every event Seel sends is listed so an
 * unexpected type stands out in the log instead of passing silently.
 */
function buildEventHandlers(hooks) {
  return {
    "contract.failed": hooks.refundWfdLine,
    "contract.cancelled": hooks.refundWfdLineIfNotRefunded,
    "contract.created": hooks.recordEvent,
    "contract.activated": hooks.recordEvent,
    "contract.expired": hooks.recordEvent,
    "claim.created": hooks.recordEvent,
    "claim.accepted": hooks.recordEvent,
    "claim.rejected": hooks.recordEvent,
    "claim.action_required": hooks.recordEvent,
    "merchant.created": hooks.recordEvent,
    "merchant.updated": hooks.recordEvent,
  };
}

function hookInput(event) {
  const data = isPlainObject(event.data) ? event.data : {};
  return {
    event,
    contractId: data.contract_id ?? null,
    orderId: data.order_id ?? null,
    merchantId: data.merchant_id ?? null,
    reason: data.reason ?? null,
  };
}

/**
 * Seel retries anything not answered 200 within 10 seconds. The hook runs
 * before the reply, so a hook that throws gets a 500 and Seel redelivers.
 * A hook that may take longer than a few seconds must enqueue its work and
 * return.
 */
function createSeelWebhookHandler({ webhookSecret, hooks, dedupe, log = logLine }) {
  const handlers = buildEventHandlers(hooks);
  return async function handleSeelWebhook(req, res, rawBody) {
    if (!verifyHmacBase64(rawBody, req.headers["x-seel-hmac-sha256"], webhookSecret)) {
      respond(res, 401, { error: "invalid signature" });
      return;
    }
    const event = parseJson(rawBody);
    if (!isPlainObject(event) || !event.id || !event.type) {
      respond(res, 400, { error: "expected an event envelope with id and type" });
      return;
    }
    const handler = handlers[event.type];
    if (!handler) {
      log({ msg: "seel webhook type not handled", id: event.id, type: event.type });
      respond(res, 200, { ok: true, ignored: event.type });
      return;
    }
    const key = `${event.id}:${event.type}`;
    if (await dedupe.has(key)) {
      respond(res, 200, { ok: true, duplicate: true });
      return;
    }
    try {
      await handler(hookInput(event));
    } catch (err) {
      log({ msg: "seel webhook hook failed", id: event.id, type: event.type, error: String(err) });
      respond(res, 500, { error: "hook failed" });
      return;
    }
    await dedupe.add(key);
    respond(res, 200, { ok: true });
  };
}

module.exports = { createSeelWebhookHandler, createDefaultHooks, buildEventHandlers };
