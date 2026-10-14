"use strict";

/**
 * Client for Seel's Shopify API (/v1/shopify/*), one function per endpoint.
 *
 * Every function resolves to { status, body, text }: the HTTP status, the
 * parsed JSON body (null when empty, the raw text when not JSON), and the
 * raw response text. It does not throw on 4xx or 5xx, so callers decide
 * what each status means. It rejects only when the request never got a
 * response (network error or timeout).
 *
 * Node 18+ built-ins only (global fetch).
 */

const SANDBOX_BASE_URL = "https://api-test.seel.com";
const PRODUCTION_BASE_URL = "https://api.seel.com";
const DEFAULT_API_VERSION = "2.3.0";
// Below Shopify's 5 second webhook deadline, so a slow Seel call turns into
// a 500 that Shopify retries rather than a Shopify-side timeout.
const DEFAULT_TIMEOUT_MS = 4000;

function pathParam(value) {
  return encodeURIComponent(String(value));
}

/**
 * A Shopify order passed as a string is spliced into the request verbatim.
 * That is the safest way to forward a webhook body: Seel silently drops a
 * trimmed or reshaped order, and a JSON.parse round trip is the easiest way
 * to reshape one by accident.
 */
function orderJson(order) {
  return typeof order === "string" ? order : JSON.stringify(order);
}

function createSeelClient({
  baseUrl = SANDBOX_BASE_URL,
  apiKey,
  apiVersion = DEFAULT_API_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) throw new Error("createSeelClient: apiKey is required");
  const root = baseUrl.replace(/\/+$/, "");

  async function post(path, payload) {
    const response = await fetch(`${root}${path}`, {
      method: "POST",
      headers: {
        "X-Seel-API-Key": apiKey,
        "X-Seel-Api-Version": apiVersion,
        "Content-Type": "application/json",
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, text };
  }

  const adminDomainField = (adminDomain) => `{"admin_domain":${JSON.stringify(adminDomain)}`;

  return {
    createQuote(quote) {
      return post("/v1/shopify/quotes", JSON.stringify(quote));
    },
    createMerchant(merchant) {
      return post("/v1/shopify/merchants", JSON.stringify(merchant));
    },
    updateMerchant(merchantId, changes) {
      return post(`/v1/shopify/merchants/${pathParam(merchantId)}`, JSON.stringify(changes));
    },
    createOrder(adminDomain, order) {
      return post("/v1/shopify/orders", `${adminDomainField(adminDomain)},"order":${orderJson(order)}}`);
    },
    updateOrder(adminDomain, shopifyOrderId, order) {
      return post(
        `/v1/shopify/orders/${pathParam(shopifyOrderId)}`,
        `${adminDomainField(adminDomain)},"order":${orderJson(order)}}`
      );
    },
    batchSyncOrders(adminDomain, orders) {
      return post(
        "/v1/shopify/orders/batch",
        `${adminDomainField(adminDomain)},"orders":[${orders.map(orderJson).join(",")}]}`
      );
    },
  };
}

module.exports = {
  createSeelClient,
  SANDBOX_BASE_URL,
  PRODUCTION_BASE_URL,
  DEFAULT_API_VERSION,
};
