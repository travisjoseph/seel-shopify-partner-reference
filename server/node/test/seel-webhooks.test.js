"use strict";

const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");

const { startFakeSeel, startApp, post, signHmacBase64, SEEL_WEBHOOK_SECRET } = require("./helpers");

let seel;
let app;
const calls = [];

const hooks = {
  refundWfdLine: (input) => calls.push(["refundWfdLine", input]),
  refundWfdLineIfNotRefunded: (input) => calls.push(["refundWfdLineIfNotRefunded", input]),
  recordEvent: (input) => calls.push(["recordEvent", input]),
};

before(async () => {
  seel = await startFakeSeel();
  app = await startApp(seel.url, {}, { hooks });
});

after(() => {
  app.close();
  seel.server.close();
});

beforeEach(() => {
  calls.length = 0;
});

function event(id, type) {
  return {
    id,
    created_ts: "1686049398000",
    type,
    data: { merchant_id: "m-1", contract_id: "c-1", order_id: "o-1", status: "cancelled" },
  };
}

function deliver(raw, secret = SEEL_WEBHOOK_SECRET) {
  return post(`${app.url}/seel/webhooks`, raw, { "X-Seel-Hmac-SHA256": signHmacBase64(raw, secret) });
}

test("a bad signature is 401 and no hook runs", async () => {
  const res = await deliver(JSON.stringify(event("e-bad", "contract.failed")), "wrong-secret");
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

test("contract.failed calls refundWfdLine once when delivered twice", async () => {
  const raw = JSON.stringify(event("e-failed", "contract.failed"));
  assert.equal((await deliver(raw)).status, 200);
  assert.equal((await deliver(raw)).status, 200);
  assert.equal(calls.length, 1);
  const [name, input] = calls[0];
  assert.equal(name, "refundWfdLine");
  assert.deepEqual(
    { contractId: input.contractId, orderId: input.orderId, merchantId: input.merchantId, type: input.event.type },
    { contractId: "c-1", orderId: "o-1", merchantId: "m-1", type: "contract.failed" }
  );
});

test("contract.cancelled calls refundWfdLineIfNotRefunded once when delivered twice", async () => {
  const raw = JSON.stringify(event("e-cancelled", "contract.cancelled"));
  await deliver(raw);
  await deliver(raw);
  assert.deepEqual(calls.map(([name]) => name), ["refundWfdLineIfNotRefunded"]);
});

test("the same id with a different type is a different event", async () => {
  await deliver(JSON.stringify(event("e-shared", "contract.created")));
  await deliver(JSON.stringify(event("e-shared", "contract.cancelled")));
  assert.deepEqual(calls.map(([name]) => name), ["recordEvent", "refundWfdLineIfNotRefunded"]);
});

test("the signature is checked over the raw bytes, so extra whitespace still verifies", async () => {
  const raw = `{\n   "id" :  "e-spaced",\n  "type":"contract.failed",  "created_ts":"1",\n "data": {"contract_id":"c-1"}\n}\n`;
  const res = await deliver(raw);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map(([name]) => name), ["refundWfdLine"]);
});

test("a hook that throws answers 500 and the redelivery runs it again", async () => {
  let failures = 1;
  const flaky = {
    ...hooks,
    refundWfdLine: (input) => {
      if (failures-- > 0) throw new Error("shopify admin api down");
      calls.push(["refundWfdLine", input]);
    },
  };
  const flakyApp = await startApp(seel.url, {}, { hooks: flaky });
  try {
    const raw = JSON.stringify(event("e-flaky", "contract.failed"));
    const sign = { "X-Seel-Hmac-SHA256": signHmacBase64(raw, SEEL_WEBHOOK_SECRET) };
    assert.equal((await post(`${flakyApp.url}/seel/webhooks`, raw, sign)).status, 500);
    assert.equal((await post(`${flakyApp.url}/seel/webhooks`, raw, sign)).status, 200);
    assert.equal(calls.length, 1);
  } finally {
    flakyApp.close();
  }
});
