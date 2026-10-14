const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLadder,
  priceTableFromVariants,
  selectPriceSource,
  HIDDEN_REASONS,
} = require('../extension/seel-wfd/assets/seel-wfd-core.js');

const METAFIELD = {
  USD: { 44000000000001: 99, 44000000000002: 149 },
  EUR: { 44000000000001: 92, 44000000000002: 138 },
};

test('parses the metafield object and its JSON string form identically', () => {
  assert.deepEqual(parseLadder(METAFIELD), METAFIELD);
  assert.deepEqual(parseLadder(JSON.stringify(METAFIELD)), METAFIELD);
});

test('drops malformed currencies, variant ids and prices', () => {
  const ladder = parseLadder({
    USD: { 44000000000001: 99, abc: 10, 44000000000003: 1.5, 44000000000004: '149' },
    usd: { 1: 1 },
    GBP: {},
  });
  assert.deepEqual(ladder, { USD: { 44000000000001: 99 } });
});

test('absent or unusable ladder parses to null', () => {
  assert.equal(parseLadder(null), null);
  assert.equal(parseLadder('not json'), null);
  assert.equal(parseLadder([]), null);
  assert.equal(parseLadder({ GBP: {} }), null);
});

test('ladder entry for the cart currency is used', () => {
  assert.deepEqual(selectPriceSource(parseLadder(METAFIELD), 'EUR', true), { table: METAFIELD.EUR });
});

test('currency missing from the ladder is unsupported', () => {
  assert.deepEqual(selectPriceSource(parseLadder(METAFIELD), 'JPY', false), {
    reason: HIDDEN_REASONS.CURRENCY_NOT_SUPPORTED,
  });
});

test('no ladder falls back to storefront prices only on tax-exclusive stores', () => {
  assert.deepEqual(selectPriceSource(null, 'USD', false), { useProductPrices: true });
  assert.deepEqual(selectPriceSource(null, 'USD', true), { reason: HIDDEN_REASONS.CURRENCY_NOT_SUPPORTED });
});

test('product.js variants become a price table keyed by variant id', () => {
  assert.deepEqual(priceTableFromVariants([{ id: 44000000000001, price: 99 }, { id: 44000000000002, price: 149 }]), {
    44000000000001: 99,
    44000000000002: 149,
  });
});
