"use strict";

const crypto = require("node:crypto");

/**
 * True when `signatureB64` equals base64(HMAC-SHA256(rawBody, secret)).
 *
 * Shopify (X-Shopify-Hmac-Sha256) and Seel (X-Seel-Hmac-SHA256) both sign
 * this way. Always pass the raw request bytes: re-serializing parsed JSON
 * changes whitespace and key order, and the signature no longer matches.
 */
function verifyHmacBase64(rawBody, signatureB64, secret) {
  // An empty secret is a valid HMAC key, so an unconfigured server would
  // otherwise accept anything signed with "".
  if (!secret || typeof signatureB64 !== "string" || signatureB64 === "") return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signatureB64, "base64");
  // timingSafeEqual throws on a length mismatch, and the length of an
  // HMAC-SHA256 digest is public anyway.
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function signHmacBase64(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

module.exports = { verifyHmacBase64, signHmacBase64 };
