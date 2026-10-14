#!/usr/bin/env node
"use strict";

/**
 * Registers a Shopify shop with Seel and prints its merchant_id.
 *
 *   SEEL_API_KEY=... node server/node/scripts/create-merchant.js server/node/examples/create-merchant.json
 *
 * Reads SEEL_API_BASE (default sandbox), SEEL_API_KEY and SEEL_API_VERSION.
 */

const fs = require("node:fs");

const { createSeelClient, SANDBOX_BASE_URL, DEFAULT_API_VERSION } = require("../seel-client");

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: create-merchant.js <merchant.json>");
    return 2;
  }
  if (!process.env.SEEL_API_KEY) {
    console.error("SEEL_API_KEY is not set");
    return 2;
  }
  const merchant = JSON.parse(fs.readFileSync(file, "utf8"));
  const seel = createSeelClient({
    baseUrl: process.env.SEEL_API_BASE || SANDBOX_BASE_URL,
    apiKey: process.env.SEEL_API_KEY,
    apiVersion: process.env.SEEL_API_VERSION || DEFAULT_API_VERSION,
    timeoutMs: 15000,
  });
  const { status, body, text } = await seel.createMerchant(merchant);
  if (status < 200 || status >= 300 || !body || !body.merchant_id) {
    console.error(`create merchant failed: HTTP ${status} ${text}`);
    return 1;
  }
  console.log(body.merchant_id);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
